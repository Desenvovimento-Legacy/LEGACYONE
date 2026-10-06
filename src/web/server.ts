import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Pool } from "pg";
import { config } from "../config.js";
import { SERPRO_PROVIDER, serproFromVault, serproMetering } from "../integrations/integra-contador/from-vault.js";
import type { IntegraContador } from "../integrations/integra-contador/types.js";
import { COMPETENCE_CALLS, FederalAccessDeniedError, syncCompetence } from "../modules/federal/federal-sync.js";
import { competenceDetail, pgdasDeadline } from "../modules/federal/report.js";
import { billedCallsToday, DailyLimitExceededError, type MeteringPolicy } from "../platform/metering/metering.js";
import { formatCnpj } from "../shared/br/documents.js";
import { createPool } from "../shared/db/pool.js";
import { withTenant } from "../shared/db/tenant-tx.js";
import { isMain } from "../shared/is-main.js";
import { openSecretsFile } from "../shared/secrets/secrets-file.js";
import { approveCase, approveRules, defineContractedServices, HumanActionError } from "../modules/onboarding/complete.js";
import QRCode from "qrcode";
import { ZodError } from "zod";
import {
  AccessError,
  acceptInvitation,
  login,
  logout,
  openInvitation,
  ROLE_LABEL,
  sessionFromToken,
  SESSION_HOURS,
  userActor,
  type AccessDeps,
  type Permission,
  type SessionUser,
} from "../platform/access/access.js";
import { parseAuthKey } from "../platform/access/crypto.js";
import { AUTH_HTML } from "./auth-page.js";
import { casesList, centralData, entitiesList, entityDetail, rulesList } from "./ops.js";
import { PAGE_HTML } from "./page.js";

/**
 * Tela do AIRES. Escuta só em 127.0.0.1; acesso de fora passa por um túnel
 * (AIRES_PUBLIC_ORIGIN) e sempre exige login com senha + autenticador.
 *
 * Acesso: toda rota de dados exige sessão; cada ação exige a permissão do
 * perfil (Leitura só vê; Operador busca e confirma; Responsável técnico aprova).
 * Cabeçalho Host conferido (contra DNS rebinding); cookie HttpOnly e
 * SameSite=Strict.
 *
 * Regra de custo: abrir a tela, trocar de competência ou de empresa só lê o
 * banco. A única rota que consulta o SERPRO é POST .../buscar, disparada pelo
 * botão Buscar, que exige confirmação e respeita o teto diário.
 * Proteção contra outro site disparar consultas: a rota exige o cabeçalho
 * X-AIRES-Acao (força preflight de CORS, que este servidor nunca libera) e
 * Origin igual ao da própria tela.
 */

export interface WebDeps {
  appPool: Pool;
  tenantId: string;
  officeName: string;
  integra: IntegraContador | null;
  metering: MeteringPolicy;
  port: number;
  /** AIRES_AUTH_KEY do cofre. */
  authKey: Buffer;
  /** Endereço público do túnel, ex.: https://aires.exemplo.com.br. Nulo = só nesta máquina. */
  publicOrigin?: string | null;
  now?: () => Date;
}

const COOKIE = "aires_sessao";
const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function html(res: ServerResponse, body: string) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
  res.end(body);
}

function cookieToken(req: IncomingMessage): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=") || null;
  }
  return null;
}

function localOrigins(req: IncomingMessage): string[] {
  const p = req.socket.localPort;
  return [`http://127.0.0.1:${p}`, `http://localhost:${p}`];
}

function publicHost(deps: WebDeps): string | null {
  return deps.publicOrigin ? new URL(deps.publicOrigin).host : null;
}

function hostAllowed(req: IncomingMessage, deps: WebDeps): boolean {
  const host = req.headers.host ?? "";
  return localOrigins(req).some((o) => o.endsWith("//" + host)) || host === publicHost(deps);
}

