import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { audit } from "../../platform/audit/audit.js";
import { appendEvent } from "../../platform/events/outbox.js";
import type { Actor } from "../../shared/actor.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";
import { pendingMovements } from "../ledger/auto-posting.js";
import { chartConfig } from "../ledger/chart-config.js";
import { lockedCompetences } from "../ledger/ledger.js";
import { bankText, partnerRegistry } from "../ledger/partners.js";
import { resolvePendingItem } from "../../platform/pending/pending.js";
import { fixMojibake } from "../../shared/text.js";
import { Dec } from "../../shared/decimal.js";

/**
 * Agente de Relacionamento (One Relationship): o que falta do cliente vira UM
 * pedido consolidado, em linguagem de cliente — nunca um pedido por agente.
 *
 * Fontes (determinísticas, nada inventado):
 *   balancete do escritório anterior no 1º mês sem saldos de abertura;
 *   extratos que não cobrem os meses em aberto (e contas de banco sem extrato);
 *   movimentos do extrato sem documento: comprovante ou nota (saídas),
 *   explicação (entradas, pagamentos a sócio);
 *   notas de fornecedores recorrentes que não chegaram no mês;
 *   NF-e de compra só em resumo há mais de 2 dias (a ciência da operação é do cliente);
 *   pendências abertas a cargo do cliente.
 * Meses em aberto: do início da contabilidade ao último mês completo, sem os já fechados.
 * Cada mudança no que falta gera nova versão; enviar é decisão de pessoa (o
 * texto vai pelo canal do escritório) e fica no histórico.
 */

export type ItemKind = "BALANCETE" | "EXTRATO" | "NOTA_FISCAL" | "CIENCIA" | "COMPROVANTE" | "EXPLICACAO" | "PENDENCIA";
export interface RequestItem { key: string; kind: ItemKind; text: string; month: string | null; months?: string[]; amount?: string; date?: string }

const AGENT: Actor = { kind: "AGENT", id: "relationship" };
const PRODUCER = { kind: "agent" as const, name: "relationship", version: "0.1.0" };
const SECTIONS: [ItemKind, string][] = [
  ["BALANCETE", "Documentos do escritório anterior"],
  ["EXTRATO", "Extratos bancários"],
  ["NOTA_FISCAL", "Notas fiscais que costumam vir e não chegaram"],
  ["CIENCIA", "NF-e de compra que chegaram só em resumo (dar ciência da operação ou enviar o XML)"],
  ["COMPROVANTE", "Comprovantes ou notas de pagamentos"],
  ["EXPLICACAO", "Esclarecimentos"],
  ["PENDENCIA", "Cadastro, acessos e outros documentos"],
];

/** Pendências do onboarding que pertencem a uma seção do pedido (as demais vão em "Cadastro, acessos..."). */
const PENDING_KIND: Record<string, ItemKind> = {
  PREV_TRIAL_BALANCE: "BALANCETE", PREV_LEDGER_CHART: "BALANCETE", PREV_BALANCE_COMPOSITION: "BALANCETE", BANK_ACCOUNTS: "EXTRATO",
};

const brl = (v: string | number) => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dmy = (d: string) => d.split("-").reverse().join("/");
const dm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const my = (m: string) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;
const monthEnd = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
const clean = (s: string | null) => fixMojibake(s).replace(/\s+/g, " ").trim().slice(0, 70);
/** Nome do parceiro para o cliente: sem o número do CNPJ do MEI na frente e sem texto corrompido. */
const partnerName = (name: string | null, doc: string) => clean(fixMojibake(name).replace(/^\s*\d{2}\.?\d{3}\.?\d{3}\s+/, "")) || doc;
/** Histórico do banco legível: só o nome da contraparte (sem "PAGAMENTOS A FORNECEDORES", CPF, datas). */
const EXTRA_BANK_WORDS = new Set(["PAGAMENTOS", "DES", "REM", "ESTATICO", "DINAMICO", "FILIAL", "RECEBIMENTO", "RECEBIMENTOS"]);
function counterparty(memo: string | null, payee: string | null): string {
  const t = bankText([memo, payee].filter(Boolean).join(" ")).split(" ").filter((w) => w && !EXTRA_BANK_WORDS.has(w)).join(" ");
  return (t.length >= 3 ? t : clean([memo, payee].filter(Boolean).join(" "))).slice(0, 60);
}

