import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Pool } from "pg";
import { config } from "../config.js";
import type { Actor } from "../shared/actor.js";
import { SERPRO_PROVIDER, serproFromVault, serproMetering } from "../integrations/integra-contador/from-vault.js";
import type { IntegraContador } from "../integrations/integra-contador/types.js";
import { COMPETENCE_CALLS, FederalAccessDeniedError, syncCompetence } from "../modules/federal/federal-sync.js";
import { competenceDetail, pgdasDeadline } from "../modules/federal/report.js";
import { fetchLastDeclaration, reparseDeclarations, revenueCrossCheck } from "../modules/federal/declared-revenue.js";
import { PGDAS_PDF_PARSER } from "../integrations/integra-contador/pgdas-pdf.js";
import { decideRevenueException, refreshRevenueExceptions } from "../modules/federal/revenue-exceptions.js";
import { guidesOverview, refreshGuides } from "../modules/tax/guides.js";
import { readEntityNfseTaxes, refreshWithholdings, takenNotes, withholdingsOverview } from "../modules/fiscal/withholdings.js";
import { LINKS } from "../modules/orchestration/links.js";
import { DEFAULT_NOTE_SLOTS, dueSlot, lastRuns, nextSlot, parseSlots, recordRun } from "../platform/scheduler/daily-slots.js";
import { applyStandardChart, LedgerError, trialBalance } from "../modules/ledger/ledger.js";
import { balanceSheet, incomeStatement, ledgerDetail, openItems } from "../modules/ledger/reports.js";
import { addAlias, PartnerError, partnerRegistry, syncPartners } from "../modules/ledger/partners.js";
import { PowerError, refreshPowerRequirements, registerPower } from "../modules/onboarding/powers.js";
import {
  approveAccountingRule, approveTakenServicesRule, classifyMovement, classifySupplier, pendingMovements, pendingTaken, REVENUE_RETENTIONS_RULE, revenueRetentionsPending,
  ruleStatus, runAutoPosting, takenRuleStatus,
} from "../modules/ledger/auto-posting.js";
import { closeMonth, closingStatus, reopenMonth } from "../modules/ledger/closing.js";
import { serviceProposal } from "../modules/ledger/service-accounts.js";
import { chartConfig } from "../modules/ledger/chart-config.js";
import { activeTemplate, importChartTemplate } from "../modules/ledger/chart-template.js";
import { bankOverview, importBankStatement, StatementError } from "../modules/financial/bank-statements.js";
import { runOrchestrator } from "../platform/orchestrator/orchestrator.js";
import { approveSimplesRules, refreshSimples, SimplesActionError, simplesOverview, simplesRulesList } from "../modules/tax/simples/apuracao.js";
import { billedCallsToday, DailyLimitExceededError, type MeteringPolicy } from "../platform/metering/metering.js";
import { formatCnpj, isValidCnpj, normalizeCnpj } from "../shared/br/documents.js";
import { BrasilApiCnpjSource } from "../integrations/cnpj-public/brasilapi.js";
import { CnpjaOpenSource } from "../integrations/cnpj-public/cnpja.js";
import { FallbackCnpjSource } from "../integrations/cnpj-public/fallback.js";
import type { CnpjPublicDataSource } from "../integrations/cnpj-public/types.js";
import { onboardByCnpj } from "../modules/onboarding/onboarding.js";
import { createPool } from "../shared/db/pool.js";
import { withTenant } from "../shared/db/tenant-tx.js";
import { isMain } from "../shared/is-main.js";
import { openSecretsFile, type SecretStore } from "../shared/secrets/secrets-file.js";
import { clientCertificatesDir, clientPasswordKey, loadClientCertificate, syncClientCertificates } from "../platform/identity/client-certificates.js";
import { CteDistribution, SefazDistribution } from "../integrations/sefaz/dist-dfe.js";
import { fiscalXmlList, ingestFiles, rereadUnrecognized, scanInbox } from "../modules/documents/xml-intake.js";
import { dirname, join } from "node:path";
import { setStartingNsu, syncAllDfe, syncEntityDfe, type DfeSyncDeps } from "../modules/documents/dfe-sync.js";
import { approveCiencia, dfeStatus, documentsList } from "../modules/documents/documents.js";
import { AdnDistribution } from "../integrations/nfse/adn.js";
import { nfseList, nfseStatus, syncAllNfse, syncEntityNfse, type NfseSyncDeps } from "../modules/documents/nfse-sync.js";
import { approveCase, approveRules, defineContractedServices, HumanActionError } from "../modules/onboarding/complete.js";
import QRCode from "qrcode";
import { ZodError } from "zod";
import {
  AccessError,
  acceptInvitation,
  changeRole,
  createAccessLink,
  inviteUser,
  loginWithLink,
  listUsers,
  login,
  logout,
  openInvitation,
  revokeUserGuarded,
  Role,
  ROLE_LABEL,
  sessionFromToken,
  SESSION_HOURS,
  TRUST_DAYS,
  deviceTrusted,
  forgetDevice,
  userActor,
  type AccessDeps,
  type Permission,
} from "../platform/access/access.js";
import { parseAuthKey } from "../platform/access/crypto.js";
import { AUTH_HTML } from "./auth-page.js";
import { casesList, centralData, departmentsData, entitiesList, entityDetail, linksData, rulesList } from "./ops.js";
import { PAGE_HTML } from "./page.js";

/**
 * Tela da IARIS. Escuta só em 127.0.0.1; acesso de fora, quando houver, passa
 * por um túnel (IARIS_PUBLIC_ORIGIN) e sempre exige login.
 *
 * Acesso: toda rota de dados exige sessão (senha + autenticador de 2 etapas);
 * cada ação exige a permissão do perfil (Leitura só vê; Operador busca e
 * confirma; Responsável técnico aprova). Cabeçalho Host conferido (contra DNS
 * rebinding); cookie HttpOnly e SameSite=Strict.
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
  /** Cofre local (certificados dos clientes). Nulo = sem cofre. */
  vault?: SecretStore | null;
  /** Busca de NF-e na SEFAZ. Nulo = sem cofre/certificados. */
  dfe?: DfeSyncDeps | null;
  /** Busca de NFS-e no ADN (Sistema Nacional). */
  nfse?: NfseSyncDeps | null;
  /** IARIS_AUTH_KEY do cofre: cifra o segredo do autenticador de cada pessoa. */
  authKey: Buffer;
  /** Pasta de entrada de XML (ex.: C:\\IARIS\\entrada). Nulo = sem pasta. */
  inbox?: string | null;
  /** Orquestrador: roda os vínculos entre agentes (ex.: depois de uma ação na tela). */
  orchestrate?: () => Promise<unknown>;
  /** Busca de notas (NF-e, CT-e, NFS-e) para todas as empresas; horários fixos ou pedido de pessoa. */
  searchNotes?: (actor: Actor) => Promise<{ nfe: number; cte: number; nfse: number; waiting: number }>;
  noteSlots?: string[];
  /** Consulta pública de CNPJ (inclusão de empresa). Nulo = BrasilAPI com CNPJá de reserva. */
  publicData?: CnpjPublicDataSource;
  /** Endereço público do túnel, ex.: https://iaris.exemplo.com.br. Nulo = só nesta máquina. */
  publicOrigin?: string | null;
  now?: () => Date;
}