function isLoopback(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** IP de quem acessa. Atrás do túnel (conexão local) vale o cabeçalho do túnel. */
function clientIp(req: IncomingMessage): string | null {
  const remote = req.socket.remoteAddress;
  if (isLoopback(remote)) {
    const fwd = req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return remote ?? null;
}

function sessionCookie(req: IncomingMessage, deps: WebDeps, token: string, maxAge: number): string {
  const secure = Boolean(deps.publicOrigin?.startsWith("https:") && req.headers.host === publicHost(deps));
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function isCompetence(s: string | undefined): s is string {
  return Boolean(s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new HumanActionError("Requisição grande demais");
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

/** Toda ação (POST) exige o cabeçalho da própria tela e a mesma origem. */
function actionAllowed(req: IncomingMessage, deps: WebDeps, action: string): boolean {
  return req.headers["x-aires-acao"] === action && sameOrigin(req, deps);
}

function sameOrigin(req: IncomingMessage, deps: WebDeps): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  return localOrigins(req).includes(origin) || origin === deps.publicOrigin;
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
  const access: AccessDeps = { appPool: deps.appPool, tenantId: deps.tenantId, authKey: deps.authKey, now: deps.now };

  return createServer(async (req, res) => {
    try {
      if (!hostAllowed(req, deps)) return json(res, 421, { erro: "Endereço não permitido" });
      const url = new URL(req.url ?? "/", "http://aires.local");
      const parts = url.pathname.split("/").filter(Boolean);
      const meta = { ip: clientIp(req), userAgent: req.headers["user-agent"] ?? null };

      // ------------------------------------------------------------ sem sessão
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/convite")) {
        const user = url.pathname === "/" ? await sessionFromToken(access, cookieToken(req)) : null;
        return html(res, user ? PAGE_HTML : AUTH_HTML);
      }
      if (req.method === "POST" && url.pathname === "/api/login") {
        if (!actionAllowed(req, deps, "login")) return json(res, 403, { erro: "Requisição recusada" });
        try {
          const body = (await readJson(req)) as { email?: string; password?: string; code?: string };
          const r = await login(access, { email: body.email ?? "", password: body.password ?? "", code: body.code ?? "" }, meta);
          res.setHeader("set-cookie", sessionCookie(req, deps, r.token, SESSION_HOURS * 3600));
          return json(res, 200, { ok: true, name: r.user.name, role: r.user.role });
        } catch (err) {
          if (err instanceof AccessError) return json(res, 401, { erro: err.message });
          throw err;
        }
      }
      if (req.method === "POST" && (url.pathname === "/api/convite/abrir" || url.pathname === "/api/convite/ativar")) {
        if (!actionAllowed(req, deps, "convite")) return json(res, 403, { erro: "Requisição recusada" });
        try {
          const body = (await readJson(req)) as { token?: string; password?: string; code?: string };
          if (url.pathname.endsWith("/abrir")) {
            const inv = await openInvitation(access, body.token ?? "");
            const qrSvg = await QRCode.toString(inv.otpauthUri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
            return json(res, 200, { name: inv.name, email: inv.email, roleLabel: inv.roleLabel, expiresAt: inv.expiresAt, secretBase32: inv.secretBase32, qrSvg });
          }
          await acceptInvitation(access, { token: body.token ?? "", password: body.password ?? "", code: body.code ?? "" });
          return json(res, 200, { ok: true });
        } catch (err) {
          if (err instanceof AccessError) return json(res, 400, { erro: err.message });
          throw err;
        }
      }

      // ------------------------------------------------------------ com sessão
      const user = await sessionFromToken(access, cookieToken(req));
      if (!user) return json(res, 401, { erro: "Sessão encerrada. Entre de novo.", login: true });
      const actor = userActor(user);
      const denied = (perm: Permission) => {
        if (user.permissions.includes(perm)) return false;
        json(res, 403, { erro: `Seu perfil (${ROLE_LABEL[user.role]}) não permite esta ação` });
        return true;
      };

      if (req.method === "GET" && url.pathname === "/api/sessao") {
        return json(res, 200, { name: user.name, email: user.email, role: user.role, roleLabel: ROLE_LABEL[user.role], permissions: user.permissions });
      }
      if (req.method === "POST" && url.pathname === "/api/sair") {
        if (!actionAllowed(req, deps, "sair")) return json(res, 403, { erro: "Requisição recusada" });
        await logout(access, user);
        res.setHeader("set-cookie", sessionCookie(req, deps, "", 0));
        return json(res, 200, { ok: true });
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
        if (!actionAllowed(req, deps, "buscar")) {
          json(res, 403, { erro: "Requisição recusada" });
          return;
        }
        if (denied("buscar")) return;
        if (!deps.integra) {
          json(res, 409, { erro: "Integra Contador não configurado: confira o cofre (pnpm integra:check)" });
          return;
        }
        try {
          const r = await syncCompetence(
            { appPool: deps.appPool, integra: deps.integra, metering: deps.metering },
            deps.tenantId,
            { entityId: parts[2]!, competence: `${parts[4]}-01` },
            actor,
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

      // ---------------------------------------------------------------- Operação (só banco)
      if (req.method === "GET" && url.pathname === "/api/central") {
        const data = await withTenant(deps.appPool, deps.tenantId, (tx) => centralData(tx));
        const used = await billedCallsToday(deps.appPool, deps.tenantId, deps.metering.provider);
        json(res, 200, { office: deps.officeName, billedToday: used, dailyLimit: deps.metering.dailyLimit, ...data });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/cases") {
        json(res, 200, { cases: await withTenant(deps.appPool, deps.tenantId, (tx) => casesList(tx)) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/empresas") {
        json(res, 200, { entities: await withTenant(deps.appPool, deps.tenantId, (tx) => entitiesList(tx)) });
        return;
      }
      if (req.method === "GET" && parts[0] === "api" && parts[1] === "empresa" && parts[2] && !parts[3]) {
        const d = await withTenant(deps.appPool, deps.tenantId, (tx) => entityDetail(tx, parts[2]!));
        if (!d) return json(res, 404, { erro: "Empresa não encontrada" });
        json(res, 200, d);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/regras") {
        json(res, 200, { rules: await withTenant(deps.appPool, deps.tenantId, (tx) => rulesList(tx)) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/regras/aprovar") {
        if (!actionAllowed(req, deps, "aprovar")) return json(res, 403, { erro: "Requisição recusada" });
        if (denied("aprovar")) return;
        try {
          json(res, 200, await approveRules(deps.appPool, deps.tenantId, actor));
        } catch (err) {
          if (err instanceof HumanActionError) json(res, 409, { erro: err.message });
          else throw err;
        }
        return;
      }

      // POST /api/pendencia/:id/servicos — decisão humana: serviços e início da responsabilidade
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "pendencia" && parts[3] === "servicos") {
        if (!actionAllowed(req, deps, "confirmar")) return json(res, 403, { erro: "Requisição recusada" });
        if (denied("confirmar")) return;
        try {
          const body = (await readJson(req)) as { services?: string[]; startDate?: string };
          const r = await defineContractedServices(
            deps.appPool,
            deps.tenantId,
            { pendingItemId: parts[2]!, services: body.services as never, startDate: body.startDate ?? "" },
            actor,
          );
          json(res, 200, r);
        } catch (err) {
          if (err instanceof HumanActionError) json(res, 409, { erro: err.message });
          else if (err instanceof ZodError) json(res, 400, { erro: err.issues.map((i) => i.message).join("; ") });
          else throw err;
        }
        return;
      }

      // POST /api/case/:id/aprovar — aprovação humana da conclusão
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "case" && parts[3] === "aprovar") {
        if (!actionAllowed(req, deps, "aprovar")) return json(res, 403, { erro: "Requisição recusada" });
        if (denied("aprovar")) return;
        try {
          json(res, 200, { status: await approveCase(deps.appPool, deps.tenantId, parts[2]!, actor) });
        } catch (err) {
          if (err instanceof HumanActionError) json(res, 409, { erro: err.message });
          else throw err;
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
  const port = Number(process.env.AIRES_WEB_PORT ?? 3100);
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
  if (!vault?.has("AIRES_AUTH_KEY")) {
    console.error("Falta a chave de login no cofre. Rode uma vez: pnpm auth:init");
    process.exit(1);
  }
  const publicOrigin = process.env.AIRES_PUBLIC_ORIGIN?.replace(/\/+$/, "") || null;
  const deps: WebDeps = {
    appPool: app,
    tenantId: tenant.id,
    officeName: tenant.name,
    integra: vault ? serproFromVault(vault) : null,
    metering: vault ? serproMetering(vault) : { provider: SERPRO_PROVIDER, dailyLimit: 0 },
    port,
    authKey: parseAuthKey(vault.require("AIRES_AUTH_KEY")),
    publicOrigin,
  };
  createWebServer(deps).listen(port, "127.0.0.1", () => {
    console.log(`AIRES aberto em http://127.0.0.1:${port}  (Ctrl+C para fechar)`);
    if (publicOrigin) console.log(`Acesso externo pelo túnel: ${publicOrigin}`);
    console.log(`Teto de consultas cobradas por dia: ${deps.metering.dailyLimit}. Abrir a tela não consulta o SERPRO.`);
  });
}
