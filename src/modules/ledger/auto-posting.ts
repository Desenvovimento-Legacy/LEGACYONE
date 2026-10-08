import type { Pool, PoolClient } from "pg";
import { NFSE_TAX_PARSER } from "../../integrations/nfse/nfse-taxes.js";
import { audit } from "../../platform/audit/audit.js";
import { appendEvent, type Producer } from "../../platform/events/outbox.js";
import type { Actor } from "../../shared/actor.js";
import { Dec } from "../../shared/decimal.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";
import { normalize } from "../../shared/text.js";
import { identifyPartner, learnAlias, loadPartnerIndex, syncPartners, type IdentifiedPartner, type PartnerIndex } from "./partners.js";
import { LedgerError, postEntry, reverseEntry, type EntryLine } from "./ledger.js";
import { serviceAccount, TAKEN_SERVICES_RULE } from "./service-accounts.js";

/**
 * Motor de contabilização automática (determinístico, sem IA).
 *
 *  Fiscal → razão
 *    NFS-e prestada               D 1.1.2.01 Clientes          C 3.1.1.01 Receita de serviços
 *    NFS-e cancelada depois       estorno do lançamento da nota
 *    débito declarado no PGDAS-D  D 3.2.1.01 Simples s/ receita C 2.1.2.01 Simples a recolher (último dia do mês)
 *  Extrato → razão
 *    pagamento federal (DAS/DARF) mesmo valor, data ±3 dias, item a item do DARF:
 *                                 D conta do tributo (principal) e 4.4.1.02 (multa/juros)   C banco
 *    recebimento de NFS-e         mesmo valor líquido de uma única nota em aberto (até 120 dias)
 *                                 D banco  C 1.1.2.01 Clientes
 *    regra de histórico           criada por uma pessoa: D/C conforme entrada ou saída
 *  O que não casar com uma única hipótese fica para classificação humana.
 */

export const AUTO_POSTING_RULES = "contabil-auto@1";
const PRODUCER: Producer = { kind: "engine", name: "ledger", version: "0.1.0" };
export const LEDGER_ENGINE: Actor = { kind: "AGENT", id: "ledger" };

