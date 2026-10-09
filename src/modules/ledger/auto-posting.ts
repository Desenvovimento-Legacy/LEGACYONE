import type { Pool, PoolClient } from "pg";
import { bankName } from "../../integrations/bank/ofx.js";
import { NFSE_TAX_PARSER } from "../../integrations/nfse/nfse-taxes.js";
import { audit } from "../../platform/audit/audit.js";
import { appendEvent, type Producer } from "../../platform/events/outbox.js";
import type { Actor } from "../../shared/actor.js";
import { Dec } from "../../shared/decimal.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";
import { normalize } from "../../shared/text.js";
import { identifyPartner, learnAlias, loadPartnerIndex, nameKey, syncPartners, type IdentifiedPartner, type PartnerIndex } from "./partners.js";
import { addAccount, ensureStandardAccounts, LedgerError, lockedCompetences, postEntry, reverseEntry, type EntryLine } from "./ledger.js";
import { serviceAccount, TAKEN_SERVICES_RULE } from "./service-accounts.js";
import { BUILTIN_CONFIG, chartConfig, roleAccount, type ChartConfig, type Role } from "./chart-config.js";

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
/**
 * Receita com retenção sofrida (o tomador reteve): D Clientes (líquido),
 * D IRRF/CSRF/INSS a recuperar, D ISS retido na fonte (dedução), C Receita (bruto).
 * Só vale depois de aprovada por uma pessoa.
 */
export const REVENUE_RETENTIONS_RULE = "receita-retencoes@1";
/**
 * Movimentos típicos do banco, pelo histórico: aplicação e resgate automáticos
 * (conta de aplicação daquele banco), rendimento (receita de aplicação) e
 * tarifa bancária. Só vale depois de aprovada por uma pessoa.
 */
export const BANK_STANDARD_RULE = "extrato-padrao@1";
/**
 * Pagamento sem nota fiscal (regra do responsável técnico): saída do banco que
 * não é tributo, transferência, aplicação, tarifa, fatura de cartão, empréstimo
 * nem pagamento a sócio, e cujo favorecido não tem NFS-e no período, é lançada
 * em Outras Despesas Operacionais (a conta é criada no padrão do plano se não
 * existir). Se a nota do fornecedor chegar depois, o lançamento é estornado e o
 * pagamento passa a baixar Fornecedores.
 */
export const NO_NOTE_RULE = "sem-nota@1";
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
export function federalItemRole(code: string | null, description: string | null): Role | null {
  const c = (code ?? "").replace(/\D/g, "").slice(0, 4);
  const d = normalize(description);
  if (c === "3333" || (/SIMPLES NACIONAL/.test(d) && !/CONCOMITANTE|SIMPLES CONC/.test(d))) return "SIMPLES_RECOLHER";
  if (["1708", "8045", "3280"].includes(c) || /IRRF.*PESSOA JURIDICA/.test(d)) return "IRRF_RET_RECOLHER";
  if (["5952", "5979", "5960", "5987"].includes(c) || /RETENCAO.*(PIS|COFINS|CSLL)|CSRF/.test(d)) return "CSRF_RET_RECOLHER";
  if (c === "0561" || /IRRF.*TRABALHO ASSALARIADO/.test(d)) return "IRRF_FOLHA_RECOLHER";
  if (c === "0588" || /IRRF.*SEM VINCULO/.test(d)) return "IRRF_RET_RECOLHER";
  if (/CONTRIBUICAO PREVIDENCIARIA|CONTRIB(UICAO)? EMPRESA|^CP |\bRAT\b|TERCEIROS/.test(d) || ["1082", "1099", "1138", "1646", "1170", "1176", "1191", "1196", "1200"].includes(c)) return "INSS_RECOLHER";
  return null;
}

/** Conta do item do DARF no plano (embutido por padrão). Nulo = não sei: fica para pessoa. */
export function federalItemAccount(code: string | null, description: string | null, cfg: ChartConfig = BUILTIN_CONFIG): string | null {
  const r = federalItemRole(code, description);
  return r ? cfg.roles[r] ?? null : null;
}

interface Ctx {
  tx: PoolClient; entityId: string; start: string; actor: Actor; partners?: PartnerIndex; locked: Set<string>;
  revenueRule: boolean; bankStdRule: boolean; noNoteRule: boolean; cfg: ChartConfig; acc: (r: Role) => string;
}

/** Parceiro (cliente ou fornecedor) gravado na linha: base de razão auxiliar e contas em aberto. */
const partner = (doc: string | null, name: string | null): Record<string, string> => {
  const d: Record<string, string> = {};
  if (doc) d.parceiro_doc = doc;
  if (name) d.parceiro = name.slice(0, 120);
  return d;
};
interface Stats { posted: number; reversed: number; pending: number; locked: number; total: Dec; dates: string[] }
const newStats = (): Stats => ({ posted: 0, reversed: 0, pending: 0, locked: 0, total: Dec.ZERO, dates: [] });
const compOf = (date: string) => `${date.slice(0, 7)}-01`;

