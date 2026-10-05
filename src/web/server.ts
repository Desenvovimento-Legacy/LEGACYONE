import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Pool } from "pg";
import { config } from "../config.js";
import { SERPRO_PROVIDER, serproFromVault, serproMetering } from "../integrations/integra-contador/from-vault.js";
import type { IntegraContador } from "../integrations/integra-contador/types.js";
import { COMPETENCE_CALLS, FederalAccessDeniedError, syncCompetence } from "../modules/federal/federal-sync.js";
import { competenceDetail, pgdasDeadline } from "../modules/federal/report.js";
import { billedCallsToday, DailyLimitExceededError, type MeteringPolicy } from "../platform/metering/metering.js";
import type { Actor } from "../shared/actor.js";
import { formatCnpj } from "../shared/br/documents.js";
import { createPool } from "../shared/db/pool.js";
import { withTenant } from "../shared/db/tenant-tx.js";
import { isMain } from "../shared/is-main.js";
import { openSecretsFile } from "../shared/secrets/secrets-file.js";
import { PAGE_HTML } from "./page.js";

/**
 * Tela local do IARIS (piloto). Escuta só em 127.0.0.1.
 *
 * Regra de custo: abrir a tela, trocar de competência ou de empresa só lê o
 * banco. A única rota que consulta o SERPRO é POST .../buscar, disparada pelo
 * botão Buscar, que exige confirmação e respeita o teto diário.
 * Proteção contra outro site disparar consultas: a rota exige o cabeçalho
 * X-IARIS-Acao (força preflight de CORS, que este servidor nunca libera) e
 * Origin igual ao da própria tela.
 */

export interface WebDeps {
  appPool: Pool;
  tenantId: string;
  officeName: string;
  integra: IntegraContador | null;
  metering: MeteringPolicy;
  port: number;
}

const USER: Actor = { kind: "USER", id: process.env.USERNAME ?? process.env.USER ?? "tela-local" };

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function isCompetence(s: string | undefined): s is string {
  return Boolean(s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s));
}

function sameOrigin(req: IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

async function listEntities(deps: WebDeps, competence: string) {
  return withTenant(deps.appPool, deps.tenantId, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      legal_name: string;
      trade_name: string | null;
      cnpj: string;
      poa_valid_to: string | null;
      declarations: number;
      das: number;
      das_paid: number;
      das_paid_total: string | null;
      das_paid_on: string | null;
      other_count: number;
      other_total: string | null;
      last_fetch: Date | null;
    }>(
      `SELECT e.id, e.legal_name, e.trade_name, e.cnpj,
              (SELECT max(coalesce(valid_to, 'infinity'::date))::text FROM power_of_attorney p
                WHERE p.entity_id = e.id AND p.system = 'ECAC') AS poa_valid_to,
              (SELECT count(*)::int FROM pgdas_declaration d WHERE d.entity_id = e.id AND d.competence = $1) AS declarations,
              (SELECT count(*)::int FROM pgdas_das s WHERE s.entity_id = e.id AND s.competence = $1) AS das,
              (SELECT count(*)::int FROM pgdas_das s JOIN federal_payment f
                  ON f.entity_id = s.entity_id AND ltrim(f.document_number, '0') = ltrim(s.das_number, '0')
                WHERE s.entity_id = e.id AND s.competence = $1) AS das_paid,
              (SELECT sum(f.amount_total)::text FROM pgdas_das s JOIN federal_payment f
                  ON f.entity_id = s.entity_id AND ltrim(f.document_number, '0') = ltrim(s.das_number, '0')
                WHERE s.entity_id = e.id AND s.competence = $1) AS das_paid_total,
              (SELECT max(f.collected_on)::text FROM pgdas_das s JOIN federal_payment f
                  ON f.entity_id = s.entity_id AND ltrim(f.document_number, '0') = ltrim(s.das_number, '0')
                WHERE s.entity_id = e.id AND s.competence = $1) AS das_paid_on,
              (SELECT count(*)::int FROM federal_payment f
                WHERE f.entity_id = e.id AND f.competence = $1
                  AND NOT EXISTS (SELECT 1 FROM pgdas_das s WHERE s.entity_id = f.entity_id
                                   AND ltrim(s.das_number, '0') = ltrim(f.document_number, '0'))) AS other_count,
              (SELECT sum(f.amount_total)::text FROM federal_payment f
                WHERE f.entity_id = e.id AND f.competence = $1
                  AND NOT EXISTS (SELECT 1 FROM pgdas_das s WHERE s.entity_id = f.entity_id
                                   AND ltrim(s.das_number, '0') = ltrim(f.document_number, '0'))) AS other_total,
              (SELECT max(occurred_at) FROM audit_log a
                WHERE a.action = 'federal.pgdas_synced' AND a.entity_id = e.id
                  AND (a.competence = $1 OR (a.competence IS NULL AND a.data->>'year' = to_char($1::date, 'YYYY'))))
                AS last_fetch
         FROM entity e
        WHERE e.cnpj IS NOT NULL
        ORDER BY e.legal_name`,
      [competence],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.trade_name || r.legal_name,
      legalName: r.legal_name,
      cnpj: formatCnpj(r.cnpj),
      poaValidTo: r.poa_valid_to,
      declarations: r.declarations,
      das: r.das,
      dasPaid: r.das_paid,
      dasPaidTotal: r.das_paid_total,
      dasPaidOn: r.das_paid_on,
      otherCount: r.other_count,
      otherTotal: r.other_total,
      lastFetchedAt: r.last_fetch ? r.last_fetch.toISOString() : null,
    }));
  });
}