const lastDay = (comp: string) => {
  const d = new Date(`${comp.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export { normalize };
const brl = (v: string) => Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2 });

/** Conta do tributo pelo item do DARF (código; senão descrição). Nulo = não sei: fica para pessoa. */
export function federalItemAccount(code: string | null, description: string | null): string | null {
  const c = (code ?? "").replace(/\D/g, "").slice(0, 4);
  const d = normalize(description);
  if (c === "3333" || (/SIMPLES NACIONAL/.test(d) && !/CONCOMITANTE|SIMPLES CONC/.test(d))) return "2.1.2.01";
  if (["1708", "8045", "3280"].includes(c) || /IRRF.*PESSOA JURIDICA/.test(d)) return "2.1.2.02";
  if (["5952", "5979", "5960", "5987"].includes(c) || /RETENCAO.*(PIS|COFINS|CSLL)|CSRF/.test(d)) return "2.1.2.03";
  if (c === "0561" || /IRRF.*TRABALHO ASSALARIADO/.test(d)) return "2.1.3.05";
  if (c === "0588" || /IRRF.*SEM VINCULO/.test(d)) return "2.1.2.02";
  if (/CONTRIBUICAO PREVIDENCIARIA|CONTRIB(UICAO)? EMPRESA|^CP |\bRAT\b|TERCEIROS/.test(d) || ["1082", "1099", "1138", "1646", "1170", "1176", "1191", "1196", "1200"].includes(c)) return "2.1.3.03";
  return null;
}

interface Ctx { tx: PoolClient; entityId: string; start: string; actor: Actor; partners?: PartnerIndex }

/** Parceiro (cliente ou fornecedor) gravado na linha: base de razão auxiliar e contas em aberto. */
const partner = (doc: string | null, name: string | null): Record<string, string> => {
  const d: Record<string, string> = {};
  if (doc) d.parceiro_doc = doc;
  if (name) d.parceiro = name.slice(0, 120);
  return d;
};
interface Stats { posted: number; reversed: number; pending: number; total: Dec; dates: string[] }

async function chartStart(tx: PoolClient, entityId: string): Promise<string | null> {
  const r = await tx.query<{ d: string | null }>("SELECT min(valid_from)::text AS d FROM chart_account WHERE entity_id = $1 AND source <> 'BANCO'", [entityId]);
  return r.rows[0]?.d ?? null;
}

async function post(ctx: Ctx, s: Stats, input: Parameters<typeof postEntry>[1]) {
  const r = await postEntry(ctx.tx, { ...input, rule: input.rule ?? AUTO_POSTING_RULES }, ctx.actor, { event: false });
  if (r.created) {
    s.posted++;
    s.total = s.total.add(input.lines.reduce((a, l) => a.add(l.debit ?? "0"), Dec.ZERO));
    s.dates.push(input.date);
  }
  return r;
}

// ------------------------------------------------------------------ fiscal → razão

async function nfseRevenue(ctx: Ctx, s: Stats) {
  const { rows } = await ctx.tx.query<{
    id: string; number: string | null; taker: string | null; taker_doc: string | null; issued: string; value: string; key: string | null; withheld: string | null; cancelled: boolean;
  }>(
    `WITH cancelled AS (
       SELECT DISTINCT access_key FROM nfse_document
        WHERE entity_id = $1 AND role = 'EVENTO' AND access_key IS NOT NULL
          AND (event_type ILIKE '%101101%' OR event_type ILIKE '%105102%' OR event_type ILIKE '%cancel%'))
     SELECT d.id, d.number, coalesce(d.taker_name, d.taker_doc) AS taker, d.taker_doc,
            to_char(d.issued_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS issued, d.service_value::text AS value, d.access_key AS key,
            (SELECT (t.total_withheld_calc)::text FROM nfse_tax t WHERE t.nfse_id = d.id AND t.parser = $3) AS withheld,
            d.access_key IS NOT NULL AND d.access_key IN (SELECT access_key FROM cancelled) AS cancelled
       FROM nfse_document d
      WHERE d.entity_id = $1 AND d.role = 'PRESTADA' AND d.service_value > 0
        AND (d.issued_at AT TIME ZONE 'America/Sao_Paulo')::date >= $2
      ORDER BY d.issued_at`,
    [ctx.entityId, ctx.start, NFSE_TAX_PARSER],
  );
  for (const n of rows) {
    const key = `nfse:${n.id}`;
    if (n.cancelled) {
      const e = await ctx.tx.query<{ id: string }>("SELECT id FROM journal_entry WHERE idempotency_key = $1", [key]);
      if (e.rows[0]) {
        const r = await reverseEntry(ctx.tx, e.rows[0].id, "NFS-e cancelada", ctx.actor);
        if (r.created) s.reversed++;
      }
      continue;
    }
    if (n.withheld !== null && Dec.of(n.withheld).gt("0")) {
      s.pending++; // nota com retenção sofrida: contabilização com retenções ainda não automática
      continue;
    }
    await post(ctx, s, {
      entityId: ctx.entityId, date: n.issued, origin: "FISCAL", originRef: `nfse_document:${n.id}`, idempotencyKey: key,
      history: `NFS-e nº ${n.number ?? "—"} prestada a ${n.taker ?? "tomador"}`,
      evidence: [{ kind: "nfse_document", id: n.id }], confidence: "1",
      lines: [{ account: "1.1.2.01", debit: n.value, dimensions: partner(n.taker_doc, n.taker) }, { account: "3.1.1.01", credit: n.value }],
    });
  }
}

async function simplesProvision(ctx: Ctx, s: Stats) {
  // Base da provisão por competência: o débito da declaração lida (preferido) ou,
  // sem o PDF, o cálculo do motor que conferiu ao centavo com o DAS pago.
  const declared = await ctx.tx.query<{ competence: string; number: string | null; total: string }>(
    `WITH last AS (
       SELECT DISTINCT ON (competence) competence, pdf_id, declaration_number FROM pgdas_declared_tax
        WHERE entity_id = $1 ORDER BY competence, declaration_number DESC NULLS LAST, created_at DESC)
     SELECT l.competence::text, l.declaration_number AS number, sum(t.total)::text AS total
       FROM last l JOIN pgdas_declared_tax t ON t.pdf_id = l.pdf_id AND t.competence = l.competence
      WHERE t.parser = (SELECT max(x.parser) FROM pgdas_declared_tax x WHERE x.pdf_id = t.pdf_id) AND l.competence >= $2
      GROUP BY 1, 2`,
    [ctx.entityId, ctx.start],
  );
  const checked = await ctx.tx.query<{ competence: string; id: string; total: string; reference_kind: string }>(
    `SELECT competence::text, id, total::text, reference_kind FROM (
       SELECT DISTINCT ON (competence) * FROM simples_calculation WHERE entity_id = $1 ORDER BY competence, created_at DESC) c
      WHERE c.status = 'CONFERE' AND c.competence >= $2 AND c.total IS NOT NULL`,
    [ctx.entityId, ctx.start],
  );
  type Base = { competence: string; key: string; total: string; ref: string; history: string; evidence: { kind: string; id: string } };
  const bases = new Map<string, Base>();
  for (const c of checked.rows) {
    const pa = `${c.competence.slice(5, 7)}/${c.competence.slice(0, 4)}`;
    bases.set(c.competence, {
      competence: c.competence, key: `simples:${c.competence.slice(0, 7)}:calculo:${c.id}`, total: c.total, ref: `simples_calculation:${c.id}`,
      history: `Simples Nacional ${pa} (cálculo da IARIS conferido com o ${c.reference_kind === "DAS_PAGO" ? "DAS pago" : "declarado"})`,
      evidence: { kind: "simples_calculation", id: c.id },
    });
  }
  for (const r of declared.rows) {
    bases.set(r.competence, {
      competence: r.competence, key: `simples:${r.competence.slice(0, 7)}:${r.number ?? "sem-numero"}`, total: r.total, ref: `pgdas:${r.number}`,
      history: `Simples Nacional ${r.competence.slice(5, 7)}/${r.competence.slice(0, 4)} declarado no PGDAS-D ${r.number ?? ""}`.trim(),
      evidence: { kind: "pgdas_declaration", id: r.number ?? r.competence },
    });
  }
  for (const b of [...bases.values()].sort((x, y) => x.competence.localeCompare(y.competence))) {
    if (!Dec.of(b.total).gt("0")) continue;
    const done = await ctx.tx.query<{ total: string }>(
      `SELECT sum(l.credit)::text AS total FROM journal_entry e JOIN journal_line l ON l.entry_id = e.id
        WHERE e.idempotency_key = $1 AND NOT EXISTS (SELECT 1 FROM journal_entry x WHERE x.reverses_id = e.id)`,
      [b.key],
    );
    // Base nova (retificadora ou PDF que chegou depois): estorna a provisão anterior da competência.
    const prev = await ctx.tx.query<{ id: string; key: string }>(
      `SELECT e.id, e.idempotency_key AS key FROM journal_entry e WHERE e.entity_id = $1 AND e.idempotency_key LIKE $2 AND e.idempotency_key <> $3
          AND NOT EXISTS (SELECT 1 FROM journal_entry x WHERE x.reverses_id = e.id)`,
      [ctx.entityId, `simples:${b.competence.slice(0, 7)}:%`, b.key],
    );
    for (const p of prev.rows) if ((await reverseEntry(ctx.tx, p.id, `substituída: ${b.history}`, ctx.actor)).created) s.reversed++;
    if (done.rows[0]?.total) continue;
    await post(ctx, s, {
      entityId: ctx.entityId, date: lastDay(b.competence), origin: "TRIBUTOS", originRef: b.ref, idempotencyKey: b.key,
      history: b.history, evidence: [b.evidence], confidence: "1",
      lines: [{ account: "3.2.1.01", debit: b.total }, { account: "2.1.2.01", credit: b.total }],
    });
  }
}

// ------------------------------------------------------------------ NFS-e tomadas → razão

export interface PendingTaken {
  nfseId: string;
  number: string | null;
  issued: string;
  supplierDoc: string | null;
  supplier: string | null;
  nationalCode: string | null;
  value: string;
  reason: string;
}

async function takenRuleApproved(tx: PoolClient): Promise<boolean> {
  const r = await tx.query("SELECT 1 FROM accounting_rule_approval WHERE rule_set = $1", [TAKEN_SERVICES_RULE]);
  return Boolean(r.rowCount);
}

/**
 * NFS-e tomada: D despesa (regra do fornecedor ou tipo de serviço aprovado)
 *               C 2.1.1.01 Fornecedores (líquido) e C retenções a recolher.
 */
async function nfseExpenses(ctx: Ctx, s: Stats, pending: PendingTaken[]) {
  const approved = await takenRuleApproved(ctx.tx);
  const { rows } = await ctx.tx.query<{
    id: string; number: string | null; issued: string; doc: string | null; supplier: string | null; code: string | null; value: string;
    irrf: string; csrf: string; cp: string; iss: string; check: string | null; cancelled: boolean;
  }>(
    `WITH cancelled AS (
       SELECT DISTINCT access_key FROM nfse_document
        WHERE entity_id = $1 AND role = 'EVENTO' AND access_key IS NOT NULL
          AND (event_type ILIKE '%101101%' OR event_type ILIKE '%105102%' OR event_type ILIKE '%cancel%'))
     SELECT d.id, d.number, to_char(d.issued_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS issued, d.provider_doc AS doc,
            d.provider_name AS supplier, t.national_code AS code, d.service_value::text AS value,
            coalesce(t.irrf, 0)::text AS irrf, coalesce(t.csrf, 0)::text AS csrf, coalesce(t.cp, 0)::text AS cp, coalesce(t.iss_withheld, 0)::text AS iss,
            t.read_check AS check,
            d.access_key IS NOT NULL AND d.access_key IN (SELECT access_key FROM cancelled) AS cancelled
       FROM nfse_document d LEFT JOIN nfse_tax t ON t.nfse_id = d.id AND t.parser = $3
      WHERE d.entity_id = $1 AND d.role = 'TOMADA' AND d.service_value > 0
        AND (d.issued_at AT TIME ZONE 'America/Sao_Paulo')::date >= $2
      ORDER BY d.issued_at`,
    [ctx.entityId, ctx.start, NFSE_TAX_PARSER],
  );
  for (const n of rows) {
    const key = `nfse-tomada:${n.id}`;
    if (n.cancelled) {
      const e = await ctx.tx.query<{ id: string }>("SELECT id FROM journal_entry WHERE idempotency_key = $1", [key]);
      if (e.rows[0] && (await reverseEntry(ctx.tx, e.rows[0].id, "NFS-e tomada cancelada", ctx.actor)).created) s.reversed++;
      continue;
    }
    const done = await ctx.tx.query("SELECT 1 FROM journal_entry WHERE idempotency_key = $1", [key]);
    if (done.rowCount) continue;
    const miss = (reason: string) => {
      s.pending++;
      pending.push({ nfseId: n.id, number: n.number, issued: n.issued, supplierDoc: n.doc, supplier: n.supplier, nationalCode: n.code, value: n.value, reason });
    };
    if (n.check === null) { miss("Tributos da nota ainda não lidos"); continue; }
    if (n.check === "DIVERGENTE") { miss("Retenções da nota a conferir (total retido diferente da soma)"); continue; }
    const rule = n.doc
      ? await ctx.tx.query<{ account_code: string; history: string; id: string }>(
          `SELECT id, account_code, history FROM supplier_rule
            WHERE supplier_doc = $1 AND (entity_id = $2 OR entity_id IS NULL) AND valid_from <= $3 AND (valid_to IS NULL OR valid_to >= $3)
            ORDER BY (entity_id IS NULL), created_at DESC LIMIT 1`,
          [n.doc, ctx.entityId, n.issued],
        )
      : null;
    const byRule = rule?.rows[0] ?? null;
    const proposed = approved ? serviceAccount(n.code) : null;
    const account = byRule?.account_code ?? proposed;
    if (!account) {
      miss(approved ? `Tipo de serviço ${n.code ?? "não informado"} sem conta definida` : "Tabela de contas das NFS-e tomadas aguardando aprovação");
      continue;
    }
    const ret = { irrf: n.irrf, csrf: n.csrf, cp: n.cp, iss: n.iss };
    const totalRet = Dec.of(ret.irrf).add(ret.csrf).add(ret.cp).add(ret.iss);
    const net = Dec.of(n.value).sub(totalRet);
    if (!net.gt("0")) { miss("Retenções maiores que o valor da nota"); continue; }
    const dim = partner(n.doc, n.supplier);
    const lines: EntryLine[] = [{ account, debit: Dec.of(n.value).toFixed(2), dimensions: dim }, { account: "2.1.1.01", credit: net.toFixed(2), dimensions: dim }];
    if (Dec.of(ret.irrf).gt("0")) lines.push({ account: "2.1.2.02", credit: Dec.of(ret.irrf).toFixed(2), history: "IRRF retido", dimensions: dim });
    if (Dec.of(ret.csrf).gt("0")) lines.push({ account: "2.1.2.03", credit: Dec.of(ret.csrf).toFixed(2), history: "PIS/COFINS/CSLL retidos", dimensions: dim });
    if (Dec.of(ret.iss).gt("0")) lines.push({ account: "2.1.2.04", credit: Dec.of(ret.iss).toFixed(2), history: "ISS retido", dimensions: dim });
    if (Dec.of(ret.cp).gt("0")) lines.push({ account: "2.1.2.05", credit: Dec.of(ret.cp).toFixed(2), history: "INSS retido", dimensions: dim });
    try {
      await post(ctx, s, {
        entityId: ctx.entityId, date: n.issued, origin: "FISCAL", originRef: `nfse_document:${n.id}`, idempotencyKey: key,
        history: `${byRule ? byRule.history : "Serviço tomado"} — NFS-e nº ${n.number ?? "—"} de ${n.supplier ?? n.doc ?? "prestador"}`,
        rule: byRule ? `supplier_rule:${byRule.id}` : TAKEN_SERVICES_RULE, confidence: "1",
        evidence: [{ kind: "nfse_document", id: n.id }], lines,
      });
    } catch (err) {
      if (!(err instanceof LedgerError)) throw err;
      miss(err.message);
    }
  }
}

interface OpenNote { id: string; number: string | null; name: string | null; doc: string | null; issued: string; net: string }
type NoteMatch = { notes: OpenNote[]; who: IdentifiedPartner | null; grouped: boolean } | { why: string; hypotheses: string[] } | null;

/** NFS-e (tomadas ou emitidas) já contabilizadas, ainda sem pagamento/recebimento no extrato, até 120 dias antes do movimento. */
async function openNotes(ctx: Ctx, role: "TOMADA" | "PRESTADA", until: string): Promise<OpenNote[]> {
  const sql = role === "TOMADA"
    ? `SELECT d.id, d.number, d.provider_name AS name, d.provider_doc AS doc, to_char(d.issued_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS issued,
              (d.service_value - t.total_withheld_calc)::text AS net
         FROM nfse_document d JOIN nfse_tax t ON t.nfse_id = d.id AND t.parser = $4
         JOIN journal_entry e ON e.idempotency_key = 'nfse-tomada:' || d.id::text
        WHERE d.entity_id = $1 AND d.role = 'TOMADA' AND (d.issued_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2 AND $3
          AND NOT EXISTS (SELECT 1 FROM journal_entry x WHERE x.reverses_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM bank_match b WHERE b.method = 'NFSE_TOMADA' AND b.reference = d.id::text)
        ORDER BY d.issued_at, d.number`
    : `SELECT d.id, d.number, coalesce(d.taker_name, d.taker_doc) AS name, d.taker_doc AS doc, to_char(d.issued_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS issued,
              coalesce(d.net_value, d.service_value)::text AS net
         FROM nfse_document d JOIN journal_entry e ON e.idempotency_key = 'nfse:' || d.id::text
        WHERE d.entity_id = $1 AND d.role = 'PRESTADA' AND (d.issued_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2 AND $3
          AND NOT EXISTS (SELECT 1 FROM journal_entry x WHERE x.reverses_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM bank_match b WHERE b.method = 'NFSE' AND b.reference = d.id::text)
          AND $4::text IS NOT NULL
        ORDER BY d.issued_at, d.number`;
  const { rows } = await ctx.tx.query<OpenNote>(sql, [ctx.entityId, addDays(until, -120), until, NFSE_TAX_PARSER]);
  return rows;
}

/**
 * Qual(is) nota(s) este movimento quita?
 * 1. Valor exato de uma nota em aberto; se houver várias, o parceiro reconhecido no histórico desempata.
 * 2. Sem nota com o valor exato: parceiro reconhecido + soma exata das notas mais antigas dele (pagamento agrupado).
 * Parceiro reconhecido pelo CNPJ ou apelido que contradiz a nota de mesmo valor = pendência, nunca força.
 */
async function matchNotes(ctx: Ctx, m: Movement, role: "TOMADA" | "PRESTADA"): Promise<NoteMatch> {
  const value = Dec.of(m.amount).cmp("0") < 0 ? Dec.of(m.amount).mul("-1").toFixed(2) : Dec.of(m.amount).toFixed(2);
  ctx.partners ??= await loadPartnerIndex(ctx.tx, ctx.entityId);
  const memo = [m.memo, m.payee].filter(Boolean).join(" ");
  const id = identifyPartner(ctx.partners, memo, role === "TOMADA" ? "FORNECEDOR" : "CLIENTE");
  const who = id && "doc" in id ? id : null;
  const all = await openNotes(ctx, role, m.posted_on);
  const label = (n: OpenNote) => `NFS-e ${n.number ?? "—"} de ${n.issued} (${n.name ?? "—"}) ${brl(n.net)}`;
  const kind = role === "TOMADA" ? "tomadas" : "emitidas";
  const byValue = all.filter((n) => Dec.of(n.net).cmp(value) === 0);
  if (byValue.length) {
    if (who) {
      const mine = byValue.filter((n) => n.doc === who.doc);
      if (mine.length === 1) return { notes: mine, who, grouped: false };
      if (mine.length > 1) return { why: `${mine.length} NFS-e ${kind} de ${who.name ?? who.doc} em aberto com o mesmo valor`, hypotheses: mine.slice(0, 5).map(label) };
      if (who.via !== "NOME") return { why: `O banco indica ${who.name ?? who.doc}, mas a NFS-e com esse valor é de outro parceiro`, hypotheses: byValue.slice(0, 5).map(label) };
    }
    if (byValue.length === 1) return { notes: byValue, who: null, grouped: false };
    return { why: `${byValue.length} NFS-e ${kind} em aberto com o mesmo valor`, hypotheses: byValue.slice(0, 5).map(label) };
  }
  if (!who) return id && "ambiguous" in id ? { why: "O histórico do banco serve para mais de um parceiro", hypotheses: id.ambiguous.slice(0, 5) } : null;
  const mine = all.filter((n) => n.doc === who.doc);
  let acc = Dec.ZERO;
  for (let k = 0; k < mine.length; k++) {
    acc = acc.add(mine[k]!.net);
    const c = acc.cmp(value);
    if (c === 0 && k >= 1) return { notes: mine.slice(0, k + 1), who, grouped: true };
    if (c > 0) break;
  }
  const open = mine.reduce((s, n) => s.add(n.net), Dec.ZERO);
  return mine.length
    ? { why: `${role === "TOMADA" ? "Pagamento a" : "Recebimento de"} ${who.name ?? who.doc}: valor não fecha com as notas em aberto (${mine.length} nota(s), ${brl(open.toFixed(2))})`, hypotheses: mine.slice(0, 5).map(label) }
    : { why: `${role === "TOMADA" ? "Pagamento a" : "Recebimento de"} ${who.name ?? who.doc} sem NFS-e em aberto`, hypotheses: [] };
}

// ------------------------------------------------------------------ extrato → razão

interface Movement { id: string; posted_on: string; amount: string; memo: string | null; payee: string | null; account_code: string; label: string }

export interface PendingMovement extends Movement { reason: string; hypotheses: string[] }

async function federalPaymentLines(ctx: Ctx, m: Movement): Promise<{ lines: EntryLine[]; ref: string; doc: string } | { why: string; hypotheses: string[] } | null> {
  const value = Dec.of(m.amount).mul("-1").toFixed(2);
  const cand = await ctx.tx.query<{ id: string; document_number: string; collected_on: string; revenue_code: string; breakdown: Record<string, string>[] }>(
    `SELECT p.id, p.document_number, p.collected_on::text, p.revenue_code, p.breakdown FROM federal_payment p
      WHERE p.entity_id = $1 AND p.amount_total = $2 AND p.collected_on BETWEEN $3 AND $4
        AND NOT EXISTS (SELECT 1 FROM bank_match b WHERE b.method = 'PAGAMENTO_FEDERAL' AND b.reference = p.id::text)
      ORDER BY abs(p.collected_on - $5::date)`,
    [ctx.entityId, value, addDays(m.posted_on, -3), addDays(m.posted_on, 3), m.posted_on],
  );
  if (!cand.rows.length) return null;
  const same = cand.rows.filter((c) => c.collected_on === m.posted_on);
  const pick = same.length === 1 ? same[0]! : cand.rows.length === 1 ? cand.rows[0]! : null;
  if (!pick) return { why: `${cand.rows.length} pagamentos federais com o mesmo valor perto dessa data`, hypotheses: cand.rows.map((c) => `DARF ${c.document_number} pago em ${c.collected_on}`) };
  const lines: EntryLine[] = [];
  let extra = Dec.ZERO;
  const items = pick.breakdown?.length ? pick.breakdown : [{ revenueCode: pick.revenue_code, principal: value, revenueDescription: "" }];
  for (const it of items) {
    const acc = federalItemAccount(it.revenueCode ?? pick.revenue_code, it.revenueDescription ?? null);
    if (!acc) return { why: `Item do DARF sem conta definida: ${it.revenueCode ?? ""} ${it.revenueDescription ?? ""}`.trim(), hypotheses: [`DARF ${pick.document_number}`] };
    const principal = Dec.of(it.principal ?? "0");
    if (principal.gt("0")) lines.push({ account: acc, debit: principal.toFixed(2), history: `${it.revenueCode ?? ""} ${it.revenueDescription ?? ""} ${it.competence ? `(${it.competence.slice(5, 7)}/${it.competence.slice(0, 4)})` : ""}`.trim() });
    extra = extra.add(it.fine ?? "0").add(it.interest ?? "0");
  }
  if (extra.gt("0")) lines.push({ account: "4.4.1.02", debit: extra.toFixed(2), history: "Multa e juros de mora" });
  const sum = lines.reduce((a, l) => a.add(l.debit!), Dec.ZERO);
  if (sum.cmp(value) !== 0) return { why: `Itens do DARF (${brl(sum.toFixed(2))}) não somam o valor pago (${brl(value)})`, hypotheses: [`DARF ${pick.document_number}`] };
  lines.push({ account: m.account_code, credit: value });
  return { lines, ref: pick.id, doc: pick.document_number };
}

async function ruleFor(ctx: Ctx, m: Movement) {
  const text = normalize(`${m.memo ?? ""} ${m.payee ?? ""}`);
  const dir = Dec.of(m.amount).gt("0") ? "ENTRADA" : "SAIDA";
  const { rows } = await ctx.tx.query<{ id: string; pattern: string; account_code: string; history: string; entity_id: string | null }>(
    `SELECT id, pattern, account_code, history, entity_id FROM bank_rule
      WHERE (entity_id = $1 OR entity_id IS NULL) AND direction IN ($2, 'AMBOS')
        AND valid_from <= $3 AND (valid_to IS NULL OR valid_to >= $3)`,
    [ctx.entityId, dir, m.posted_on],
  );
  const hits = rows.filter((r) => text.includes(normalize(r.pattern)));
  if (!hits.length) return null;
  // mais específica: da própria empresa antes do escritório; depois o padrão mais longo
  hits.sort((a, b) => Number(Boolean(b.entity_id)) - Number(Boolean(a.entity_id)) || b.pattern.length - a.pattern.length);
  const best = hits[0]!;
  const tie = hits.filter((h) => Boolean(h.entity_id) === Boolean(best.entity_id) && normalize(h.pattern).length === normalize(best.pattern).length && h.account_code !== best.account_code);
  if (tie.length) return { why: "Duas regras de histórico servem e apontam para contas diferentes", hypotheses: [best, ...tie].map((h) => `"${h.pattern}" → ${h.account_code}`) };
  return best;
}

async function bankMovements(ctx: Ctx, s: Stats, pending: PendingMovement[]) {
  const { rows } = await ctx.tx.query<Movement>(
    `SELECT t.id, t.posted_on::text, t.amount::text, t.memo, t.payee, c.code AS account_code, b.label
       FROM bank_transaction t JOIN bank_account b ON b.id = t.bank_account_id JOIN chart_account c ON c.id = b.ledger_account_id
      WHERE t.entity_id = $1 AND t.posted_on >= $2
        AND NOT EXISTS (SELECT 1 FROM bank_match m JOIN journal_entry e ON e.id = m.entry_id
                         WHERE m.transaction_id = t.id AND NOT EXISTS (SELECT 1 FROM journal_entry x WHERE x.reverses_id = e.id))
      ORDER BY t.posted_on, t.id`,
    [ctx.entityId, ctx.start],
  );
  const link = (txId: string, entryId: string, method: string, reference: string | null) =>
    ctx.tx.query(
      "INSERT INTO bank_match (id, tenant_id, entity_id, transaction_id, entry_id, method, reference) VALUES ($1, current_tenant(), $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING",
      [newId(), ctx.entityId, txId, entryId, method, reference],
    );
  for (const m of rows) {
    const out = Dec.of(m.amount).cmp("0") < 0;
    const value = Dec.of(m.amount).mul(out ? "-1" : "1").toFixed(2);
    const memo = [m.memo, m.payee].filter(Boolean).join(" · ") || "movimento bancário";
    const base = { entityId: ctx.entityId, date: m.posted_on, origin: "BANCO" as const, originRef: `bank_transaction:${m.id}`, idempotencyKey: `banco:${m.id}`,
      evidence: [{ kind: "bank_transaction", id: m.id }] };
    const notes: { why: string; hypotheses: string[] }[] = [];

    if (out) {
      const f = await federalPaymentLines(ctx, m);
      if (f && "lines" in f) {
        const r = await post(ctx, s, { ...base, history: `Pagamento DARF/DAS ${f.doc} — ${memo}`, lines: f.lines, confidence: "1", evidence: [...base.evidence, { kind: "federal_payment", id: f.ref }] });
        await link(m.id, r.id, "PAGAMENTO_FEDERAL", f.ref);
        continue;
      }
      if (f) notes.push(f);
      const tp = await matchNotes(ctx, m, "TOMADA");
      if (tp && "notes" in tp) {
        const ns = tp.notes;
        const r = await post(ctx, s, { ...base, confidence: "1",
          history: ns.length === 1
            ? `Pagamento da NFS-e nº ${ns[0]!.number ?? "—"} (${ns[0]!.name ?? "fornecedor"}) — ${memo}`
            : `Pagamento de ${ns.length} NFS-e de ${ns[0]!.name ?? "fornecedor"} (nº ${ns.map((n) => n.number ?? "—").join(", ")}) — ${memo}`,
          evidence: [...base.evidence, ...ns.map((n) => ({ kind: "nfse_document", id: n.id }))],
          lines: [...ns.map((n): EntryLine => ({ account: "2.1.1.01", debit: Dec.of(n.net).toFixed(2), history: `NFS-e nº ${n.number ?? "—"}`, dimensions: partner(n.doc, n.name) })), { account: m.account_code, credit: value }] });
        for (const n of ns) await link(m.id, r.id, "NFSE_TOMADA", n.id);
        if (ns[0]!.doc && (!tp.who || tp.who.via === "NOME") && !tp.grouped) await learnAlias(ctx.tx, ctx.entityId, ns[0]!.doc, "FORNECEDOR", memo, m.id, m.posted_on, ctx.actor);
        continue;
      }
      if (tp) notes.push(tp);
    } else {
      const n = await matchNotes(ctx, m, "PRESTADA");
      if (n && "notes" in n) {
        const ns = n.notes;
        const r = await post(ctx, s, { ...base, confidence: "1",
          history: ns.length === 1
            ? `Recebimento da NFS-e nº ${ns[0]!.number ?? "—"} (${ns[0]!.name ?? "tomador"}) — ${memo}`
            : `Recebimento de ${ns.length} NFS-e de ${ns[0]!.name ?? "tomador"} (nº ${ns.map((x) => x.number ?? "—").join(", ")}) — ${memo}`,
          evidence: [...base.evidence, ...ns.map((x) => ({ kind: "nfse_document", id: x.id }))],
          lines: [{ account: m.account_code, debit: value }, ...ns.map((x): EntryLine => ({ account: "1.1.2.01", credit: Dec.of(x.net).toFixed(2), history: `NFS-e nº ${x.number ?? "—"}`, dimensions: partner(x.doc, x.name) }))] });
        for (const x of ns) await link(m.id, r.id, "NFSE", x.id);
        if (ns[0]!.doc && (!n.who || n.who.via === "NOME") && !n.grouped) await learnAlias(ctx.tx, ctx.entityId, ns[0]!.doc, "CLIENTE", memo, m.id, m.posted_on, ctx.actor);
        continue;
      }
      if (n) notes.push(n);
    }
    const rule = await ruleFor(ctx, m);
    if (rule && "account_code" in rule) {
      try {
        const lines: EntryLine[] = out
          ? [{ account: rule.account_code, debit: value }, { account: m.account_code, credit: value }]
          : [{ account: m.account_code, debit: value }, { account: rule.account_code, credit: value }];
        const r = await post(ctx, s, { ...base, history: `${rule.history} — ${memo}`, rule: `bank_rule:${rule.id}`, confidence: "1", lines });
        await link(m.id, r.id, "REGRA", rule.id);
        continue;
      } catch (err) {
        if (!(err instanceof LedgerError)) throw err;
        notes.push({ why: `Regra "${rule.pattern}" aponta para ${rule.account_code}: ${err.message}`, hypotheses: [] });
      }
    } else if (rule) notes.push(rule);
    s.pending++;
    pending.push({
      ...m,
      reason: notes.map((x) => x.why).join("; ") || (out ? "Saída sem DARF, regra ou documento correspondente" : "Entrada sem nota ou regra correspondente"),
      hypotheses: notes.flatMap((x) => x.hypotheses),
    });
  }
}

// ------------------------------------------------------------------ execução

export interface AutoPostingResult {
  entityId: string;
  skipped: string | null;
  posted: number;
  reversed: number;
  pendingFiscal: number;
  pendingBank: number;
}

/** Roda os três passos para a empresa. Sem plano de contas, não lança nada. */
export async function runAutoPosting(pool: Pool, tenantId: string, entityId: string, actor: Actor = LEDGER_ENGINE): Promise<AutoPostingResult> {
  return withTenant(pool, tenantId, async (tx) => {
    const start = await chartStart(tx, entityId);
    if (!start) return { entityId, skipped: "sem plano de contas", posted: 0, reversed: 0, pendingFiscal: 0, pendingBank: 0 };
    await syncPartners(tx, entityId);
    const ctx: Ctx = { tx, entityId, start, actor };
    const fiscal: Stats = { posted: 0, reversed: 0, pending: 0, total: Dec.ZERO, dates: [] };
    await nfseRevenue(ctx, fiscal);
    await simplesProvision(ctx, fiscal);
    const takenPending: PendingTaken[] = [];
    await nfseExpenses(ctx, fiscal, takenPending);
    const bank: Stats = { posted: 0, reversed: 0, pending: 0, total: Dec.ZERO, dates: [] };
    const pending: PendingMovement[] = [];
    await bankMovements(ctx, bank, pending);
    const posted = fiscal.posted + bank.posted;
    const reversed = fiscal.reversed + bank.reversed;
    if (posted || reversed) {
      const dates = [...fiscal.dates, ...bank.dates].sort();
      await appendEvent(tx, {
        type: "ACCOUNTING_BATCH_POSTED",
        schemaVersion: 1,
        producer: PRODUCER,
        idempotencyKey: `lote:${entityId}:${newId()}`,
        entityId,
        payload: {
          entity_id: entityId, entries: posted, reversed, fiscal: fiscal.posted, bank: bank.posted, total: fiscal.total.add(bank.total).toFixed(2),
          from: dates[0] ?? null, to: dates[dates.length - 1] ?? null, pending_bank: bank.pending, rules: AUTO_POSTING_RULES,
        },
      });
    }
    return { entityId, skipped: null, posted, reversed, pendingFiscal: fiscal.pending, pendingBank: bank.pending };
  });
}

/** Movimentos do extrato que esperam uma pessoa, com o motivo e as hipóteses. */
export async function pendingMovements(pool: Pool, tenantId: string, entityId: string): Promise<PendingMovement[]> {
  // Mesma lógica do motor, numa transação que é desfeita: nada é gravado.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const start = await chartStart(client, entityId);
    if (!start) return [];
    const pending: PendingMovement[] = [];
    await bankMovements({ tx: client, entityId, start, actor: LEDGER_ENGINE }, { posted: 0, reversed: 0, pending: 0, total: Dec.ZERO, dates: [] }, pending);
    return pending;
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

/** Decisão humana sobre um movimento: lança na conta escolhida e, se pedido, cria a regra para os próximos. */
export async function classifyMovement(
  pool: Pool,
  tenantId: string,
  input: { transactionId: string; account: string; history: string; rule?: { pattern: string; scope: "EMPRESA" | "ESCRITORIO" } | null },
  actor: Actor,
) {
  if (actor.kind !== "USER") throw new LedgerError("Classificação de movimento sem regra é decisão de uma pessoa");
  const r = await withTenant(pool, tenantId, async (tx) => {
    const m = await tx.query<Movement & { entity_id: string }>(
      `SELECT t.id, t.entity_id, t.posted_on::text, t.amount::text, t.memo, t.payee, c.code AS account_code, b.label
         FROM bank_transaction t JOIN bank_account b ON b.id = t.bank_account_id JOIN chart_account c ON c.id = b.ledger_account_id
        WHERE t.id = $1`,
      [input.transactionId],
    );
    const mv = m.rows[0];
    if (!mv) throw new LedgerError("Movimento não encontrado ou conta bancária sem conta contábil");
    const out = Dec.of(mv.amount).cmp("0") < 0;
    const value = Dec.of(mv.amount).mul(out ? "-1" : "1").toFixed(2);
    const lines: EntryLine[] = out
      ? [{ account: input.account, debit: value }, { account: mv.account_code, credit: value }]
      : [{ account: mv.account_code, debit: value }, { account: input.account, credit: value }];
    const e = await postEntry(tx, {
      entityId: mv.entity_id, date: mv.posted_on, origin: "BANCO", originRef: `bank_transaction:${mv.id}`, idempotencyKey: `banco:${mv.id}`,
      history: `${input.history} — ${[mv.memo, mv.payee].filter(Boolean).join(" · ")}`, evidence: [{ kind: "bank_transaction", id: mv.id }], lines, confidence: "1",
    }, actor);
    await tx.query(
      "INSERT INTO bank_match (id, tenant_id, entity_id, transaction_id, entry_id, method, reference) VALUES ($1, current_tenant(), $2, $3, $4, 'PESSOA', $5) ON CONFLICT DO NOTHING",
      [newId(), mv.entity_id, mv.id, e.id, actor.id],
    );
    if (input.rule) {
      const ruleId = newId();
      await tx.query(
        `INSERT INTO bank_rule (id, tenant_id, entity_id, pattern, direction, account_code, history, valid_from, created_by)
         VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8)`,
        [ruleId, input.rule.scope === "EMPRESA" ? mv.entity_id : null, input.rule.pattern.trim(), out ? "SAIDA" : "ENTRADA", input.account, input.history, `${mv.posted_on.slice(0, 7)}-01`, actor.id],
      );
      await audit(tx, { actor, action: "ledger.bank_rule_created", resourceType: "bank_rule", resourceId: ruleId, entityId: mv.entity_id,
        data: { pattern: input.rule.pattern, scope: input.rule.scope, account: input.account, from_transaction: mv.id } });
    }
    return { entryId: e.id, entityId: mv.entity_id, rule: Boolean(input.rule) };
  });
  // A regra nova já vale para os outros movimentos parecidos.
  const after = r.rule ? await runAutoPosting(pool, tenantId, r.entityId) : null;
  return { ...r, alsoPosted: after?.posted ?? 0 };
}

/** NFS-e tomadas que esperam uma pessoa (sem conta ou a conferir). Não grava nada. */
export async function pendingTaken(pool: Pool, tenantId: string, entityId: string): Promise<PendingTaken[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const start = await chartStart(client, entityId);
    if (!start) return [];
    const pending: PendingTaken[] = [];
    await nfseExpenses({ tx: client, entityId, start, actor: LEDGER_ENGINE }, { posted: 0, reversed: 0, pending: 0, total: Dec.ZERO, dates: [] }, pending);
    return pending;
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

/** Decisão humana: as notas deste fornecedor vão para a conta escolhida (na empresa ou no escritório). */
export async function classifySupplier(
  pool: Pool,
  tenantId: string,
  input: { entityId: string; supplierDoc: string; account: string; history: string; scope: "EMPRESA" | "ESCRITORIO" },
  actor: Actor,
) {
  if (actor.kind !== "USER") throw new LedgerError("Conta do fornecedor é decisão de uma pessoa");
  if (!/^[0-9A-Z]{11,14}$/.test(input.supplierDoc)) throw new LedgerError("CNPJ/CPF do fornecedor inválido");
  await withTenant(pool, tenantId, async (tx) => {
    const acc = await tx.query("SELECT 1 FROM chart_account WHERE entity_id = $1 AND code = $2 AND analytic AND valid_to IS NULL", [input.entityId, input.account]);
    if (!acc.rowCount) throw new LedgerError(`Conta ${input.account} não é analítica no plano da empresa`);
    const start = await chartStart(tx, input.entityId);
    const id = newId();
    await tx.query(
      `INSERT INTO supplier_rule (id, tenant_id, entity_id, supplier_doc, account_code, history, valid_from, created_by)
       VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7)`,
      [id, input.scope === "EMPRESA" ? input.entityId : null, input.supplierDoc, input.account, input.history.trim() || "Serviço tomado", start ?? "2000-01-01", actor.id],
    );
    await audit(tx, { actor, action: "ledger.supplier_rule_created", resourceType: "supplier_rule", resourceId: id, entityId: input.entityId,
      data: { supplier: input.supplierDoc, account: input.account, scope: input.scope } });
  });
  return runAutoPosting(pool, tenantId, input.entityId);
}

/** Aprovação da tabela tipo de serviço → conta (decisão de pessoa). */
export async function approveTakenServicesRule(pool: Pool, tenantId: string, actor: Actor) {
  if (actor.kind !== "USER") throw new LedgerError("Só uma pessoa aprova regra de contabilização");
  await withTenant(pool, tenantId, async (tx) => {
    const ins = await tx.query(
      "INSERT INTO accounting_rule_approval (id, tenant_id, rule_set, approved_by) VALUES ($1, current_tenant(), $2, $3) ON CONFLICT DO NOTHING",
      [newId(), TAKEN_SERVICES_RULE, actor.id],
    );
    if (!ins.rowCount) return;
    await appendEvent(tx, {
      type: "ACCOUNTING_RULES_APPROVED",
      schemaVersion: 1,
      producer: { kind: "user", name: actor.id, version: "1" },
      idempotencyKey: `regra-contabil:${TAKEN_SERVICES_RULE}`,
      payload: { rule_set: TAKEN_SERVICES_RULE, approved_by: actor.id },
    });
    await audit(tx, { actor, action: "ledger.rule_approved", resourceType: "accounting_rule_approval", resourceId: TAKEN_SERVICES_RULE, ruleRef: TAKEN_SERVICES_RULE, approvedBy: actor.id });
  });
  const ents = await withTenant(pool, tenantId, (tx) => tx.query<{ id: string }>("SELECT DISTINCT entity_id AS id FROM chart_account"));
  let posted = 0;
  for (const e of ents.rows) posted += (await runAutoPosting(pool, tenantId, e.id)).posted;
  return { approved: true, posted };
}

export async function takenRuleStatus(tx: PoolClient) {
  const r = await tx.query<{ approved_by: string; approved_at: Date }>("SELECT approved_by, approved_at FROM accounting_rule_approval WHERE rule_set = $1", [TAKEN_SERVICES_RULE]);
  return r.rows[0] ?? null;
}