/** "01/2026 a 04/2026, 06/2026" — meses seguidos viram intervalo. */
export function monthsLabel(months: string[]): string {
  const ms = [...new Set(months)].sort();
  const next = (m: string) => { const y = Number(m.slice(0, 4)); const n = Number(m.slice(5, 7)); return n === 12 ? `${y + 1}-01` : `${y}-${String(n + 1).padStart(2, "0")}`; };
  const runs: [string, string][] = [];
  for (const m of ms) {
    const r = runs[runs.length - 1];
    if (r && next(r[1]) === m) r[1] = m; else runs.push([m, m]);
  }
  // dois meses seguidos ficam como dois itens ("07/2026 e 08/2026"); três ou mais viram intervalo
  const list = runs.flatMap(([a, b]) => (a === b ? [my(a)] : next(a) === b ? [my(a), my(b)] : [`${my(a)} a ${my(b)}`]));
  return list.length > 1 ? `${list.slice(0, -1).join(", ")} e ${list[list.length - 1]}` : (list[0] ?? "");
}

function monthsBetween(fromMonth: string, toMonth: string): string[] {
  const out: string[] = [];
  let y = Number(fromMonth.slice(0, 4));
  let m = Number(fromMonth.slice(5, 7));
  while (`${y}-${String(m).padStart(2, "0")}` <= toMonth) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** Mês anterior a hoje (último mês completo), AAAA-MM. */
function lastCompleteMonth(today: string): string {
  const d = new Date(`${today.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

/** O que falta do cliente hoje (sem gravar nada). */
export async function collectClientNeeds(pool: Pool, tenantId: string, entityId: string, today: string): Promise<RequestItem[]> {
  const items: RequestItem[] = [];
  const movements = await pendingMovements(pool, tenantId, entityId);
  await withTenant(pool, tenantId, async (tx) => {
    const start = (await tx.query<{ d: string | null }>("SELECT min(valid_from)::text AS d FROM chart_account WHERE entity_id = $1 AND source <> 'BANCO'", [entityId])).rows[0]?.d ?? null;
    if (start) {
      const locked = await lockedCompetences(tx, entityId);
      const last = lastCompleteMonth(today);
      const months = monthsBetween(start.slice(0, 7), last).filter((m) => !locked.has(`${m}-01`));
      await openingNeed(tx, entityId, start, months, items);
      await statementNeeds(tx, entityId, months, items);
      await expectedNotes(tx, entityId, months, items);
      const open = movements.filter((p) => months.includes(p.posted_on.slice(0, 7)));
      items.push(...partnerPaymentItems(open));
      for (const p of open) {
        const it = movementItem(p);
        if (it) items.push(it);
      }
    }
    await cienciaNeeds(tx, entityId, today, items);
    const pend = await tx.query<{ id: string; type: string; required_information: string }>(
      "SELECT id, type, required_information FROM pending_item WHERE entity_id = $1 AND status = 'OPEN' AND responsible_source = 'CLIENT' ORDER BY created_at",
      [entityId],
    );
    const has = (prefix: string) => items.some((i) => i.key.startsWith(prefix));
    for (const p of pend.rows) {
      // o item automático é mais preciso (data do saldo, conta e meses que faltam)
      if (p.type === "PREV_TRIAL_BALANCE" && has("balancete-anterior")) continue;
      if (p.type === "BANK_ACCOUNTS" && has("extrato")) continue;
      items.push({ key: `pendencia:${p.type}`, kind: PENDING_KIND[p.type] ?? "PENDENCIA", text: p.required_information, month: null });
    }
  });
  // sem duplicatas pela chave
  return [...new Map(items.map((i) => [i.key, i])).values()];
}

async function openingNeed(tx: PoolClient, entityId: string, start: string, months: string[], items: RequestItem[]) {
  if (!months.includes(start.slice(0, 7))) return;
  const has = await tx.query(
    "SELECT 1 FROM opening_balance_import i WHERE i.entity_id = $1 AND NOT EXISTS (SELECT 1 FROM journal_entry x WHERE x.reverses_id = i.entry_id) LIMIT 1",
    [entityId],
  );
  if (has.rowCount) return;
  const opened = (await tx.query<{ d: string | null }>("SELECT activity_started_at::text AS d FROM entity WHERE id = $1", [entityId])).rows[0]?.d ?? null;
  if (opened && opened >= start) return;
  const eve = new Date(new Date(`${start}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  items.push({ key: "balancete-anterior", kind: "BALANCETE", month: start.slice(0, 7),
    text: `Balancete da contabilidade anterior com os saldos em ${dmy(eve)} (PDF assinado), para começarmos com os saldos certos` });
}

async function statementNeeds(tx: PoolClient, entityId: string, months: string[], items: RequestItem[]) {
  if (!months.length) return;
  const banks = await tx.query<{ id: string; label: string; ledger: string | null; first: string | null; last: string | null }>(
    `SELECT b.id, b.label, b.ledger_account_id::text AS ledger,
            least((SELECT min(f.period_start) FROM bank_statement_file f WHERE f.bank_account_id = b.id),
                  (SELECT min(t.posted_on) FROM bank_transaction t WHERE t.bank_account_id = b.id))::text AS first,
            greatest((SELECT max(f.period_end) FROM bank_statement_file f WHERE f.bank_account_id = b.id),
                     (SELECT max(t.posted_on) FROM bank_transaction t WHERE t.bank_account_id = b.id))::text AS last
       FROM bank_account b WHERE b.entity_id = $1 ORDER BY b.label`,
    [entityId],
  );
  for (const b of banks.rows) {
    const missing = months.filter((m) => !b.first || !b.last || b.first > `${m}-01` || b.last < monthEnd(m));
    if (missing.length) {
      items.push({ key: `extrato:${b.id}:${missing.join(",")}`, kind: "EXTRATO", month: missing[0]!, months: missing,
        text: `Extrato da conta ${b.label} de ${monthsLabel(missing)} (arquivo OFX do internet banking; se não tiver, PDF ou Excel)` });
    }
  }
  // Contas de banco com saldo no razão e sem extrato nenhum (ex.: banco que veio do balancete anterior)
  const cfg = await chartConfig(tx, entityId);
  const root = cfg.roles.BANCOS;
  if (!root) return;
  const end = monthEnd(months[months.length - 1]!);
  const orphan = await tx.query<{ code: string; name: string; bal: string }>(
    `SELECT c.code, c.name, sum(l.debit - l.credit)::text AS bal
       FROM chart_account c JOIN journal_line l ON l.account_id = c.id JOIN journal_entry e ON e.id = l.entry_id
      WHERE c.entity_id = $1 AND c.code LIKE $2 AND c.analytic AND e.entry_date <= $3
        AND NOT EXISTS (SELECT 1 FROM bank_account b WHERE b.ledger_account_id = c.id)
      GROUP BY c.code, c.name HAVING sum(l.debit - l.credit) <> 0`,
    [entityId, `${root}.%`, end],
  );
  for (const o of orphan.rows) {
    items.push({ key: `extrato-conta:${o.code}:${months.join(",")}`, kind: "EXTRATO", month: months[0]!, months,
      text: `Extrato da conta ${o.name} de ${monthsLabel(months)} (a conta tem saldo de ${brl(o.bal)} e ainda não recebemos extrato dela)` });
  }
}

async function expectedNotes(tx: PoolClient, entityId: string, months: string[], items: RequestItem[]) {
  // um item por parceiro, com todos os meses em que a nota não veio
  const by = new Map<string, { role: string; doc: string; name: string | null; expected: string | null; months: string[] }>();
  for (const month of months) {
    const reg = await partnerRegistry(tx, entityId, month);
    for (const e of reg.expectedMissing) {
      const k = `${e.role}:${e.doc}`;
      const cur = by.get(k) ?? { role: e.role, doc: e.doc, name: e.name, expected: null, months: [] };
      cur.months.push(month);
      if (e.expected) cur.expected = String(e.expected);
      by.set(k, cur);
    }
  }
  for (const e of by.values()) {
    const name = partnerName(e.name, e.doc);
    const when = monthsLabel(e.months);
    const about = e.expected ? `cerca de ${brl(e.expected)}` : "";
    if (e.role === "FORNECEDOR") {
      items.push({ key: `nota:${e.doc}:${e.months.join(",")}`, kind: "NOTA_FISCAL", month: e.months[0]!, months: e.months,
        text: `Nota fiscal de ${name} de ${when}${about ? ` (costuma vir todo mês, ${about})` : ""}, se o serviço foi prestado` });
    } else {
      items.push({ key: `faturamento:${e.doc}:${e.months.join(",")}`, kind: "EXPLICACAO", month: e.months[0]!, months: e.months,
        text: `Não encontramos nota emitida para ${name} em ${when} (costuma ter${about ? `, ${about}` : ""}). Não houve faturamento ou a nota foi emitida por outro sistema?` });
    }
  }
}

/**
 * NF-e de compra autorizadas que a SEFAZ entregou só em resumo há mais de 2 dias: a ciência da
 * operação é do cliente (destinatário). Com ela, a próxima busca traz o XML completo sozinha.
 */
async function cienciaNeeds(tx: PoolClient, entityId: string, today: string, items: RequestItem[]) {
  const r = await tx.query<{ issuer: string; n: number; total: string; keys: string[]; first: string; numbers: string[] }>(
    `SELECT coalesce(r.issuer_name, r.issuer_doc, '—') AS issuer, count(*)::int AS n, sum(r.total)::text AS total,
            array_agg(r.access_key ORDER BY r.access_key) AS keys, min(r.issued_at)::date::text AS first,
            array_agg(substr(r.access_key, 26, 9)::int::text ORDER BY r.issued_at) AS numbers
       FROM dfe_document r
      WHERE r.entity_id = $1 AND r.kind = 'RES_NFE' AND r.situation = '1' AND r.access_key IS NOT NULL
        AND r.received_at < ($2::date - 2)
        AND NOT EXISTS (SELECT 1 FROM dfe_document f WHERE f.entity_id = r.entity_id AND f.kind = 'NFE' AND f.access_key = r.access_key)
        AND NOT EXISTS (SELECT 1 FROM fiscal_xml x WHERE x.entity_id = r.entity_id AND x.access_key = r.access_key)
      GROUP BY 1 ORDER BY 1`,
    [entityId, today],
  );
  for (const g of r.rows) {
    items.push({ key: `ciencia:${g.keys.join(",")}`, kind: "CIENCIA", month: g.first.slice(0, 7), amount: Dec.of(g.total).toFixed(2),
      text: `${clean(g.issuer)}: ${g.n === 1 ? "NF-e nº" : `${g.n} NF-e (nº`} ${g.numbers.slice(0, 6).join(", ")}${g.numbers.length > 6 ? "…" : ""}${g.n === 1 ? "" : ")"}, total ${brl(g.total)}` });
  }
}

type Mov = { id: string; posted_on: string; amount: string; memo: string | null; payee: string | null; reason: string };
const SOCIO_RE = /Pagamento a sócio \(([^)]+)\)/;

/** Pagamentos a sócio: um item por sócio, com todos os pagamentos do período. */
function partnerPaymentItems(movs: Mov[]): RequestItem[] {
  const by = new Map<string, Mov[]>();
  for (const p of movs) {
    const m = SOCIO_RE.exec(p.reason);
    if (!m || Math.abs(Number(p.amount)) < 1) continue;
    by.set(m[1]!, [...(by.get(m[1]!) ?? []), p]);
  }
  return [...by.entries()].map(([key, ps]) => {
    // nome completo como aparece no banco ("JOAO MARIA FAGUNDES FILHO"), se começar pelo nome do sócio
    const full = counterparty(ps[0]!.memo, ps[0]!.payee);
    const name = full.startsWith(key) ? full : key;
    const list = ps.map((p) => `${brl(Math.abs(Number(p.amount)))} em ${dm(p.posted_on)}`);
    const total = ps.reduce((a, p) => a + Math.abs(Number(p.amount)), 0);
    return {
      key: `socio:${key}:${ps.map((p) => p.id).sort().join(",")}`, kind: "EXPLICACAO" as const, month: ps[0]!.posted_on.slice(0, 7),
      months: [...new Set(ps.map((p) => p.posted_on.slice(0, 7)))], amount: total.toFixed(2),
      text: ps.length === 1
        ? `Pagamento de ${list[0]} para ${clean(name)}: é reembolso de despesa (envie os comprovantes), pró-labore, distribuição de lucros ou empréstimo?`
        : `Pagamentos para ${clean(name)} (${list.join("; ")} — total ${brl(total)}): são reembolso de despesa (envie os comprovantes), pró-labore, distribuição de lucros ou empréstimo? Se forem de naturezas diferentes, diga qual é qual.`,
    };
  });
}

/** Movimento sem lançamento → o que pedir ao cliente (nulo = assunto interno do escritório). */
function movementItem(p: Mov): RequestItem | null {
  const v = Number(p.amount);
  if (Math.abs(v) < 1) return null;
  const memo = counterparty(p.memo, p.payee);
  const base = { month: p.posted_on.slice(0, 7), amount: Math.abs(v).toFixed(2), date: p.posted_on };
  const r = p.reason;
  if (SOCIO_RE.test(r)) return null; // agrupado por sócio em partnerPaymentItems
  if (/Transferência entre contas/.test(r)) {
    return { ...base, key: `mov:${p.id}`, kind: "EXTRATO", text: `Extrato da outra conta da empresa que recebeu ou enviou ${brl(Math.abs(v))} em ${dm(p.posted_on)} (${memo})` };
  }
  // assuntos internos do escritório (aprovar regra, conflito de regras, plano, DARF ambíguo): não vão ao cliente
  if (/aprove as regras|Duas regras|Regra "|plano não tem|Item do DARF|Itens do DARF|pagamentos federais com o mesmo valor/i.test(r)) return null;
  if (v < 0) {
    return { ...base, key: `mov:${p.id}`, kind: "COMPROVANTE", text: `Comprovante ou nota fiscal do pagamento de ${brl(-v)} em ${dm(p.posted_on)} — ${memo}` };
  }
  return { ...base, key: `mov:${p.id}`, kind: "EXPLICACAO", text: `Recebimento de ${brl(v)} em ${dm(p.posted_on)} (${memo}): de que se trata? Se for venda ou serviço, qual nota fiscal?` };
}

export function buildMessage(company: string, office: string, items: RequestItem[]): string {
  if (!items.length) return `Olá! Por aqui está tudo em dia com a ${company}: no momento não precisamos de nenhum documento. Obrigado!\n${office}`;
  const months = items.flatMap((i) => i.months ?? (i.month ? [i.month] : []));
  const parts = [`Olá! Para concluirmos a contabilidade da ${company}${months.length ? ` de ${monthsLabel(months)}` : ""}, precisamos de:`];
  for (const [kind, title] of SECTIONS) {
    const list = items.filter((i) => i.kind === kind);
    if (!list.length) continue;
    parts.push(`\n*${title}*\n${list.map((i) => `• ${i.text}`).join("\n")}`);
  }
  parts.push("\nPode responder por aqui mesmo, com os arquivos. Obrigado!", office);
  return parts.join("\n");
}

/**
 * Pendências do onboarding que a própria IARIS vê resolvidas pelos dados que chegaram
 * (Pending Engine: documento recebido → pendência resolvida, sem pessoa conferir).
 */
export async function settleClientPendings(tx: PoolClient, entityId: string, actor: Actor = AGENT): Promise<number> {
  const open = await tx.query<{ id: string; type: string }>(
    "SELECT id, type FROM pending_item WHERE entity_id = $1 AND status = 'OPEN' AND type IN ('PREV_TRIAL_BALANCE', 'BANK_ACCOUNTS')",
    [entityId],
  );
  let n = 0;
  for (const p of open.rows) {
    let resolution: string | null = null;
    if (p.type === "PREV_TRIAL_BALANCE") {
      const r = await tx.query<{ file_name: string; period_end: string }>(
        `SELECT i.file_name, i.period_end::text FROM opening_balance_import i
          WHERE i.entity_id = $1 AND NOT EXISTS (SELECT 1 FROM journal_entry x WHERE x.reverses_id = i.entry_id) ORDER BY i.created_at DESC LIMIT 1`,
        [entityId],
      );
      if (r.rows[0]) resolution = `Balancete recebido (${r.rows[0].file_name}) e saldos de ${dmy(r.rows[0].period_end)} lançados na abertura`;
    } else {
      const r = await tx.query<{ n: number; banks: string }>(
        `SELECT count(DISTINCT b.id)::int AS n, string_agg(DISTINCT b.label, ', ') AS banks FROM bank_account b
          WHERE b.entity_id = $1 AND EXISTS (SELECT 1 FROM bank_transaction t WHERE t.bank_account_id = b.id)`,
        [entityId],
      );
      if (r.rows[0]?.n) resolution = `Bancos conhecidos pelos extratos recebidos (${r.rows[0].banks}); meses que faltam seguem no pedido ao cliente`;
    }
    if (resolution) { await resolvePendingItem(tx, { id: p.id, resolution }, actor); n++; }
  }
  return n;
}

const fingerprintOf = (items: RequestItem[]) =>
  createHash("sha256").update(JSON.stringify([...items].sort((a, b) => a.key.localeCompare(b.key)).map((i) => [i.key, i.text]))).digest("hex");

/** Prepara (ou mantém) o pedido consolidado da empresa. Idempotente: só cria versão quando o que falta muda. */
export async function prepareClientRequest(pool: Pool, tenantId: string, entityId: string, today: string, actor: Actor = AGENT) {
  await withTenant(pool, tenantId, (tx) => settleClientPendings(tx, entityId, actor));
  const items = await collectClientNeeds(pool, tenantId, entityId, today);
  const fp = fingerprintOf(items);
  return withTenant(pool, tenantId, async (tx) => {
    const last = (await tx.query<{ id: string; version: number; fingerprint: string; items: RequestItem[] }>(
      "SELECT id, version, fingerprint, items FROM client_request WHERE entity_id = $1 ORDER BY version DESC LIMIT 1",
      [entityId],
    )).rows[0];
    if (last && last.fingerprint === fp) return { requestId: last.id, version: last.version, changed: false, items: items.length };
    if (!last && !items.length) return { requestId: null, version: 0, changed: false, items: 0 };
    const names = (await tx.query<{ company: string; office: string }>(
      "SELECT coalesce(e.trade_name, e.legal_name) AS company, t.name AS office FROM entity e JOIN tenant t ON t.id = e.tenant_id WHERE e.id = $1",
      [entityId],
    )).rows[0]!;
    const id = newId();
    const version = (last?.version ?? 0) + 1;
    const keys = new Set(items.map((i) => i.key));
    const resolved = (last?.items ?? []).filter((i) => !keys.has(i.key)).length;
    await tx.query(
      "INSERT INTO client_request (id, tenant_id, entity_id, version, fingerprint, items, message, created_by) VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7)",
      [id, entityId, version, fp, JSON.stringify(items), buildMessage(names.company, names.office, items), `${actor.kind}:${actor.id}`],
    );
    await tx.query("INSERT INTO client_request_status (id, tenant_id, request_id, status, actor_id) VALUES ($1, current_tenant(), $2, 'PREPARADO', $3)", [newId(), id, `${actor.kind}:${actor.id}`]);
    await appendEvent(tx, {
      type: "CLIENT_REQUEST_PREPARED", schemaVersion: 1, producer: PRODUCER, idempotencyKey: `pedido:${entityId}:v${version}`, entityId,
      payload: { entity_id: entityId, request_id: id, version, items: items.length, resolved },
    });
    await audit(tx, { actor, action: "relationship.request_prepared", resourceType: "client_request", resourceId: id, entityId, data: { version, items: items.length, resolved } });
    return { requestId: id, version, changed: true, items: items.length, resolved };
  });
}

export class ClientRequestError extends Error {}

/** Pessoa enviou o pedido pelo canal do escritório (o texto foi copiado da tela). */
export async function markRequestSent(pool: Pool, tenantId: string, requestId: string, channel: "WHATSAPP" | "EMAIL" | "PORTAL" | "TELEFONE" | "OUTRO", actor: Actor) {
  if (actor.kind !== "USER") throw new ClientRequestError("Enviar ao cliente é registrado por uma pessoa");
  return withTenant(pool, tenantId, async (tx) => {
    const r = await tx.query<{ entity_id: string; version: number; items: RequestItem[] }>("SELECT entity_id, version, items FROM client_request WHERE id = $1", [requestId]);
    const req = r.rows[0];
    if (!req) throw new ClientRequestError("Pedido não encontrado");
    const latest = await tx.query<{ id: string }>("SELECT id FROM client_request WHERE entity_id = $1 ORDER BY version DESC LIMIT 1", [req.entity_id]);
    if (latest.rows[0]?.id !== requestId) throw new ClientRequestError("O pedido mudou desde que a tela abriu: atualize e envie a versão nova");
    await tx.query("INSERT INTO client_request_status (id, tenant_id, request_id, status, channel, actor_id) VALUES ($1, current_tenant(), $2, 'ENVIADO', $3, $4)", [newId(), requestId, channel, actor.id]);
    await appendEvent(tx, {
      type: "CLIENT_REQUEST_SENT", schemaVersion: 1, producer: { kind: "user", name: actor.id, version: "1" }, idempotencyKey: `pedido-enviado:${requestId}:${newId()}`, entityId: req.entity_id,
      payload: { entity_id: req.entity_id, request_id: requestId, version: req.version, channel, items: req.items.length },
    });
    await audit(tx, { actor, action: "relationship.request_sent", resourceType: "client_request", resourceId: requestId, entityId: req.entity_id, data: { channel, version: req.version } });
    return { sent: true };
  });
}

/** Pedido atual da empresa, histórico e o que se resolveu desde o último envio (para a tela). */
export async function clientRequestView(tx: PoolClient, entityId: string) {
  const cur = (await tx.query<{ id: string; version: number; items: RequestItem[]; message: string; created_at: Date }>(
    "SELECT id, version, items, message, created_at FROM client_request WHERE entity_id = $1 ORDER BY version DESC LIMIT 1",
    [entityId],
  )).rows[0];
  if (!cur) return { request: null, history: [], resolvedSinceSent: [] as RequestItem[], lastSent: null };
  const history = (await tx.query<{ version: number; status: string; channel: string | null; actor_id: string; at: Date }>(
    `SELECT r.version, s.status, s.channel, s.actor_id, s.at FROM client_request_status s JOIN client_request r ON r.id = s.request_id
      WHERE r.entity_id = $1 ORDER BY s.at DESC LIMIT 30`,
    [entityId],
  )).rows;
  const sent = (await tx.query<{ version: number; items: RequestItem[]; at: Date; channel: string | null }>(
    `SELECT r.version, r.items, s.at, s.channel FROM client_request_status s JOIN client_request r ON r.id = s.request_id
      WHERE r.entity_id = $1 AND s.status = 'ENVIADO' ORDER BY s.at DESC LIMIT 1`,
    [entityId],
  )).rows[0];
  const keys = new Set(cur.items.map((i) => i.key));
  return {
    request: cur,
    history,
    lastSent: sent ? { version: sent.version, at: sent.at, channel: sent.channel } : null,
    resolvedSinceSent: sent ? sent.items.filter((i) => !keys.has(i.key)) : [],
  };
}