async function makeCtx(tx: PoolClient, entityId: string, start: string, actor: Actor): Promise<Ctx> {
  const cfg = await chartConfig(tx, entityId);
  return { tx, entityId, start, actor, locked: await lockedCompetences(tx, entityId), revenueRule: await ruleApproved(tx, REVENUE_RETENTIONS_RULE),
    bankStdRule: await ruleApproved(tx, BANK_STANDARD_RULE), noNoteRule: await ruleApproved(tx, NO_NOTE_RULE), cfg, acc: (r) => roleAccount(cfg, r) };
}

async function ruleApproved(tx: PoolClient, ruleSet: string): Promise<boolean> {
  const r = await tx.query("SELECT 1 FROM accounting_rule_approval WHERE rule_set = $1", [ruleSet]);
  return Boolean(r.rowCount);
}

async function chartStart(tx: PoolClient, entityId: string): Promise<string | null> {
  const r = await tx.query<{ d: string | null }>("SELECT min(valid_from)::text AS d FROM chart_account WHERE entity_id = $1 AND source <> 'BANCO'", [entityId]);
  return r.rows[0]?.d ?? null;
}

/** Lança; em competência fechada não lança (conta como item em período fechado) e devolve null. */
async function post(ctx: Ctx, s: Stats, input: Parameters<typeof postEntry>[1]) {
  if (ctx.locked.has(compOf(input.date))) {
    const done = await ctx.tx.query("SELECT 1 FROM journal_entry WHERE idempotency_key = $1", [input.idempotencyKey]);
    if (!done.rowCount) s.locked++;
    return null;
  }
  const r = await postEntry(ctx.tx, { ...input, rule: input.rule ?? AUTO_POSTING_RULES }, ctx.actor, { event: false });
  if (r.created) {
    s.posted++;
    s.total = s.total.add(input.lines.reduce((a, l) => a.add(l.debit ?? "0"), Dec.ZERO));
    s.dates.push(input.date);
  }
  return r;
}

/** Estorno na data do original; competência fechada fica para pessoa (reabrir ou estornar no mês aberto). */
async function reverse(ctx: Ctx, s: Stats, entryId: string, reason: string) {
  const e = await ctx.tx.query<{ d: string }>("SELECT entry_date::text AS d FROM journal_entry WHERE id = $1", [entryId]);
  const done = await ctx.tx.query("SELECT 1 FROM journal_entry WHERE reverses_id = $1", [entryId]);
  if (done.rowCount) return;
  if (e.rows[0] && ctx.locked.has(compOf(e.rows[0].d))) {
    s.locked++;
    return;
  }
  if ((await reverseEntry(ctx.tx, entryId, reason, ctx.actor)).created) s.reversed++;
}

// ------------------------------------------------------------------ fiscal → razão