const COOKIE = "iaris_sessao";
const ENTRAR_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IARIS</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1720;color:#e6edf3;display:grid;place-items:center;min-height:100vh;margin:0}div{max-width:420px;padding:24px;text-align:center}b{color:#E8A33D}</style></head>
<body><div><b>IARIS</b><p id="m">Entrando…</p></div><script>
var t = (location.hash.match(/t=([A-Za-z0-9_-]+)/) || [])[1] || "";
history.replaceState(null, "", "/entrar");
if (!t) document.getElementById("m").textContent = "Link incompleto. Abra o link exatamente como recebeu.";
else fetch("/api/entrar", { method: "POST", headers: { "X-IARIS-Acao": "entrar", "content-type": "application/json" }, body: JSON.stringify({ token: t }) })
  .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.erro || "Não foi possível entrar"); location.replace("/"); }); })
  .catch(function (e) { document.getElementById("m").textContent = e.message; });
</script></body></html>`;

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/** Permissão exigida por ação da tela (cabeçalho X-IARIS-Acao). */
const ACTION_PERMISSION: Record<string, Permission> = {
  buscar: "buscar",
  "buscar-notas": "buscar",
  confirmar: "confirmar",
  conferir: "confirmar",
  aprovar: "aprovar",
  usuarios: "usuarios",
};

function html(res: ServerResponse, body: string) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
  res.end(body);
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || null;
  }
  return null;
}
function cookieToken(req: IncomingMessage): string | null {
  return cookieValue(req, COOKIE);
}
const DEVICE_COOKIE = "iaris_dispositivo";

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

function sessionCookie(req: IncomingMessage, deps: WebDeps, token: string, maxAge: number, name = COOKIE): string {
  const secure = Boolean(deps.publicOrigin?.startsWith("https:") && req.headers.host === publicHost(deps));
  return `${name}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function isCompetence(s: string | undefined): s is string {
  return Boolean(s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s));
}

async function readJson(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) throw new HumanActionError("Requisição grande demais");
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