export function createWebServer(deps: WebDeps) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${deps.port}`);
      const parts = url.pathname.split("/").filter(Boolean);

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'",
          "x-frame-options": "DENY",
        });
        res.end(PAGE_HTML);
        return;
      }

      // GET /api/competencia/AAAA-MM — só banco.
      if (req.method === "GET" && parts[0] === "api" && parts[1] === "competencia" && isCompetence(parts[2]) && !parts[3]) {
        const competence = `${parts[2]}-01`;
        const used = await billedCallsToday(deps.appPool, deps.tenantId, deps.metering.provider);
        json(res, 200, {
          office: deps.officeName,
          integraConfigured: Boolean(deps.integra),
          competence,
          pgdasDeadline: pgdasDeadline(competence),
          callsPerSearch: COMPETENCE_CALLS,
          billedToday: used,
          dailyLimit: deps.metering.dailyLimit,
          entities: await listEntities(deps, competence),
        });
        return;
      }

      // GET /api/empresa/:id/competencia/AAAA-MM — só banco.
      if (req.method === "GET" && parts[0] === "api" && parts[1] === "empresa" && parts[3] === "competencia" && isCompetence(parts[4])) {
        const detail = await withTenant(deps.appPool, deps.tenantId, (tx) => competenceDetail(tx, parts[2]!, `${parts[4]}-01`));
        json(res, 200, detail);
        return;
      }

      // POST /api/empresa/:id/competencia/AAAA-MM/buscar — ÚNICA rota que consulta o SERPRO.
      if (
        req.method === "POST" &&
        parts[0] === "api" &&
        parts[1] === "empresa" &&
        parts[3] === "competencia" &&
        isCompetence(parts[4]) &&
        parts[5] === "buscar"
      ) {
        if (req.headers["x-iaris-acao"] !== "buscar" || !sameOrigin(req, deps.port)) {
          json(res, 403, { erro: "Requisição recusada" });
          return;
        }
        if (!deps.integra) {
          json(res, 409, { erro: "Integra Contador não configurado: confira o cofre (pnpm integra:check)" });
          return;
        }
        try {
          const r = await syncCompetence(
            { appPool: deps.appPool, integra: deps.integra, metering: deps.metering },
            deps.tenantId,
            { entityId: parts[2]!, competence: `${parts[4]}-01` },
            USER,
          );
          const detail = await withTenant(deps.appPool, deps.tenantId, (tx) => competenceDetail(tx, parts[2]!, `${parts[4]}-01`));
          json(res, 200, { calls: r.calls, detail });
        } catch (err) {
          if (err instanceof DailyLimitExceededError) json(res, 429, { erro: err.message });
          else if (err instanceof FederalAccessDeniedError) json(res, 403, { erro: err.message });
          else json(res, 502, { erro: (err as Error).message });
        }
        return;
      }

      json(res, 404, { erro: "Não encontrado" });
    } catch (err) {
      json(res, 500, { erro: (err as Error).message });
    }
  });
}

if (isMain(import.meta.url)) {
  const port = Number(process.env.IARIS_WEB_PORT ?? 3100);
  const slug = process.env.LEGACY_TENANT ?? "contabilidade-legacy";
  const admin = createPool(config.adminDatabaseUrl(), 1);
  const app = createPool(config.databaseUrl(), 4);
  const t = await admin.query<{ id: string; name: string }>("SELECT id, name FROM tenant WHERE slug = $1", [slug]);
  await admin.end();
  const tenant = t.rows[0];
  if (!tenant) {
    console.error(`Escritório ${slug} não existe`);
    process.exit(1);
  }
  const vault = openSecretsFile();
  const deps: WebDeps = {
    appPool: app,
    tenantId: tenant.id,
    officeName: tenant.name,
    integra: vault ? serproFromVault(vault) : null,
    metering: vault ? serproMetering(vault) : { provider: SERPRO_PROVIDER, dailyLimit: 0 },
    port,
  };
  createWebServer(deps).listen(port, "127.0.0.1", () => {
    console.log(`IARIS aberto em http://127.0.0.1:${port}  (Ctrl+C para fechar)`);
    console.log(`Teto de consultas cobradas por dia: ${deps.metering.dailyLimit}. Abrir a tela não consulta o SERPRO.`);
  });
}