async function nfseRevenue(ctx: Ctx, s: Stats) {
  const { rows } = await ctx.tx.query<{
    id: string; number: string | null; taker: string | null; taker_doc: string | null; issued: string; value: string; key: string | null; withheld: string | null; cancelled: boolean;
    irrf: string; csrf: string; cp: string; iss: string; read_check: string | null;
  }>(
    `WITH cancelled AS (
       SELECT DISTINCT access_key FROM nfse_document
        WHERE entity_id = $1 AND role = 'EVENTO' AND access_key IS NOT NULL
          AND (event_type ILIKE '%101101%' OR event_type ILIKE '%105102%' OR event_type ILIKE '%cancel%'))
     SELECT d.id, d.number, coalesce(d.taker_name, d.taker_doc) AS taker, d.taker_doc,
            to_char(d.issued_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS issued, d.service_value::text AS value, d.access_key AS key,
            t.total_withheld_calc::text AS withheld,
            coalesce(t.irrf, 0)::text AS irrf, coalesce(t.csrf, 0)::text AS csrf, coalesce(t.cp, 0)::text AS cp, coalesce(t.iss_withheld, 0)::text AS iss, t.read_check,
            d.access_key IS NOT NULL AND d.access_key IN (SELECT access_key FROM cancelled) AS cancelled
       FROM nfse_document d LEFT JOIN nfse_tax t ON t.nfse_id = d.id AND t.parser = $3
      WHERE d.entity_id = $1 AND d.role = 'PRESTADA' AND d.service_value > 0
        AND (d.issued_at AT TIME ZONE 'America/Sao_Paulo')::date >= $2
      ORDER BY d.issued_at`,
    [ctx.entityId, ctx.start, NFSE_TAX_PARSER],
  );
  for (const n of rows) {
    const key = `nfse:${n.id}`;
    if (n.cancelled) {
      const e = await ctx.tx.query<{ id: string }>("SELECT id FROM journal_entry WHERE idempotency_key = $1", [key]);
      if (e.rows[0]) await reverse(ctx, s, e.rows[0].id, "NFS-e cancelada");
      continue;
    }
    const lines: EntryLine[] = [{ account: ctx.acc("CLIENTES"), debit: n.value, dimensions: partner(n.taker_doc, n.taker) }, { account: ctx.acc("RECEITA_SERVICOS"), credit: n.value }];
    if (n.withheld !== null && Dec.of(n.withheld).gt("0")) {
      // Retenção sofrida (tomador reteve): só com a regra aprovada e com a leitura da nota conferida.
      if (!ctx.revenueRule || n.read_check === "DIVERGENTE") {
        const done = await ctx.tx.query("SELECT 1 FROM journal_entry WHERE idempotency_key = $1", [key]);
        if (!done.rowCount) s.pending++;
        continue;
      }
      const net = Dec.of(n.value).sub(n.withheld);
      if (!net.gt("0")) { s.pending++; continue; }
      const dim = partner(n.taker_doc, n.taker);
      lines.splice(0, 1, { account: ctx.acc("CLIENTES"), debit: net.toFixed(2), dimensions: dim });
      const add = (account: string, v: string, history: string) => { if (Dec.of(v).gt("0")) lines.splice(lines.length - 1, 0, { account, debit: Dec.of(v).toFixed(2), history, dimensions: dim }); };
      add(ctx.acc("IRRF_RECUPERAR"), n.irrf, "IRRF retido pelo tomador");
      add(ctx.acc("CSRF_RECUPERAR"), n.csrf, "PIS/COFINS/CSLL retidos pelo tomador");
      add(ctx.acc("INSS_RECUPERAR"), n.cp, "INSS retido pelo tomador");
      add(ctx.acc("ISS_RETIDO_DEDUCAO"), n.iss, "ISS retido pelo tomador");
    }
    await post(ctx, s, {
      entityId: ctx.entityId, date: n.issued, origin: "FISCAL", originRef: `nfse_document:${n.id}`, idempotencyKey: key,
      history: `NFS-e nº ${n.number ?? "—"} prestada a ${n.taker ?? "tomador"}`,
      evidence: [{ kind: "nfse_document", id: n.id }], confidence: "1",
      rule: Dec.of(n.withheld ?? "0").gt("0") ? REVENUE_RETENTIONS_RULE : undefined,
      lines,
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
    for (const p of prev.rows) await reverse(ctx, s, p.id, `substituída: ${b.history}`);
    if (done.rows[0]?.total) continue;
    await post(ctx, s, {
      entityId: ctx.entityId, date: lastDay(b.competence), origin: "TRIBUTOS", originRef: b.ref, idempotencyKey: b.key,
      history: b.history, evidence: [b.evidence], confidence: "1",
      lines: [{ account: ctx.acc("SIMPLES_DEDUCAO"), debit: b.total }, { account: ctx.acc("SIMPLES_RECOLHER"), credit: b.total }],
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
      if (e.rows[0]) await reverse(ctx, s, e.rows[0].id, "NFS-e tomada cancelada");
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
    const proposed = approved ? serviceAccount(n.code, ctx.cfg) : null;
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
    const lines: EntryLine[] = [{ account, debit: Dec.of(n.value).toFixed(2), dimensions: dim }, { account: ctx.acc("FORNECEDORES"), credit: net.toFixed(2), dimensions: dim }];
    if (Dec.of(ret.irrf).gt("0")) lines.push({ account: ctx.acc("IRRF_RET_RECOLHER"), credit: Dec.of(ret.irrf).toFixed(2), history: "IRRF retido", dimensions: dim });
    if (Dec.of(ret.csrf).gt("0")) lines.push({ account: ctx.acc("CSRF_RET_RECOLHER"), credit: Dec.of(ret.csrf).toFixed(2), history: "PIS/COFINS/CSLL retidos", dimensions: dim });
    if (Dec.of(ret.iss).gt("0")) lines.push({ account: ctx.acc("ISS_RET_RECOLHER"), credit: Dec.of(ret.iss).toFixed(2), history: "ISS retido", dimensions: dim });
    if (Dec.of(ret.cp).gt("0")) lines.push({ account: ctx.acc("INSS_RET_RECOLHER"), credit: Dec.of(ret.cp).toFixed(2), history: "INSS retido", dimensions: dim });
    try {
      await post(ctx, s, {
        entityId: ctx.entityId, date: n.issued, origin: "FISCAL", originRef: `nfse_document:${n.id}`, idempotencyKey: key,
        history: `${byRule ? byRule.history : "Serviço tomado"} — NFS-e nº ${n.number ?? "—"} de ${n.supplier ?? n.doc ?? "prestador"}`,
        rule: byRule ? `supplier_rule:${byRule.id}` : TAKEN_SERVICES_RULE, confidence: "1",
        evidence: [{ kind: "nfse_document", id: n.id }], lines,
      });
      // Pagamento já lançado como "sem nota" para este fornecedor e valor: a nota chegou, estorna; o extrato volta a casar com Fornecedores.
      {
        // pelo CNPJ do fornecedor gravado no pagamento; sem ele, pelo nome do fornecedor no histórico do banco
        const key = nameKey(n.supplier);
        const paid = await ctx.tx.query<{ id: string; history: string; doc: string | null }>(
          `SELECT e.id, e.history, l.dimensions->>'parceiro_doc' AS doc FROM journal_entry e JOIN journal_line l ON l.entry_id = e.id
            WHERE e.entity_id = $1 AND e.rule_ref = $2 AND l.debit = $3 AND e.entry_date BETWEEN $4 AND $5
              AND NOT EXISTS (SELECT 1 FROM journal_entry x WHERE x.reverses_id = e.id)
            ORDER BY e.entry_date`,
          [ctx.entityId, NO_NOTE_RULE, net.toFixed(2), addDays(n.issued, -60), addDays(n.issued, 120)],
        );
        const hit = paid.rows.find((p) => n.doc && p.doc === n.doc)
          ?? paid.rows.find((p) => !p.doc && key && ` ${normalize(p.history).replace(/[^A-Z0-9 ]/g, " ")} `.includes(` ${key} `));
        if (hit) await reverse(ctx, s, hit.id, `chegou a NFS-e nº ${n.number ?? "—"} do fornecedor: o pagamento baixa Fornecedores`);
      }
    } catch (err) {
      if (!(err instanceof LedgerError)) throw err;
      miss(err.message);
    }
  }
}

interface OpenNote { id: string; number: string | null; name: string | null; doc: string | null; issued: string; net: string }
type Why = { why: string; hypotheses: string[]; soft?: boolean; partnerDoc?: string; partnerName?: string | null };
type NoteMatch = { notes: OpenNote[]; who: IdentifiedPartner | null; grouped: boolean } | Why | null;

/** NFS-e (tomadas ou emitidas) já contabilizadas, ainda sem pagamento/recebimento no extrato, de 120 dias antes a 60 dias depois do movimento (pagamento antes da nota). */
async function openNotes(ctx: Ctx, role: "TOMADA" | "PRESTADA", until: string): Promise<OpenNote[]> {
  const sql = role === "TOMADA"
    ? `SELECT d.id, d.number, d.provider_name AS name, d.provider_doc AS doc, to_char(d.issued_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS issued,
              (SELECT sum(l.credit) FROM journal_line l JOIN chart_account c ON c.id = l.account_id WHERE l.entry_id = e.id AND c.code = $4)::text AS net
         FROM nfse_document d
         JOIN journal_entry e ON e.idempotency_key = 'nfse-tomada:' || d.id::text
        WHERE d.entity_id = $1 AND d.role = 'TOMADA' AND (d.issued_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2 AND $3
          AND NOT EXISTS (SELECT 1 FROM journal_entry x WHERE x.reverses_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM bank_match b WHERE b.method = 'NFSE_TOMADA' AND b.reference = d.id::text)
        ORDER BY d.issued_at, d.number`
    : `SELECT d.id, d.number, coalesce(d.taker_name, d.taker_doc) AS name, d.taker_doc AS doc, to_char(d.issued_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS issued,
              (SELECT sum(l.debit) FROM journal_line l JOIN chart_account c ON c.id = l.account_id WHERE l.entry_id = e.id AND c.code = $4)::text AS net
         FROM nfse_document d JOIN journal_entry e ON e.idempotency_key = 'nfse:' || d.id::text
        WHERE d.entity_id = $1 AND d.role = 'PRESTADA' AND (d.issued_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2 AND $3
          AND NOT EXISTS (SELECT 1 FROM journal_entry x WHERE x.reverses_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM bank_match b WHERE b.method = 'NFSE' AND b.reference = d.id::text)
        ORDER BY d.issued_at, d.number`;
  const { rows } = await ctx.tx.query<OpenNote>(sql, [ctx.entityId, addDays(until, -120), addDays(until, 60), ctx.acc(role === "TOMADA" ? "FORNECEDORES" : "CLIENTES")]);
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
      // mesmo parceiro, mesmo valor: quita a nota mais antiga em aberto (FIFO)
      if (mine.length >= 1) return { notes: [mine[0]!], who, grouped: false };
      if (who.via !== "NOME") return { why: `O banco indica ${who.name ?? who.doc}, mas a NFS-e com esse valor é de outro parceiro`, hypotheses: byValue.slice(0, 5).map(label) };
    }
    if (byValue.length === 1) return { notes: byValue, who: null, grouped: false };
    if (byValue[0]!.doc && byValue.every((n) => n.doc === byValue[0]!.doc)) return { notes: [byValue[0]!], who: null, grouped: false };
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
    : role === "TOMADA" && (await partnerHasNotes(ctx, who.doc, m.posted_on))
      ? { why: `Pagamento a ${who.name ?? who.doc}: tem NFS-e no período ainda não lançada`, hypotheses: [] }
      : { why: `${role === "TOMADA" ? "Pagamento a" : "Recebimento de"} ${who.name ?? who.doc} sem NFS-e em aberto`, hypotheses: [], soft: true, partnerDoc: who.doc, partnerName: who.name };
}

// ------------------------------------------------------------------ extrato → razão

interface Movement { id: string; posted_on: string; amount: string; memo: string | null; payee: string | null; account_code: string; label: string; bank_account_id: string; bank_code: string | null }

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
  let fine = Dec.ZERO;
  let interest = Dec.ZERO;
  const items = pick.breakdown?.length ? pick.breakdown : [{ revenueCode: pick.revenue_code, principal: value, revenueDescription: "" }];
  for (const it of items) {
    const acc = federalItemAccount(it.revenueCode ?? pick.revenue_code, it.revenueDescription ?? null, ctx.cfg);
    if (!acc) return { why: `Item do DARF sem conta definida: ${it.revenueCode ?? ""} ${it.revenueDescription ?? ""}`.trim(), hypotheses: [`DARF ${pick.document_number}`] };
    const principal = Dec.of(it.principal ?? "0");
    if (principal.gt("0")) lines.push({ account: acc, debit: principal.toFixed(2), history: `${it.revenueCode ?? ""} ${it.revenueDescription ?? ""} ${it.competence ? `(${it.competence.slice(5, 7)}/${it.competence.slice(0, 4)})` : ""}`.trim() });
    fine = fine.add(it.fine ?? "0");
    interest = interest.add(it.interest ?? "0");
  }
  if (fine.gt("0")) lines.push({ account: ctx.acc("MULTA_MORA"), debit: fine.toFixed(2), history: "Multa de mora" });
  if (interest.gt("0")) lines.push({ account: ctx.acc("JUROS_MORA"), debit: interest.toFixed(2), history: "Juros de mora" });
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

type StdKind = "APLICACAO" | "RESGATE" | "RENDIMENTO" | "TARIFA";
const STD_LABEL: Record<StdKind, string> = { APLICACAO: "Aplicação financeira", RESGATE: "Resgate de aplicação", RENDIMENTO: "Rendimento de aplicação", TARIFA: "Tarifa bancária" };

/** Tipo de movimento típico pelo histórico do banco (determinístico); nulo = não é. */
export function standardKind(memo: string, out: boolean): StdKind | null {
  const t = ` ${normalize(memo).replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ")} `;
  if (!out && / (RENDIMENTO|RENDIMENTOS|RENTAB|REND PAGO) /.test(t)) return "RENDIMENTO";
  if (!out && / (RES|RESG|RESGATE) /.test(t) && / (APLIC|APLICACAO|CDB|INVEST|AUT) /.test(t)) return "RESGATE";
  if (out && / (APL|APLIC|APLICACAO) /.test(t) && !/ (RES|RESGATE) /.test(t)) return "APLICACAO";
  if (out && / (TARIFA|TAR|CESTA|ANUIDADE) /.test(t)) return "TARIFA";
  return null;
}

/** Conta de aplicação do banco do movimento: a do plano com o nome do banco; senão cria debaixo do grupo de aplicações. */
async function applicationAccount(ctx: Ctx, m: Movement): Promise<string> {
  const root = ctx.acc("APLICACOES");
  const r = await ctx.tx.query<{ code: string; name: string; analytic: boolean }>(
    "SELECT code, name, analytic FROM chart_account WHERE entity_id = $1 AND (code = $2 OR parent_code = $2) AND valid_to IS NULL ORDER BY code",
    [ctx.entityId, root],
  );
  const self = r.rows.find((x) => x.code === root);
  if (self?.analytic) return root;
  const bank = normalize(bankName(m.bank_code)).replace(/^BANCO /, "");
  const hit = r.rows.find((x) => x.analytic && x.code !== root && ` ${normalize(x.name)} `.includes(` ${bank} `));
  if (hit) return hit.code;
  const a = await addAccount(ctx.tx, { entityId: ctx.entityId, parent: root, name: `APLICAÇÃO ${m.label}`.toUpperCase().slice(0, 120), validFrom: ctx.start, source: "BANCO" }, ctx.actor);
  return a.code;
}

/** Saídas que não são despesa (tributo, cartão, empréstimo, investimento, devolução): ficam para pessoa. */
const NOT_EXPENSE = /\b(DARF|DAS|GPS|FGTS|GRF|GFD|IMPOSTO|TRIBUT|SIMPLES NACIONAL|RECEITA FEDERAL|SEFAZ|ICMS|IPVA|IPTU|FATURA|CARTAO DE CREDITO|CARTAO CREDITO|EMPRESTIMO|FINANCIAMENTO|CONSORCIO|PARCELA|CDB|INVEST|DEVOLUCAO|ESTORNO)\b/;

/** Primeiros nomes dos sócios (quadro societário): pagamento a sócio não é despesa (pró-labore, lucros, mútuo). */
async function partnerNames(ctx: Ctx): Promise<string[]> {
  const r = await ctx.tx.query<{ name: string }>("SELECT name FROM partner_history WHERE entity_id = $1 AND valid_to IS NULL", [ctx.entityId]);
  return r.rows.map((x) => normalize(x.name).replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean).slice(0, 2).join(" ")).filter((x) => x.includes(" "));
}
function mentionsAny(memo: string, names: string[]): boolean {
  const t = ` ${normalize(memo).replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ")} `;
  return names.some((n) => t.includes(` ${n} `));
}

/** Fornecedor tem NFS-e tomada perto da data ainda não lançada? Então o pagamento espera a nota. */
async function partnerHasNotes(ctx: Ctx, doc: string, date: string): Promise<boolean> {
  const r = await ctx.tx.query(
    `SELECT 1 FROM nfse_document d WHERE d.entity_id = $1 AND d.role = 'TOMADA' AND d.provider_doc = $2
        AND (d.issued_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $3 AND $4
        AND NOT EXISTS (SELECT 1 FROM journal_entry e WHERE e.idempotency_key = 'nfse-tomada:' || d.id::text
                         AND NOT EXISTS (SELECT 1 FROM journal_entry x WHERE x.reverses_id = e.id))
      LIMIT 1`,
    [ctx.entityId, doc, addDays(date, -120), addDays(date, 60)],
  );
  return Boolean(r.rowCount);
}

/** Chave do lançamento do movimento; depois de estorno (ex.: nota chegou), uma chave nova. */
async function bankKey(ctx: Ctx, txId: string): Promise<string> {
  const r = await ctx.tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM journal_entry e WHERE (e.idempotency_key = $1 OR e.idempotency_key LIKE $1 || ':r%')
        AND EXISTS (SELECT 1 FROM journal_entry x WHERE x.reverses_id = e.id)`,
    [`banco:${txId}`],
  );
  const n = r.rows[0]?.n ?? 0;
  return n ? `banco:${txId}:r${n}` : `banco:${txId}`;
}

/** Conta analítica Outras Despesas Operacionais; sem ela, criada no grupo de mesmo nome, no padrão do plano. */
async function otherExpensesAccount(ctx: Ctx): Promise<string | null> {
  if (ctx.cfg.roles.OUTRAS_DESPESAS) return ctx.cfg.roles.OUTRAS_DESPESAS;
  const group = ctx.cfg.roles.OUTRAS_DESPESAS_GRUPO;
  if (!group) return null;
  const a = await addAccount(ctx.tx, { entityId: ctx.entityId, parent: group, name: "OUTRAS DESPESAS OPERACIONAIS", validFrom: ctx.start, source: "PADRAO_ESCRITORIO" }, ctx.actor);
  ctx.cfg = { ...ctx.cfg, roles: { ...ctx.cfg.roles, OUTRAS_DESPESAS: a.code } };
  return a.code;
}

interface OwnIdentity { cnpj: string; name: string | null }
async function ownIdentity(ctx: Ctx): Promise<OwnIdentity> {
  const r = await ctx.tx.query<{ cnpj: string | null; legal_name: string }>("SELECT cnpj, legal_name FROM entity WHERE id = $1", [ctx.entityId]);
  const words = normalize(r.rows[0]?.legal_name).replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  return { cnpj: (r.rows[0]?.cnpj ?? "").trim(), name: words.length >= 2 ? `${words[0]} ${words[1]}` : words[0] ?? null };
}
function mentionsOwn(memo: string, own: OwnIdentity): boolean {
  const t = normalize(memo);
  const flat = t.replace(/[.\-/\s]/g, "");
  if (own.cnpj && flat.includes(own.cnpj)) return true;
  return Boolean(own.name && ` ${t.replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ")} `.includes(` ${own.name} `));
}

async function bankMovements(ctx: Ctx, s: Stats, pending: PendingMovement[]) {
  const { rows } = await ctx.tx.query<Movement>(
    `SELECT t.id, t.posted_on::text, t.amount::text, t.memo, t.payee, c.code AS account_code, b.label, b.id AS bank_account_id, b.bank_code
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
  const own = await ownIdentity(ctx);
  const socios = await partnerNames(ctx);
  const done = new Set<string>();
  for (const m of rows) {
    if (done.has(m.id)) continue;
    if (ctx.locked.has(compOf(m.posted_on))) { s.locked++; continue; }
    const out = Dec.of(m.amount).cmp("0") < 0;
    const value = Dec.of(m.amount).mul(out ? "-1" : "1").toFixed(2);
    const memo = [m.memo, m.payee].filter(Boolean).join(" · ") || "movimento bancário";
    const base = { entityId: ctx.entityId, date: m.posted_on, origin: "BANCO" as const, originRef: `bank_transaction:${m.id}`, idempotencyKey: await bankKey(ctx, m.id),
      evidence: [{ kind: "bank_transaction", id: m.id }] };
    const notes: Why[] = [];

    // Transferência entre contas da própria empresa: o histórico cita a empresa e a outra conta tem o movimento oposto.
    if (mentionsOwn(memo, own)) {
      const cp = await ctx.tx.query<{ id: string; posted_on: string; account_code: string; label: string }>(
        `SELECT t.id, t.posted_on::text, c.code AS account_code, b.label
           FROM bank_transaction t JOIN bank_account b ON b.id = t.bank_account_id JOIN chart_account c ON c.id = b.ledger_account_id
          WHERE t.entity_id = $1 AND t.bank_account_id <> $2 AND t.amount = $3 AND t.posted_on BETWEEN $4 AND $5
            AND NOT EXISTS (SELECT 1 FROM bank_match x JOIN journal_entry e ON e.id = x.entry_id
                             WHERE x.transaction_id = t.id AND NOT EXISTS (SELECT 1 FROM journal_entry y WHERE y.reverses_id = e.id))
          ORDER BY abs(t.posted_on - $6::date), t.id`,
        [ctx.entityId, m.bank_account_id, Dec.of(m.amount).mul("-1").toFixed(2), addDays(m.posted_on, -3), addDays(m.posted_on, 3), m.posted_on],
      );
      const other = cp.rows.find((x) => !done.has(x.id));
      if (other) {
        const [from, to] = out ? [m, other] : [other, m];
        const date = [m.posted_on, other.posted_on].sort()[0]!;
        const r = await post(ctx, s, {
          entityId: ctx.entityId, date, origin: "BANCO", originRef: `bank_transaction:${m.id}`, idempotencyKey: `transferencia:${[m.id, other.id].sort().join(":")}`,
          history: `Transferência entre contas: ${from.label} → ${to.label} — ${memo}`, confidence: "1",
          evidence: [{ kind: "bank_transaction", id: m.id }, { kind: "bank_transaction", id: other.id }],
          lines: [{ account: to.account_code, debit: value }, { account: from.account_code, credit: value }],
        });
        if (r) { await link(m.id, r.id, "TRANSFERENCIA", other.id); await link(other.id, r.id, "TRANSFERENCIA", m.id); }
        done.add(other.id);
        continue;
      }
      notes.push({ why: "Transferência entre contas da própria empresa: falta o extrato (ou o movimento) da outra conta", hypotheses: [] });
    }

    if (out) {
      const f = await federalPaymentLines(ctx, m);
      if (f && "lines" in f) {
        const r = await post(ctx, s, { ...base, history: `Pagamento DARF/DAS ${f.doc} — ${memo}`, lines: f.lines, confidence: "1", evidence: [...base.evidence, { kind: "federal_payment", id: f.ref }] });
        if (r) await link(m.id, r.id, "PAGAMENTO_FEDERAL", f.ref);
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
          lines: [...ns.map((n): EntryLine => ({ account: ctx.acc("FORNECEDORES"), debit: Dec.of(n.net).toFixed(2), history: `NFS-e nº ${n.number ?? "—"}`, dimensions: partner(n.doc, n.name) })), { account: m.account_code, credit: value }] });
        if (r) for (const n of ns) await link(m.id, r.id, "NFSE_TOMADA", n.id);
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
          lines: [{ account: m.account_code, debit: value }, ...ns.map((x): EntryLine => ({ account: ctx.acc("CLIENTES"), credit: Dec.of(x.net).toFixed(2), history: `NFS-e nº ${x.number ?? "—"}`, dimensions: partner(x.doc, x.name) }))] });
        if (r) for (const x of ns) await link(m.id, r.id, "NFSE", x.id);
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
        if (r) await link(m.id, r.id, "REGRA", rule.id);
        continue;
      } catch (err) {
        if (!(err instanceof LedgerError)) throw err;
        notes.push({ why: `Regra "${rule.pattern}" aponta para ${rule.account_code}: ${err.message}`, hypotheses: [] });
      }
    } else if (rule) notes.push(rule);
    const kind = standardKind(memo, out);
    if (kind) {
      if (!ctx.bankStdRule) notes.push({ why: `${STD_LABEL[kind]} do banco: aprove as regras padrão de extrato`, hypotheses: [] });
      else {
        const acc = kind === "RENDIMENTO" ? ctx.acc("RECEITA_APLICACOES") : kind === "TARIFA" ? ctx.acc("TARIFAS") : await applicationAccount(ctx, m);
        const lines: EntryLine[] = out
          ? [{ account: acc, debit: value }, { account: m.account_code, credit: value }]
          : [{ account: m.account_code, debit: value }, { account: acc, credit: value }];
        const r = await post(ctx, s, { ...base, history: `${STD_LABEL[kind]} — ${memo}`, rule: `${BANK_STANDARD_RULE}:${kind}`, confidence: "1", lines });
        if (r) await link(m.id, r.id, "REGRA", BANK_STANDARD_RULE);
        continue;
      }
    }
    // Pagamento sem nota fiscal → Outras Despesas Operacionais (regra aprovada)
    if (out && ctx.noNoteRule && !kind && notes.every((n) => n.soft) && !NOT_EXPENSE.test(normalize(memo)) && !mentionsAny(memo, socios)) {
      const who = notes.find((n) => n.partnerDoc);
      const acc = await otherExpensesAccount(ctx);
      if (acc) {
        const dim = who ? partner(who.partnerDoc!, who.partnerName ?? null) : {};
        const r = await post(ctx, s, { ...base, history: `Pagamento sem nota fiscal — ${memo}`, rule: NO_NOTE_RULE, confidence: "1",
          lines: [{ account: acc, debit: value, dimensions: dim }, { account: m.account_code, credit: value }] });
        if (r) await link(m.id, r.id, "REGRA", NO_NOTE_RULE);
        continue;
      }
      notes.push({ why: "Pagamento sem nota: o plano não tem o grupo Outras Despesas Operacionais", hypotheses: [] });
    }
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
  /** Documentos ou movimentos de competência fechada ainda não lançados (ou estornos pendentes). */
  lockedItems: number;
}

/** Roda os três passos para a empresa. Sem plano de contas, não lança nada. */
export async function runAutoPosting(pool: Pool, tenantId: string, entityId: string, actor: Actor = LEDGER_ENGINE): Promise<AutoPostingResult> {
  return withTenant(pool, tenantId, async (tx) => {
    const start = await chartStart(tx, entityId);
    if (!start) return { entityId, skipped: "sem plano de contas", posted: 0, reversed: 0, pendingFiscal: 0, pendingBank: 0, lockedItems: 0 };
    await syncPartners(tx, entityId);
    const ctx = await makeCtx(tx, entityId, start, actor);
    const fiscal = newStats();
    await nfseRevenue(ctx, fiscal);
    await simplesProvision(ctx, fiscal);
    const takenPending: PendingTaken[] = [];
    await nfseExpenses(ctx, fiscal, takenPending);
    const bank = newStats();
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
    return { entityId, skipped: null, posted, reversed, pendingFiscal: fiscal.pending, pendingBank: bank.pending, lockedItems: fiscal.locked + bank.locked };
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
    await bankMovements(await makeCtx(client, entityId, start, LEDGER_ENGINE), newStats(), pending);
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
    await nfseExpenses(await makeCtx(client, entityId, start, LEDGER_ENGINE), newStats(), pending);
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

/** Aprovação de regra de contabilização (decisão de pessoa); em seguida contabiliza as empresas. */
export async function approveAccountingRule(pool: Pool, tenantId: string, ruleSet: string, actor: Actor) {
  if (actor.kind !== "USER") throw new LedgerError("Só uma pessoa aprova regra de contabilização");
  if (![TAKEN_SERVICES_RULE, REVENUE_RETENTIONS_RULE, BANK_STANDARD_RULE, NO_NOTE_RULE].includes(ruleSet)) throw new LedgerError("Regra de contabilização desconhecida");
  await withTenant(pool, tenantId, async (tx) => {
    const ins = await tx.query(
      "INSERT INTO accounting_rule_approval (id, tenant_id, rule_set, approved_by) VALUES ($1, current_tenant(), $2, $3) ON CONFLICT DO NOTHING",
      [newId(), ruleSet, actor.id],
    );
    if (!ins.rowCount) return;
    await appendEvent(tx, {
      type: "ACCOUNTING_RULES_APPROVED",
      schemaVersion: 1,
      producer: { kind: "user", name: actor.id, version: "1" },
      idempotencyKey: `regra-contabil:${ruleSet}`,
      payload: { rule_set: ruleSet, approved_by: actor.id },
    });
    await audit(tx, { actor, action: "ledger.rule_approved", resourceType: "accounting_rule_approval", resourceId: ruleSet, ruleRef: ruleSet, approvedBy: actor.id });
  });
  const ents = await withTenant(pool, tenantId, (tx) => tx.query<{ id: string }>("SELECT DISTINCT entity_id AS id FROM chart_account"));
  let posted = 0;
  for (const e of ents.rows) {
    // ISS retido na fonte (3.2.1.03) entrou no plano padrão junto com a regra de receita com retenção.
    await withTenant(pool, tenantId, (tx) => ensureStandardAccounts(tx, e.id, actor));
    posted += (await runAutoPosting(pool, tenantId, e.id)).posted;
  }
  return { approved: true, posted };
}

/** Aprovação da tabela tipo de serviço → conta (decisão de pessoa). */
export function approveTakenServicesRule(pool: Pool, tenantId: string, actor: Actor) {
  return approveAccountingRule(pool, tenantId, TAKEN_SERVICES_RULE, actor);
}

/** Notas emitidas com retenção sofrida ainda sem lançamento (para a tela mostrar a proposta). */
export async function revenueRetentionsPending(tx: PoolClient, entityId: string) {
  const r = await tx.query<{ n: number; total: string | null; withheld: string | null }>(
    `SELECT count(*)::int AS n, sum(d.service_value)::text AS total, sum(t.total_withheld_calc)::text AS withheld
       FROM nfse_document d JOIN nfse_tax t ON t.nfse_id = d.id AND t.parser = $2
      WHERE d.entity_id = $1 AND d.role = 'PRESTADA' AND t.total_withheld_calc > 0
        AND NOT EXISTS (SELECT 1 FROM journal_entry e WHERE e.idempotency_key = 'nfse:' || d.id::text)
        AND (d.issued_at AT TIME ZONE 'America/Sao_Paulo')::date >= coalesce((SELECT min(valid_from) FROM chart_account c WHERE c.entity_id = $1 AND c.source <> 'BANCO'), '9999-12-31')`,
    [entityId, NFSE_TAX_PARSER],
  );
  return { notes: r.rows[0]?.n ?? 0, total: r.rows[0]?.total ?? "0", withheld: r.rows[0]?.withheld ?? "0" };
}

export async function ruleStatus(tx: PoolClient, ruleSet: string) {
  const r = await tx.query<{ approved_by: string; approved_at: Date }>("SELECT approved_by, approved_at FROM accounting_rule_approval WHERE rule_set = $1", [ruleSet]);
  return r.rows[0] ?? null;
}

export async function takenRuleStatus(tx: PoolClient) {
  const r = await tx.query<{ approved_by: string; approved_at: Date }>("SELECT approved_by, approved_at FROM accounting_rule_approval WHERE rule_set = $1", [TAKEN_SERVICES_RULE]);
  return r.rows[0] ?? null;
}