/** Toda ação (POST) exige o cabeçalho da própria tela e a mesma origem. */
function actionAllowed(req: IncomingMessage, deps: WebDeps, action: string): boolean {
  return req.headers["x-iaris-acao"] === action && sameOrigin(req, deps);
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
      const url = new URL(req.url ?? "/", "http://iaris.local");
      const parts = url.pathname.split("/").filter(Boolean);
      const meta = { ip: clientIp(req), userAgent: req.headers["user-agent"] ?? null };

      // ------------------------------------------------------------ sem sessão
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/convite")) {
        const user = url.pathname === "/" ? await sessionFromToken(access, cookieToken(req)) : null;
        return html(res, user ? PAGE_HTML : AUTH_HTML);
      }
      // Computador confiável? (a tela de entrada esconde o código). Não diz de quem é.
      if (req.method === "GET" && url.pathname === "/api/login/dispositivo") {
        return json(res, 200, { confiavel: await deviceTrusted(access, cookieValue(req, DEVICE_COOKIE)) });
      }
      if (req.method === "POST" && url.pathname === "/api/login/esquecer") {
        if (!actionAllowed(req, deps, "login")) return json(res, 403, { erro: "Requisição recusada" });
        await forgetDevice(access, cookieValue(req, DEVICE_COOKIE));
        res.setHeader("set-cookie", sessionCookie(req, deps, "x", 0, DEVICE_COOKIE));
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/login") {
        if (!actionAllowed(req, deps, "login")) return json(res, 403, { erro: "Requisição recusada" });
        try {
          const body = (await readJson(req)) as { email?: string; password?: string; code?: string; confiar?: boolean };
          const r = await login(
            access,
            { email: body.email ?? "", password: body.password ?? "", code: body.code ?? "", trust: body.confiar === true, deviceToken: cookieValue(req, DEVICE_COOKIE) },
            meta,
          );
          const cookies = [sessionCookie(req, deps, r.token, SESSION_HOURS * 3600)];
          if (r.deviceToken) cookies.push(sessionCookie(req, deps, r.deviceToken, TRUST_DAYS * 86_400, DEVICE_COOKIE));
          res.setHeader("set-cookie", cookies);
          return json(res, 200, { ok: true, name: r.user.name, role: r.user.role });
        } catch (err) {
          if (err instanceof AccessError) return json(res, 401, { erro: err.message });
          throw err;
        }
      }
      // Link pessoal de acesso: /entrar#t=… (o token fica no fragmento: não vai para log de servidor nem de túnel).
      if (req.method === "GET" && url.pathname === "/entrar") return html(res, ENTRAR_HTML);
      if (req.method === "POST" && url.pathname === "/api/entrar") {
        if (!actionAllowed(req, deps, "entrar")) return json(res, 403, { erro: "Requisição recusada" });
        try {
          const body = (await readJson(req, 1024)) as { token?: string };
          const r = await loginWithLink(access, String(body.token ?? ""), meta);
          res.setHeader("set-cookie", sessionCookie(req, deps, r.token, SESSION_HOURS * 3600));
          return json(res, 200, { ok: true, name: r.user.name });
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
      /** true = já respondeu (ação recusada ou perfil sem permissão). */
      const guard = (action: string): boolean => {
        if (!actionAllowed(req, deps, action)) {
          json(res, 403, { erro: "Requisição recusada" });
          return true;
        }
        const perm = ACTION_PERMISSION[action];
        if (perm && user.permissions.includes(perm)) return false;
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
        if (guard("buscar")) return;
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
          await deps.orchestrate?.();
          const detail = await withTenant(deps.appPool, deps.tenantId, (tx) => competenceDetail(tx, parts[2]!, `${parts[4]}-01`));
          json(res, 200, { calls: r.calls, detail });
        } catch (err) {
          if (err instanceof DailyLimitExceededError) json(res, 429, { erro: err.message });
          else if (err instanceof FederalAccessDeniedError) json(res, 403, { erro: err.message });
          else json(res, 502, { erro: (err as Error).message });
        }
        return;
      }

      // POST /api/empresa/:id/competencia/AAAA-MM/declaracao — 1 consulta cobrada (última declaração do PA).
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "empresa" && parts[3] === "competencia" && isCompetence(parts[4]) && parts[5] === "declaracao") {
        if (guard("buscar")) return;
        if (!deps.integra) return json(res, 409, { erro: "Integra Contador não configurado" });
        try {
          const r = await fetchLastDeclaration({ appPool: deps.appPool, integra: deps.integra, metering: deps.metering }, deps.tenantId, { entityId: parts[2]!, competence: `${parts[4]}-01` }, actor);
          // Próximo passo automático: conferência vira exceção (ou fecha a que passou a bater).
          // Próximos passos pelos vínculos: conferência, Simples e guias.
          const chain = await deps.orchestrate?.();
          json(res, 200, { ...r, chain });
        } catch (err) {
          if (err instanceof DailyLimitExceededError) json(res, 429, { erro: err.message });
          else if (err instanceof FederalAccessDeniedError) json(res, 403, { erro: err.message });
          else json(res, 502, { erro: (err as Error).message });
        }
        return;
      }
      // POST /api/excecao/:caseId/decidir — decisão humana: RETIFICAR ou MANTER (com justificativa).
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "excecao" && parts[3] === "decidir") {
        if (guard("aprovar")) return;
        try {
          const body = (await readJson(req)) as { decision?: string; note?: string };
          if (body.decision !== "RETIFICAR" && body.decision !== "MANTER" && body.decision !== "ADIAR") return json(res, 400, { erro: "Decisão inválida" });
          json(res, 200, await decideRevenueException(deps.appPool, deps.tenantId, parts[2]!, { decision: body.decision, note: body.note ?? null }, actor));
        } catch (err) {
          json(res, 409, { erro: (err as Error).message });
        }
        return;
      }
      // GET /api/empresa/:id/conferencia — receita declarada × NFS-e prestadas (só banco).
      if (req.method === "GET" && parts[0] === "api" && parts[1] === "empresa" && parts[3] === "conferencia") {
        json(res, 200, { rows: await withTenant(deps.appPool, deps.tenantId, (tx) => revenueCrossCheck(tx, parts[2]!)) });
        return;
      }

      // ---------------------------------------------------------------- Usuários (só Responsável técnico)
      if (url.pathname === "/api/usuarios" && req.method === "GET") {
        if (!user.permissions.includes("usuarios")) return json(res, 403, { erro: `Seu perfil (${ROLE_LABEL[user.role]}) não administra usuários` });
        const users = await listUsers(access);
        return json(res, 200, {
          me: user.email,
          publicOrigin: deps.publicOrigin ?? null,
          users: users.map((u) => ({
            email: u.email,
            name: u.name,
            role: u.role,
            roleLabel: u.role ? ROLE_LABEL[u.role] : null,
            status: !u.active ? "REVOGADO" : u.enrolled ? "ATIVO" : u.link_expires ? "LINK" : u.invite_expires ? "CONVITE_PENDENTE" : "CONVITE_VENCIDO",
            linkExpires: u.link_expires ? u.link_expires.toISOString() : null,
            linkUsed: u.link_used ? u.link_used.toISOString() : null,
            inviteExpires: u.invite_expires ? u.invite_expires.toISOString() : null,
            lastLogin: u.last_login ? u.last_login.toISOString() : null,
          })),
        });
      }
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "usuarios" && ["convidar", "perfil", "revogar", "link"].includes(parts[2] ?? "")) {
        if (guard("usuarios")) return;
        try {
          const body = (await readJson(req)) as { email?: string; name?: string; role?: string; reason?: string };
          if (parts[2] === "convidar") {
            const role = Role.parse(body.role);
            const r = await inviteUser(access, { email: body.email ?? "", name: body.name ?? "", role }, actor);
            // Com endereço público ligado, o convite sempre usa ele (abre no computador da pessoa).
            const origin = deps.publicOrigin ?? `http://${req.headers.host}`;
            // O link só volta nesta resposta (o banco guarda o hash do token).
            return json(res, 200, { created: r.created, expiresAt: r.expiresAt.toISOString(), link: `${origin}/convite#t=${r.token}` });
          }
          if (parts[2] === "link") {
            const r = await createAccessLink(access, { email: body.email ?? "", name: body.name ?? "", role: Role.parse(body.role) }, actor);
            const origin = deps.publicOrigin ?? `http://${req.headers.host}`;
            // O link só volta nesta resposta (o banco guarda o hash do token).
            return json(res, 200, { created: r.created, expiresAt: r.expiresAt.toISOString(), link: `${origin}/entrar#t=${r.token}` });
          }
          if (parts[2] === "perfil") return json(res, 200, await changeRole(access, body.email ?? "", Role.parse(body.role), actor));
          return json(res, 200, await revokeUserGuarded(access, body.email ?? "", (body.reason ?? "").trim() || "revogado pelo escritório", actor));
        } catch (err) {
          if (err instanceof AccessError) return json(res, 409, { erro: err.message });
          if (err instanceof ZodError) return json(res, 400, { erro: err.issues.map((i) => i.message).join("; ") });
          throw err;
        }
      }

      // GET /api/vinculos — vínculos entre agentes e últimas reações (só banco).
      if (req.method === "GET" && url.pathname === "/api/vinculos") {
        json(res, 200, await withTenant(deps.appPool, deps.tenantId, (tx) => linksData(tx)));
        return;
      }
      // GET /api/empresa/:id/guias — DAS por competência: prazo e pagamento (só banco).
      if (req.method === "GET" && parts[0] === "api" && parts[1] === "empresa" && parts[3] === "guias") {
        const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
        json(res, 200, await withTenant(deps.appPool, deps.tenantId, (tx) => guidesOverview(tx, parts[2]!, today)));
        return;
      }
      // GET /api/empresa/:id/retencoes[?competencia=AAAA-MM] — retenções das NFS-e tomadas × DARF (só banco).
      if (req.method === "GET" && parts[0] === "api" && parts[1] === "empresa" && parts[3] === "retencoes") {
        const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
        const comp = url.searchParams.get("competencia");
        if (comp !== null) {
          if (!/^\d{4}-\d{2}$/.test(comp)) return json(res, 400, { erro: "Competência inválida (AAAA-MM)" });
          json(res, 200, { notes: await withTenant(deps.appPool, deps.tenantId, (tx) => takenNotes(tx, parts[2]!, `${comp}-01`)) });
          return;
        }
        json(res, 200, await withTenant(deps.appPool, deps.tenantId, (tx) => withholdingsOverview(tx, parts[2]!, today)));
        return;
      }
      // GET /api/empresa/:id/parceiros?mes=AAAA-MM — cadastro de fornecedores e clientes com o perfil do mês.
      if (req.method === "GET" && parts[0] === "api" && parts[1] === "empresa" && parts[3] === "parceiros" && !parts[4]) {
        const mes = url.searchParams.get("mes") ?? new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }).slice(0, 7);
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) return json(res, 400, { erro: "Mês inválido (AAAA-MM)" });
        json(res, 200, await withTenant(deps.appPool, deps.tenantId, async (tx) => {
          await syncPartners(tx, parts[2]!);
          return partnerRegistry(tx, parts[2]!, mes);
        }));
        return;
      }
      // POST /api/empresa/:id/parceiros/:pid/apelido — "no banco este parceiro aparece como …".
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "empresa" && parts[3] === "parceiros" && parts[5] === "apelido") {
        if (guard("confirmar")) return;
        const body = (await readJson(req, 4096)) as { texto?: string };
        try {
          const pattern = await withTenant(deps.appPool, deps.tenantId, (tx) => addAlias(tx, parts[2]!, parts[4]!, String(body.texto ?? ""), actor));
          const r = await runAutoPosting(deps.appPool, deps.tenantId, parts[2]!);
          json(res, 200, { pattern, posted: r.posted });
        } catch (err) {
          if (err instanceof PartnerError) json(res, 400, { erro: err.message });
          else throw err;
        }
        return;
      }
      // GET /api/empresa/:id/contabil/razao?conta=&de=&ate=[&parceiro=] — razão da conta com saldo acumulado e parceiro.
      // GET /api/empresa/:id/contabil/dre?mes=AAAA-MM — DRE do mês e acumulado no ano.
      // GET /api/empresa/:id/contabil/abertos?conta=2.1.1.01|1.1.2.01&ate= — saldo em aberto por fornecedor/cliente.
      if (req.method === "GET" && parts[0] === "api" && parts[1] === "empresa" && parts[3] === "contabil" && parts[4]) {
        const id = parts[2]!;
        const isDate = (v: string | null): v is string => v !== null && /^\d{4}-\d{2}-\d{2}$/.test(v);
        const isAcc = (v: string | null): v is string => v !== null && /^\d+(\.\d+)*$/.test(v);
        if (parts[4] === "razao") {
          const conta = url.searchParams.get("conta");
          const de = url.searchParams.get("de");
          const ate = url.searchParams.get("ate");
          const parceiro = url.searchParams.get("parceiro") || null;
          if (!isAcc(conta) || !isDate(de) || !isDate(ate)) return json(res, 400, { erro: "Informe conta, de e ate (AAAA-MM-DD)" });
          const r = await withTenant(deps.appPool, deps.tenantId, (tx) => ledgerDetail(tx, id, conta, de, ate, parceiro));
          if (!r) return json(res, 404, { erro: "Conta não encontrada" });
          json(res, 200, { ...r, lines: r.lines.slice(-2000), truncated: r.lines.length > 2000 });
          return;
        }
        if (parts[4] === "dre") {
          const mes = url.searchParams.get("mes");
          if (mes === null || !/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) return json(res, 400, { erro: "Mês inválido (AAAA-MM)" });
          json(res, 200, await withTenant(deps.appPool, deps.tenantId, (tx) => incomeStatement(tx, id, mes)));
          return;
        }
        if (parts[4] === "fechamento") {
          const mes = url.searchParams.get("mes");
          if (mes === null || !/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) return json(res, 400, { erro: "Mês inválido (AAAA-MM)" });
          json(res, 200, await closingStatus(deps.appPool, deps.tenantId, id, mes));
          return;
        }
        if (parts[4] === "balanco") {
          const data = url.searchParams.get("data");
          if (!isDate(data)) return json(res, 400, { erro: "Data inválida (AAAA-MM-DD)" });
          json(res, 200, await withTenant(deps.appPool, deps.tenantId, (tx) => balanceSheet(tx, id, data)));
          return;
        }
        if (parts[4] === "abertos") {
          const conta = url.searchParams.get("conta");
          const ate = url.searchParams.get("ate");
          if (!isAcc(conta) || !isDate(ate)) return json(res, 400, { erro: "Informe conta e ate (AAAA-MM-DD)" });
          json(res, 200, await withTenant(deps.appPool, deps.tenantId, (tx) => openItems(tx, id, conta, ate)));
          return;
        }
        return json(res, 404, { erro: "Relatório não encontrado" });
      }
      // GET /api/empresa/:id/contabil[?mes=AAAA-MM] — plano, contas bancárias, balancete e pendentes (só banco).
      if (req.method === "GET" && parts[0] === "api" && parts[1] === "empresa" && parts[3] === "contabil") {
        const id = parts[2]!;
        const mes = url.searchParams.get("mes");
        if (mes !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) return json(res, 400, { erro: "Mês inválido (AAAA-MM)" });
        const data = await withTenant(deps.appPool, deps.tenantId, async (tx) => {
          const chart = await tx.query<{ code: string; name: string; analytic: boolean; valid_from: string }>(
            "SELECT code, name, analytic, valid_from::text FROM chart_account WHERE entity_id = $1 AND valid_to IS NULL ORDER BY code",
            [id],
          );
          const last = await tx.query<{ m: string | null }>("SELECT to_char(max(entry_date), 'YYYY-MM') AS m FROM journal_entry WHERE entity_id = $1", [id]);
          const month = mes ?? last.rows[0]?.m ?? null;
          const end = month ? new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10) : null;
          const trial = month && end ? await trialBalance(tx, id, `${month}-01`, end) : null;
          const months = await tx.query<{ m: string }>("SELECT DISTINCT to_char(entry_date, 'YYYY-MM') AS m FROM journal_entry WHERE entity_id = $1 ORDER BY 1 DESC", [id]);
          return {
            hasChart: chart.rows.length > 0,
            chartFrom: chart.rows.map((c) => c.valid_from).sort()[0] ?? null,
            accounts: chart.rows.filter((c) => c.analytic).map((c) => ({ code: c.code, name: c.name })),
            bank: (await bankOverview(tx, id)).accounts,
            month,
            months: months.rows.map((r) => r.m),
            trial,
          };
        });
        const pending = data.hasChart ? (await pendingMovements(deps.appPool, deps.tenantId, id)).slice(0, 100) : [];
        const taken = data.hasChart ? await pendingTaken(deps.appPool, deps.tenantId, id) : [];
        const bySupplier = new Map<string, { doc: string | null; supplier: string | null; notes: number; total: number; reason: string; codes: string[] }>();
        for (const t of taken) {
          const k = t.supplierDoc ?? t.supplier ?? "—";
          const g = bySupplier.get(k) ?? { doc: t.supplierDoc, supplier: t.supplier, notes: 0, total: 0, reason: t.reason, codes: [] };
          g.notes++;
          g.total += Number(t.value);
          if (t.nationalCode && !g.codes.includes(t.nationalCode)) g.codes.push(t.nationalCode);
          bySupplier.set(k, g);
        }
        const takenRule = await withTenant(deps.appPool, deps.tenantId, (tx) => takenRuleStatus(tx));
        const cfg = await withTenant(deps.appPool, deps.tenantId, (tx) => chartConfig(tx, id));
        const names = new Map(data.accounts.map((a) => [a.code, a.name]));
        const revenueRule = await withTenant(deps.appPool, deps.tenantId, async (tx) => ({
          approved: await ruleStatus(tx, REVENUE_RETENTIONS_RULE), ...(data.hasChart ? await revenueRetentionsPending(tx, id) : { notes: 0, total: "0", withheld: "0" }),
        }));
        json(res, 200, {
          ...data, pending,
          revenueRule,
          roles: { clientes: cfg.roles.CLIENTES ?? null, fornecedores: cfg.roles.FORNECEDORES ?? null },
          chartTemplate: cfg.template,
          taken: { approved: takenRule, pending: taken.length, suppliers: [...bySupplier.values()].sort((a, b) => b.total - a.total).slice(0, 60),
            proposal: serviceProposal(cfg).map((p) => ({ ...p, accountName: p.account ? names.get(p.account) ?? null : null })) },
        });
        return;
      }
      // POST /api/empresa/:id/procuracao — procuração estadual (SEFAZ) ou municipal (Prefeitura), com o termo anexado.
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "empresa" && parts[3] === "procuracao") {
        if (guard("confirmar")) return;
        const body = (await readJson(req, 8 * 1024 * 1024)) as { orgao?: string; forma?: string; inicio?: string; fim?: string | null; protocolo?: string; poderes?: string; arquivo?: { name?: string; data?: string } | null };
        const methods = ["PROCURACAO", "GOVBR", "CERTIFICADO", "SENHA_PORTAL"] as const;
        const method = methods.find((m) => m === body.forma) ?? "PROCURACAO";
        if (body.orgao !== "SEFAZ" && body.orgao !== "PREFEITURA") return json(res, 400, { erro: "Órgão inválido" });
        const file = body.arquivo && typeof body.arquivo.name === "string" && typeof body.arquivo.data === "string"
          ? { name: body.arquivo.name.replace(/[\\/]/g, "_").slice(0, 200), bytes: Buffer.from(body.arquivo.data, "base64") }
          : null;
        try {
          const r = await registerPower(deps.appPool, deps.tenantId, {
            entityId: parts[2]!, system: body.orgao, method, validFrom: body.inicio ?? "", validTo: body.fim || null,
            protocol: body.protocolo?.trim().slice(0, 100) || null, scopes: (body.poderes ?? "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 20), file,
          }, actor);
          await deps.orchestrate?.();
          json(res, 200, r);
        } catch (err) {
          if (err instanceof PowerError) json(res, 400, { erro: err.message });
          else throw err;
        }
        return;
      }
      // POST /api/contabil/tomadas/aprovar — aprova a tabela tipo de serviço → conta das NFS-e tomadas.
      // POST /api/empresa/:id/contabil/fechar {mes} | reabrir {mes, motivo} — fechamento da competência (Responsável técnico).
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "empresa" && parts[3] === "contabil" && (parts[4] === "fechar" || parts[4] === "reabrir")) {
        if (guard("aprovar")) return;
        const body = (await readJson(req, 4096)) as { mes?: string; motivo?: string };
        const mes = String(body.mes ?? "");
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) return json(res, 400, { erro: "Mês inválido (AAAA-MM)" });
        try {
          if (parts[4] === "fechar") {
            const r = await closeMonth(deps.appPool, deps.tenantId, parts[2]!, mes, actor);
            await deps.orchestrate?.();
            json(res, 200, r);
          } else {
            const r = await reopenMonth(deps.appPool, deps.tenantId, parts[2]!, mes, String(body.motivo ?? ""), actor);
            const p = await runAutoPosting(deps.appPool, deps.tenantId, parts[2]!);
            json(res, 200, { ...r, posted: p.posted });
          }
        } catch (err) {
          if (err instanceof LedgerError) json(res, 409, { erro: err.message });
          else throw err;
        }
        return;
      }
      // GET /api/plano-padrao — modelo de plano de contas do escritório (o vigente).
      if (req.method === "GET" && url.pathname === "/api/plano-padrao") {
        json(res, 200, { template: await withTenant(deps.appPool, deps.tenantId, (tx) => activeTemplate(tx)) });
        return;
      }
      // POST /api/plano-padrao {nome, arquivo{name,data}} — importa o relatório de plano de contas (CSV do Domínio).
      if (req.method === "POST" && url.pathname === "/api/plano-padrao") {
        if (guard("aprovar")) return;
        const body = (await readJson(req, 4 * 1024 * 1024)) as { nome?: string; arquivo?: { name?: string; data?: string } };
        if (!body.arquivo?.data || !body.arquivo.name) return json(res, 400, { erro: "Envie o arquivo do plano (CSV)" });
        try {
          json(res, 200, await importChartTemplate(deps.appPool, deps.tenantId, { name: (body.nome ?? "").trim() || body.arquivo.name, fileName: body.arquivo.name, bytes: Buffer.from(body.arquivo.data, "base64") }, actor));
        } catch (err) {
          if (err instanceof LedgerError) json(res, 400, { erro: err.message });
          else throw err;
        }
        return;
      }
      // POST /api/contabil/receita-retencoes/aprovar — regra de receita com retenção sofrida.
      if (req.method === "POST" && url.pathname === "/api/contabil/receita-retencoes/aprovar") {
        if (guard("aprovar")) return;
        try {
          json(res, 200, await approveAccountingRule(deps.appPool, deps.tenantId, REVENUE_RETENTIONS_RULE, actor));
        } catch (err) {
          if (err instanceof LedgerError) json(res, 409, { erro: err.message });
          else throw err;
        }
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/contabil/tomadas/aprovar") {
        if (guard("aprovar")) return;
        try {
          json(res, 200, await approveTakenServicesRule(deps.appPool, deps.tenantId, actor));
        } catch (err) {
          if (err instanceof LedgerError) json(res, 409, { erro: err.message });
          else throw err;
        }
        return;
      }
      // POST /api/empresa/:id/fornecedor — conta das notas de um fornecedor (decisão humana, vira regra).
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "empresa" && parts[3] === "fornecedor") {
        if (guard("confirmar")) return;
        const body = (await readJson(req)) as { doc?: string; conta?: string; historico?: string; escopo?: string };
        try {
          json(res, 200, await classifySupplier(deps.appPool, deps.tenantId, {
            entityId: parts[2]!, supplierDoc: (body.doc ?? "").toUpperCase().replace(/[^0-9A-Z]/g, ""), account: body.conta ?? "",
            history: body.historico ?? "", scope: body.escopo === "ESCRITORIO" ? "ESCRITORIO" : "EMPRESA",
          }, actor));
        } catch (err) {
          if (err instanceof LedgerError) json(res, 409, { erro: err.message });
          else throw err;
        }
        return;
      }
      // POST /api/empresa/:id/plano — aplica o plano de contas padrão (decisão do responsável técnico).
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "empresa" && parts[3] === "plano") {
        if (guard("aprovar")) return;
        const body = (await readJson(req)) as { inicio?: string };
        if (!body.inicio || !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.inicio)) return json(res, 400, { erro: "Informe o mês de início (AAAA-MM)" });
        try {
          const r = await applyStandardChart(deps.appPool, deps.tenantId, parts[2]!, `${body.inicio}-01`, actor);
          const chain = await deps.orchestrate?.();
          json(res, 200, { ...r, chain });
        } catch (err) {
          if (err instanceof LedgerError) json(res, 409, { erro: err.message });
          else throw err;
        }
        return;
      }
      // POST /api/empresa/:id/extrato — extrato OFX enviado pela tela.
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "empresa" && parts[3] === "extrato") {
        if (guard("confirmar")) return;
        const body = (await readJson(req, 15 * 1024 * 1024)) as { name?: string; data?: string };
        if (typeof body.name !== "string" || typeof body.data !== "string") return json(res, 400, { erro: "Arquivo não recebido" });
        try {
          const r = await importBankStatement(deps.appPool, deps.tenantId, parts[2]!, { name: body.name.replace(/[\\/]/g, "_").slice(0, 200), bytes: Buffer.from(body.data, "base64") }, actor);
          const chain = await deps.orchestrate?.();
          json(res, 200, { ...r, chain });
        } catch (err) {
          if (err instanceof StatementError || err instanceof LedgerError) json(res, 422, { erro: err.message });
          else throw err;
        }
        return;
      }
      // POST /api/movimento/:id/classificar — decisão humana sobre um movimento do extrato (e regra para os próximos).
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "movimento" && parts[3] === "classificar") {
        if (guard("confirmar")) return;
        const body = (await readJson(req)) as { conta?: string; historico?: string; regra?: { padrao?: string; escopo?: string } | null };
        if (!body.conta || !body.historico?.trim()) return json(res, 400, { erro: "Informe a conta e o histórico" });
        const rule = body.regra && body.regra.padrao && body.regra.padrao.trim().length >= 3
          ? { pattern: body.regra.padrao.trim(), scope: body.regra.escopo === "ESCRITORIO" ? ("ESCRITORIO" as const) : ("EMPRESA" as const) }
          : null;
        try {
          json(res, 200, await classifyMovement(deps.appPool, deps.tenantId, { transactionId: parts[2]!, account: body.conta, history: body.historico.trim(), rule }, actor));
        } catch (err) {
          if (err instanceof LedgerError) json(res, 409, { erro: err.message });
          else throw err;
        }
        return;
      }
      // GET /api/empresa/:id/simples — cálculos do motor do Simples (só banco).
      if (req.method === "GET" && parts[0] === "api" && parts[1] === "empresa" && parts[3] === "simples") {
        json(res, 200, { rows: await withTenant(deps.appPool, deps.tenantId, (tx) => simplesOverview(tx, parts[2]!)) });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/simples/regras") {
        json(res, 200, { rules: await withTenant(deps.appPool, deps.tenantId, (tx) => simplesRulesList(tx)) });
        return;
      }
      // POST /api/simples/regras/aprovar — decisão humana: aprovar as tabelas propostas.
      if (req.method === "POST" && url.pathname === "/api/simples/regras/aprovar") {
        if (guard("aprovar")) return;
        try {
          const r = await approveSimplesRules(deps.appPool, deps.tenantId, actor);
          const chain = await deps.orchestrate?.();
          json(res, 200, { ...r, chain });
        } catch (err) {
          if (err instanceof SimplesActionError) json(res, 409, { erro: err.message });
          else throw err;
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
      if (req.method === "GET" && url.pathname === "/api/departamentos") {
        json(res, 200, await withTenant(deps.appPool, deps.tenantId, (tx) => departmentsData(tx)));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/cases") {
        json(res, 200, { cases: await withTenant(deps.appPool, deps.tenantId, (tx) => casesList(tx)) });
        return;
      }

      // POST /api/empresas — incluir empresa pelo CNPJ (abre o Case CLIENT_ONBOARDING).
      // Consulta pública do CNPJ sempre; SERPRO (cobrado) só se a pessoa marcar.
      if (req.method === "POST" && url.pathname === "/api/empresas") {
        if (guard("confirmar")) return;
        const body = (await readJson(req, 4096)) as { cnpj?: string; serpro?: boolean };
        const cnpj = normalizeCnpj(String(body.cnpj ?? ""));
        if (!isValidCnpj(cnpj)) return json(res, 400, { erro: "CNPJ inválido" });
        if (body.serpro && !deps.integra) return json(res, 409, { erro: "Integra Contador não configurado: desmarque a consulta ao SERPRO" });
        const publicData = deps.publicData ?? new FallbackCnpjSource([new BrasilApiCnpjSource(undefined, 2), new CnpjaOpenSource()], () => undefined);
        try {
          const r = await onboardByCnpj(
            { appPool: deps.appPool, publicData, integra: body.serpro ? deps.integra : null, metering: deps.metering },
            deps.tenantId,
            { cnpj, requester: actor.id, origin: "tela" },
          );
          await deps.orchestrate?.();
          json(res, 200, {
            entityId: r.entityId, caseId: r.caseId, status: r.caseStatus, created: r.entityCreated,
            name: r.profile?.legalName ?? null, pending: r.pending.map((p) => ({ type: p.type, source: p.responsible_source, info: p.required_information })),
          });
        } catch (err) {
          json(res, 502, { erro: `Inclusão não concluída: ${(err as Error).message}. O processo continua aberto; tente de novo para retomar.` });
        }
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
        if (guard("aprovar")) return;
        try {
          json(res, 200, await approveRules(deps.appPool, deps.tenantId, actor));
        } catch (err) {
          if (err instanceof HumanActionError) json(res, 409, { erro: err.message });
          else throw err;
        }
        return;
      }

      // POST /api/certificados/conferir — lê o cofre local; não consulta órgão externo.
      if (req.method === "POST" && url.pathname === "/api/certificados/conferir") {
        if (guard("conferir")) return;
        if (!deps.vault) return json(res, 409, { erro: "Cofre não encontrado nesta máquina" });
        // Relê o arquivo a cada clique: senha adicionada depois de abrir a tela já vale.
        const vault = openSecretsFile(deps.vault.location) ?? deps.vault;
        const results = await syncClientCertificates(deps.appPool, deps.tenantId, vault, actor);
        void deps.orchestrate?.(); // certificado novo dispara a busca de notas, sem segurar a tela
        json(res, 200, {
          results: results.map((r) => ({
            ...r,
            hint:
              r.status === "NAO_ENCONTRADO" ? `Coloque em ${clientCertificatesDir(vault)} (ou subpasta) um .pfx com ${r.cnpj} no nome`
              : r.status === "SEM_SENHA" ? `Adicione a linha ${clientPasswordKey(r.cnpj)}=senha no segredos.env`
              : null,
          })),
        });
        return;
      }

      // ---------------------------------------------------------------- Documentos (SEFAZ)
      if (req.method === "GET" && url.pathname === "/api/documentos") {
        const entityId = url.searchParams.get("empresa");
        const data = await withTenant(deps.appPool, deps.tenantId, async (tx) => ({
          status: await dfeStatus(tx),
          documents: await documentsList(tx, { entityId: entityId && /^[0-9a-f-]{36}$/.test(entityId) ? entityId : null }),
          nfseStatus: await nfseStatus(tx),
          nfse: await nfseList(tx, entityId && /^[0-9a-f-]{36}$/.test(entityId) ? entityId : null),
        }));
        const slots = deps.noteSlots ?? DEFAULT_NOTE_SLOTS;
        const schedule = { slots, next: nextSlot(new Date(), slots).toISOString(), last: (await lastRuns(deps.appPool, deps.tenantId, "busca-notas")).slice(0, 3) };
        json(res, 200, { configured: Boolean(deps.dfe), schedule, ...data });
        return;
      }
      // POST /api/documentos/buscar — busca de notas agora, todas as empresas (pedido de pessoa; sem custo).
      if (req.method === "POST" && url.pathname === "/api/documentos/buscar") {
        if (guard("buscar-notas")) return;
        if (!deps.searchNotes) return json(res, 409, { erro: "Busca de notas não configurada (cofre ausente)" });
        const r = await deps.searchNotes(actor);
        await recordRun(deps.appPool, deps.tenantId, { job: "busca-notas", slot: new Date(), trigger: "PESSOA", actorId: actor.id, result: r });
        json(res, 200, r);
        return;
      }
      // GET /api/documentos/xml — XML recebidos por upload, pasta e distribuição de CT-e (só banco).
      if (req.method === "GET" && url.pathname === "/api/documentos/xml") {
        const e = url.searchParams.get("empresa");
        json(res, 200, { inbox: deps.inbox ?? null, ...(await fiscalXmlList(deps.appPool, deps.tenantId, e && /^[0-9a-f-]{36}$/.test(e) ? e : null)) });
        return;
      }
      // POST /api/documentos/upload — XML/ZIP enviados pela tela (até 30 MB por envio).
      if (req.method === "POST" && url.pathname === "/api/documentos/upload") {
        if (guard("confirmar")) return;
        try {
          const body = (await readJson(req, 42 * 1024 * 1024)) as { files?: { name?: string; data?: string }[] };
          const files = (body.files ?? [])
            .filter((f) => typeof f.name === "string" && typeof f.data === "string")
            .map((f) => ({ name: f.name!.replace(/[\\/]/g, "_").slice(0, 200), bytes: Buffer.from(f.data!, "base64") }));
          if (!files.length) return json(res, 400, { erro: "Nenhum arquivo recebido" });
          const r = await ingestFiles(deps.appPool, deps.tenantId, files, { source: "UPLOAD", actor });
          await deps.orchestrate?.();
          json(res, 200, { ...r, items: r.items.slice(0, 500) });
        } catch (err) {
          if (err instanceof HumanActionError) json(res, 413, { erro: "Envio acima de 30 MB: mande em partes ou use a pasta de entrada" });
          else throw err;
        }
        return;
      }
      // POST /api/empresa/:id/notas/buscar — consulta a SEFAZ (sem custo), respeitando a regra de 1 h.
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "empresa" && parts[3] === "notas" && parts[4] === "buscar") {
        if (guard("buscar-notas")) return;
        if (!deps.dfe) return json(res, 409, { erro: "Busca de notas não configurada (cofre ausente)" });
        json(res, 200, await syncEntityDfe(deps.dfe, deps.tenantId, parts[2]!, actor));
        return;
      }
      // POST /api/empresa/:id/nfse/buscar — consulta o ADN (sem custo).
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "empresa" && parts[3] === "nfse" && parts[4] === "buscar") {
        if (guard("buscar-notas")) return;
        if (!deps.nfse) return json(res, 409, { erro: "Busca de NFS-e não configurada (cofre ausente)" });
        const nf = await syncEntityNfse(deps.nfse, deps.tenantId, parts[2]!, actor);
        await deps.orchestrate?.();
        json(res, 200, nf);
        return;
      }
      // POST /api/empresa/:id/notas/nsu — decisão humana: NSU inicial (o do outro sistema). Não consulta a SEFAZ.
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "empresa" && parts[3] === "notas" && parts[4] === "nsu") {
        if (guard("confirmar")) return;
        try {
          const body = (await readJson(req)) as { nsu?: string };
          json(res, 200, await setStartingNsu(deps.appPool, deps.tenantId, parts[2]!, String(body.nsu ?? ""), actor));
        } catch (err) {
          json(res, 400, { erro: (err as Error).message });
        }
        return;
      }
      // POST /api/empresa/:id/ciencia/aprovar — decisão humana: ciência da operação das NF-e que aguardam.
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "empresa" && parts[3] === "ciencia" && parts[4] === "aprovar") {
        if (guard("aprovar")) return;
        json(res, 200, await approveCiencia(deps.appPool, deps.tenantId, parts[2]!, actor));
        return;
      }

      // POST /api/pendencia/:id/servicos — decisão humana: serviços e início da responsabilidade
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "pendencia" && parts[3] === "servicos") {
        if (guard("confirmar")) return;
        try {
          const body = (await readJson(req)) as { services?: string[]; startDate?: string };
          const r = await defineContractedServices(
            deps.appPool,
            deps.tenantId,
            { pendingItemId: parts[2]!, services: body.services as never, startDate: body.startDate ?? "" },
            actor,
          );
          await deps.orchestrate?.();
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
        if (guard("aprovar")) return;
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
  const port = Number(process.env.IARIS_WEB_PORT ?? process.env.IARES_WEB_PORT ?? process.env.AIRES_WEB_PORT ?? 3100);
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
  if (!vault?.has("IARIS_AUTH_KEY")) {
    console.error("Falta a chave de login no cofre. Rode uma vez: pnpm auth:init");
    process.exit(1);
  }
  const publicOrigin = (process.env.IARIS_PUBLIC_ORIGIN ?? "").replace(/\/+$/, "") || null;
  const deps: WebDeps = {
    appPool: app,
    tenantId: tenant.id,
    officeName: tenant.name,
    integra: vault ? serproFromVault(vault) : null,
    metering: vault ? serproMetering(vault) : { provider: SERPRO_PROVIDER, dailyLimit: 0 },
    port,
    vault,
    authKey: parseAuthKey(vault.require("IARIS_AUTH_KEY")),
    publicOrigin,
    dfe: vault
      ? {
          appPool: app,
          dist: new SefazDistribution(),
          cteDist: new CteDistribution(),
          // Relê o cofre a cada busca: certificado ou senha trocados já valem.
          certificates: (cnpj: string) => loadClientCertificate(openSecretsFile(vault.location) ?? vault, cnpj),
        }
      : null,
    nfse: vault
      ? {
          appPool: app,
          adn: new AdnDistribution(),
          certificates: (cnpj: string) => loadClientCertificate(openSecretsFile(vault.location) ?? vault, cnpj),
        }
      : null,
  };
  // Pasta de entrada de XML: o que cair lá é importado e movido para processados/recusados (nada é apagado).
  deps.inbox = process.env.IARIS_ENTRADA ?? (vault.location ? join(dirname(vault.location), "..", "entrada") : null);
  if (deps.inbox) {
    const docsAgent = { kind: "AGENT" as const, id: "docs" };
    const inboxTick = async () => {
      try {
        const r = await scanInbox(app, tenant.id, deps.inbox!, docsAgent);
        if (r) {
          console.log(`[docs] pasta de entrada: ${r.imported} importado(s), ${r.duplicated} repetido(s), ${r.rejected} recusado(s)`);
          await deps.orchestrate?.();
        }
      } catch (err) {
        console.error(`[docs] pasta de entrada: ${(err as Error).message}`);
      }
    };
    setTimeout(inboxTick, 12_000);
    setInterval(inboxTick, 2 * 60_000);
  }
  // Orquestrador: vínculos entre agentes (só banco; consulta externa só no vínculo de certificado → NFS-e, sem custo).
  const linkDeps = { nfse: deps.nfse, today: () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }) };
  deps.orchestrate = async () => {
    const r = await runOrchestrator(app, tenant.id, LINKS, linkDeps);
    if (r.reactions || r.errors) console.log(`[orquestrador] ${new Date().toLocaleTimeString("pt-BR")} ${r.reactions} reação(ões)${r.errors ? `, ${r.errors} com erro` : ""}`);
    return r;
  };
  setTimeout(() => void deps.orchestrate?.().catch((e) => console.error(`[orquestrador] ${(e as Error).message}`)), 8_000);
  setInterval(() => void deps.orchestrate?.().catch((e) => console.error(`[orquestrador] ${(e as Error).message}`)), 30_000);
  // Agente Documentos: busca de notas (sem custo) em horários fixos do dia (padrão 07:00 e 18:00,
  // IARIS_BUSCA_HORARIOS) e quando uma pessoa pede. Se o computador estava desligado no horário,
  // roda assim que abrir. As regras de espera da SEFAZ continuam valendo.
  if (deps.dfe && process.env.IARIS_DFE_AUTO !== "0") {
    let running = false;
    const docsAgent = { kind: "AGENT" as const, id: "docs" };
    deps.noteSlots = parseSlots(process.env.IARIS_BUSCA_HORARIOS, DEFAULT_NOTE_SLOTS);
    deps.searchNotes = async (who) => {
      const out = { nfe: 0, cte: 0, nfse: 0, waiting: 0 };
      if (running) return out;
      running = true;
      try {
        for (const r of await syncAllDfe(deps.dfe!, deps.tenantId, who)) {
          out.nfe += r.documents;
          if (r.outcome === "aguardando") out.waiting++;
          if (r.calls) console.log(`[docs] ${new Date().toLocaleTimeString("pt-BR")} NF-e ${r.entityId.slice(0, 8)}: ${r.calls} consulta(s), ${r.documents} documento(s), cStat ${r.statusCode}`);
        }
        for (const r of await syncAllDfe(deps.dfe!, deps.tenantId, who, "CTE")) {
          out.cte += r.documents;
          if (r.calls) console.log(`[docs] ${new Date().toLocaleTimeString("pt-BR")} CT-e ${r.entityId.slice(0, 8)}: ${r.calls} consulta(s), ${r.documents} documento(s), cStat ${r.statusCode}`);
        }
        if (deps.nfse) {
          for (const r of await syncAllNfse(deps.nfse, deps.tenantId, who)) {
            out.nfse += r.documents;
            if (r.calls) console.log(`[docs] ${new Date().toLocaleTimeString("pt-BR")} NFS-e ${r.entityId.slice(0, 8)}: ${r.calls} lote(s), ${r.documents} documento(s), ${r.status}${r.message ? " " + r.message : ""}`);
          }
        }
        await deps.orchestrate?.(); // nota nova → conferência, Simples, tributos e contabilidade (vínculos)
      } catch (err) {
        console.error(`[docs] falha na busca de notas: ${(err as Error).message}`);
      } finally {
        running = false;
      }
      return out;
    };
    const slotCheck = async () => {
      try {
        const due = await dueSlot(app, tenant.id, "busca-notas", deps.noteSlots!);
        if (!due) return;
        console.log(`[docs] busca de notas do horário ${due.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })}`);
        const r = await deps.searchNotes!(docsAgent);
        await recordRun(app, tenant.id, { job: "busca-notas", slot: due, trigger: "HORARIO", actorId: docsAgent.id, result: r });
      } catch (err) {
        console.error(`[docs] agenda da busca: ${(err as Error).message}`);
      }
    };
    setTimeout(slotCheck, 20_000);
    setInterval(slotCheck, 60_000);
    // Ao iniciar: conferência de receita de todas as empresas com declaração lida (só banco).
    setTimeout(async () => {
      try {
        const ids = await withTenant(app, tenant.id, (tx) => tx.query<{ id: string }>("SELECT DISTINCT entity_id AS id FROM pgdas_declared_revenue"));
        for (const { id } of ids.rows) {
          const r = await refreshRevenueExceptions(app, tenant.id, id);
          if (r.opened || r.closed || r.updated) console.log(`[revisão] ${id.slice(0, 8)}: ${r.opened} exceção(ões) aberta(s), ${r.updated} atualizada(s), ${r.closed} fechada(s)`);
          // PDF lido por versão anterior do leitor: relê sem nova consulta.
          await withTenant(app, tenant.id, async (tx) => {
            const miss = await tx.query(
              `SELECT 1 FROM pgdas_declaration_pdf p WHERE p.entity_id = $1 AND p.kind = 'DECLARACAO'
                 AND NOT EXISTS (SELECT 1 FROM pgdas_declared_tax t WHERE t.pdf_id = p.id AND t.parser = $2) LIMIT 1`,
              [id, PGDAS_PDF_PARSER],
            );
            if (miss.rowCount) await reparseDeclarations(tx, id);
          });
          const s = await refreshSimples(app, tenant.id, id);
          if (s.changed) console.log(`[tributos] ${id.slice(0, 8)}: ${s.changed} cálculo(s) do Simples atualizado(s)`);
        }
      } catch (err) {
        console.error(`[revisão] falha na conferência: ${(err as Error).message}`);
      }
    }, 5_000);
  }
  // Agente Guias: situação do DAS muda com o tempo (prazo passa); só banco, sem custo.
  const guidesTick = async () => {
    try {
      const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
      const ids = await withTenant(app, tenant.id, (tx) => tx.query<{ id: string }>("SELECT id FROM entity WHERE cnpj IS NOT NULL"));
      for (const { id } of ids.rows) {
        const r = await refreshGuides(app, tenant.id, id, today);
        if (r.changed) console.log(`[guias] ${id.slice(0, 8)}: ${r.changed} guia(s) mudaram de situação`);
        // Agente Fiscal: lê tributos de NFS-e ainda não lidas e refaz a situação das retenções (prazo passa).
        const t = await readEntityNfseTaxes(app, tenant.id, id);
        if (t.read) console.log(`[fiscal] ${id.slice(0, 8)}: tributos de ${t.read} NFS-e lidos (${t.divergent} a conferir)`);
        const w = await refreshWithholdings(app, tenant.id, id, today);
        if (w.changed) console.log(`[fiscal] ${id.slice(0, 8)}: ${w.changed} retenção(ões) mudaram de situação`);
      }
      // Identidade digital: procurações estaduais e municipais que faltam ou venceram viram pedido ao cliente.
      for (const { id } of ids.rows) await refreshPowerRequirements(app, tenant.id, id);
      // Agente Documentos: relê XML antes não reconhecidos quando o leitor ganha versão nova.
      const rr = await rereadUnrecognized(app, tenant.id, { kind: "AGENT", id: "docs" });
      if (rr.recognized) console.log(`[docs] ${rr.recognized} XML antes não reconhecido(s) agora lido(s)`);
    } catch (err) {
      console.error(`[guias] falha: ${(err as Error).message}`);
    }
  };
  setTimeout(guidesTick, 10_000);
  setInterval(guidesTick, 60 * 60_000);
  createWebServer(deps).listen(port, "127.0.0.1", () => {
    console.log(`IARIS aberto em http://127.0.0.1:${port}  (Ctrl+C para fechar)`);
    if (deps.dfe && process.env.IARIS_DFE_AUTO !== "0") console.log(`Busca de notas (NF-e, CT-e, NFS-e): ${(deps.noteSlots ?? DEFAULT_NOTE_SLOTS).join(" e ")} e quando pedir na tela; sem custo.`);
    console.log(`Teto de consultas cobradas por dia: ${deps.metering.dailyLimit}. Abrir a tela não consulta o SERPRO.`);
  });
}
