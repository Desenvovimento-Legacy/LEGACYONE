import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { NFE_ITEMS_PARSER } from "../../integrations/sefaz/nfe-items.js";
import { audit } from "../../platform/audit/audit.js";
import { appendEvent } from "../../platform/events/outbox.js";
import type { Actor } from "../../shared/actor.js";
import { Dec } from "../../shared/decimal.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";
import { CFOP_RULES_VERSION, CREDIT_RULES_VERSION } from "../fiscal/cfop-rules.js";
import { chartConfig } from "../ledger/chart-config.js";
import { closingStatus, type CheckStatus, type ClosingCheck } from "../ledger/closing.js";
import { lockedCompetences, trialBalance } from "../ledger/ledger.js";

/**
 * Agente Revisão independente (One Review).
 *
 * Não confia nos agentes executores: refaz, por empresa e competência, os
 * cruzamentos entre o que os motores produziram e o que as fontes dizem —
 *
 *   contábil      partidas dobradas, notas lançadas, saldos pela natureza
 *   financeiro    extrato cobrindo o mês, movimentos lançados, banco × razão
 *   fiscal        receita das notas (NFS-e + NF-e de venda) × receita contabilizada,
 *                 CFOP/CST dos itens
 *   tributário    receita declarada × notas, Simples calculado × declarado,
 *                 DAS × pagamento, retenções × recolhimento
 *   documentos    NF-e só em resumo, lacunas de NSU
 *
 * e dá a nota: cobertura (conferências OK sobre as aplicáveis), materialidade
 * (valores em aberto) e risco. Só lê e grava a própria fotografia; não lança,
 * não corrige e não bloqueia — bloquear é do fechamento, e só quando crítico.
 */

export const REVIEW_VERSION = "revisao-1";
const REVIEW: Actor = { kind: "AGENT", id: "review" };
/** Risco alto quando o valor em aberto passa de 5% da receita do mês ou de R$ 5.000,00. */
export const MATERIALITY = { share: "0.05", floor: "5000.00" } as const;
const TOLERANCE = "1.00";
const MAX_MONTHS = 12;

export type ReviewArea = "CONTABIL" | "FINANCEIRO" | "FISCAL" | "TRIBUTARIO" | "DOCUMENTOS";
export type ReviewStatus = "APROVADA" | "COM_RESSALVAS" | "PENDENTE" | "NAO_SE_APLICA";
export type Risk = "BAIXO" | "MEDIO" | "ALTO";

export interface ReviewCheck {
  key: string;
  area: ReviewArea;
  label: string;
  status: CheckStatus;
  detail: string;
  /** valor em aberto (materialidade), quando há */
  amount?: string;
  /** pendência tributária: risco alto mesmo com valor pequeno */
  critical?: boolean;
  items?: string[];
}

export interface ReviewResult {
  month: string;
  status: ReviewStatus;
  coverage: string;
  risk: Risk;
  materiality: string;
  revenue: string | null;
  pending: number;
  alerts: number;
  checks: ReviewCheck[];
  locked: boolean;
}

const CLOSING_AREA: Record<string, ReviewArea> = {
  inicio: "CONTABIL", anteriores: "CONTABIL", abertura: "CONTABIL", partidas: "CONTABIL", nfse_prestadas: "CONTABIL",
  nfse_tomadas: "CONTABIL", natureza: "CONTABIL", simples: "TRIBUTARIO", extrato: "FINANCEIRO", movimentos: "FINANCEIRO", banco_razao: "FINANCEIRO",
};
const mm = (comp: string) => `${comp.slice(5, 7)}/${comp.slice(0, 4)}`;
const br = (d: string) => d.slice(0, 10).split("-").reverse().join("/");
const brl = (v: string | Dec) => Number(Dec.of(v).toFixed(2)).toLocaleString("pt-BR", { minimumFractionDigits: 2 });
const monthEnd = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
const absDec = (v: Dec) => (v.cmp("0") < 0 ? v.mul("-1") : v);

/** CFOP de venda (receita): 51xx/61xx/71xx, 540x/640x (com ST) e 5933/6933 (serviço com ISS). */
export const isSaleCfop = (cfop: string | null) =>
  Boolean(cfop && (/^[567]1\d\d$/.test(cfop) || /^[56]40[1-5]$/.test(cfop) || cfop === "5933" || cfop === "6933"));

/** Status de cada conferência → nota da revisão. Pura (testável). */
export function grade(checks: ReviewCheck[], revenue: string | null): Pick<ReviewResult, "status" | "coverage" | "risk" | "materiality" | "pending" | "alerts"> {
  const applicable = checks.filter((c) => c.status !== "NAO_SE_APLICA");
  const ok = applicable.filter((c) => c.status === "OK").length;
  const pending = applicable.filter((c) => c.status === "PENDENTE").length;
  const alerts = applicable.filter((c) => c.status === "ALERTA").length;
  const materiality = applicable.filter((c) => c.status !== "OK" && c.amount).reduce((s, c) => s.add(absDec(Dec.of(c.amount!))), Dec.ZERO);
  const coverage = applicable.length ? Dec.of(String(ok)).mul("100").div(String(applicable.length)).toFixed(2) : "0.00";
  const status: ReviewStatus = !applicable.length ? "NAO_SE_APLICA" : pending ? "PENDENTE" : alerts ? "COM_RESSALVAS" : "APROVADA";
  const share = revenue && Dec.of(revenue).gt("0") ? Dec.of(revenue).mul(MATERIALITY.share) : Dec.ZERO;
  const limit = share.gt(MATERIALITY.floor) ? Dec.of(MATERIALITY.floor) : share.isZero() ? Dec.of(MATERIALITY.floor) : share;
  const critical = applicable.some((c) => c.critical && c.status === "PENDENTE");
  const risk: Risk = critical || (!materiality.isZero() && materiality.cmp(limit) >= 0) ? "ALTO" : pending || alerts ? "MEDIO" : "BAIXO";
  return { status, coverage, risk, materiality: materiality.toFixed(2), pending, alerts };
}

async function reviewStart(tx: PoolClient, entityId: string): Promise<string | null> {
  const r = await tx.query<{ d: string | null }>(
    `SELECT coalesce((SELECT min(valid_from) FROM chart_account WHERE entity_id = $1 AND source <> 'BANCO'),
                     (SELECT min(valid_from) FROM contracted_service_history WHERE entity_id = $1))::text AS d`,
    [entityId],
  );
  return r.rows[0]?.d ?? null;
}

async function inSimples(tx: PoolClient, entityId: string, from: string, to: string) {
  const r = await tx.query(
    "SELECT 1 FROM tax_regime_history WHERE entity_id = $1 AND regime = 'SIMPLES_NACIONAL' AND valid_from <= $3 AND (valid_to IS NULL OR valid_to >= $2)",
    [entityId, from, to],
  );
  return Boolean(r.rowCount);
}

/** Cruzamentos além do fechamento. Só leitura. */
async function crossChecks(tx: PoolClient, entityId: string, month: string, today: string, hasChart: boolean): Promise<{ checks: ReviewCheck[]; revenue: string | null }> {
  const from = `${month}-01`;
  const to = monthEnd(month);
  const checks: ReviewCheck[] = [];
  const me = (await tx.query<{ cnpj: string | null }>("SELECT cnpj FROM entity WHERE id = $1", [entityId])).rows[0]?.cnpj?.slice(0, 8) ?? "";

  // Receita das notas: NFS-e prestadas não canceladas + itens de NF-e/NFC-e de venda emitidos pela empresa
  const nfse = await tx.query<{ total: string; n: number }>(
    `WITH cancelled AS (
       SELECT DISTINCT access_key FROM nfse_document
        WHERE entity_id = $1 AND role = 'EVENTO' AND access_key IS NOT NULL
          AND (event_type ILIKE '%101101%' OR event_type ILIKE '%105102%' OR event_type ILIKE '%cancel%'))
     SELECT coalesce(sum(d.service_value), 0)::text AS total, count(*)::int AS n FROM nfse_document d
      WHERE d.entity_id = $1 AND d.role = 'PRESTADA' AND d.service_value > 0
        AND (d.issued_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2 AND $3
        AND NOT (d.access_key IS NOT NULL AND d.access_key IN (SELECT access_key FROM cancelled))`,
    [entityId, from, to],
  );
  const rules = `${CFOP_RULES_VERSION}+${CREDIT_RULES_VERSION}`;
  const sales = await tx.query<{ cfop: string | null; total: string; notes: number }>(
    `SELECT cfop, sum(total - discount)::text AS total, count(DISTINCT access_key)::int AS notes FROM nfe_item
      WHERE entity_id = $1 AND parser = $3 AND rules = $4 AND direction = 'SAIDA' AND left(issuer_doc, 8) = $5
        AND competence = $2 GROUP BY cfop`,
    [entityId, from, NFE_ITEMS_PARSER, rules, me],
  );
  const saleRows = sales.rows.filter((r) => isSaleCfop(r.cfop));
  const goods = saleRows.reduce((s, r) => s.add(r.total), Dec.ZERO);
  const goodsNotes = saleRows.reduce((s, r) => s + r.notes, 0);
  const fiscalRevenue = Dec.of(nfse.rows[0]!.total).add(goods);

  let revenue: Dec | null = null;
  if (hasChart) {
    const cfg = await chartConfig(tx, entityId);
    const rb = cfg.dre.find((g) => g.key === "rb")?.include ?? [];
    const tb = await trialBalance(tx, entityId, from, to);
    revenue = tb.rows.filter((r) => r.analytic && rb.some((p) => r.code.startsWith(`${p}.`))).reduce((s, r) => s.add(r.credit).sub(r.debit), Dec.ZERO);
    const diff = fiscalRevenue.sub(revenue);
    const fiscalTxt = `notas ${brl(fiscalRevenue)} (${nfse.rows[0]!.n} NFS-e${goodsNotes ? ` + ${goodsNotes} NF-e de venda ${brl(goods)}` : ""})`;
    checks.push(
      fiscalRevenue.isZero() && revenue.isZero()
        ? { key: "fiscal_contabil", area: "FISCAL", label: "Receita das notas × receita contabilizada", status: "OK", detail: "Sem notas de venda e sem receita no mês" }
        : absDec(diff).cmp(TOLERANCE) <= 0
          ? { key: "fiscal_contabil", area: "FISCAL", label: "Receita das notas × receita contabilizada", status: "OK", detail: `${fiscalTxt} = contabilizado ${brl(revenue)}` }
          : { key: "fiscal_contabil", area: "FISCAL", label: "Receita das notas × receita contabilizada", status: "ALERTA", amount: diff.toFixed(2),
              detail: `${fiscalTxt} × contabilizado ${brl(revenue)}: ${diff.cmp("0") > 0 ? "notas a mais que a receita lançada" : "receita lançada sem nota correspondente"} (${brl(absDec(diff))})` },
    );
  }

  const simples = await inSimples(tx, entityId, from, to);
  // Receita declarada × notas (exceção aberta pelo agente de conferência)
  const exc = await tx.query<{ status: string; difference: string; hypothesis: string; decision: string | null; note: string | null }>(
    `SELECT DISTINCT ON (c.id) c.status, d.difference::text, d.hypothesis,
            (SELECT x.decision FROM exception_decision x WHERE x.case_id = c.id ORDER BY x.decided_at DESC LIMIT 1) AS decision,
            (SELECT x.note FROM exception_decision x WHERE x.case_id = c.id ORDER BY x.decided_at DESC LIMIT 1) AS note
       FROM "case" c JOIN revenue_divergence d ON d.case_id = c.id
      WHERE c.type = 'EXCEPTION' AND c.entity_id = $1 AND c.competence = $2
      ORDER BY c.id, d.created_at DESC`,
    [entityId, from],
  );
  const declared = await tx.query<{ total: string }>(
    `SELECT total::text FROM pgdas_declared_revenue WHERE entity_id = $1 AND competence = $2
      ORDER BY (source = 'RPA') DESC, declared_in DESC, created_at DESC LIMIT 1`,
    [entityId, from],
  );
  const open = exc.rows.find((e) => e.status !== "COMPLETED" && e.status !== "CANCELLED");
  if (open && !open.decision) {
    checks.push({ key: "declarado_notas", area: "TRIBUTARIO", label: "Receita declarada × notas", status: "PENDENTE", amount: open.difference, critical: true,
      detail: `Diferença de ${brl(absDec(Dec.of(open.difference)))} entre o PGDAS-D e as NFS-e: ${open.hypothesis}` });
  } else if (open?.decision === "RETIFICAR" || exc.rows.some((e) => e.decision === "RETIFICAR" && e.status !== "COMPLETED")) {
    checks.push({ key: "declarado_notas", area: "TRIBUTARIO", label: "Receita declarada × notas", status: "ALERTA", amount: open?.difference,
      detail: "Decidido retificar o PGDAS-D: a diferença some quando a retificadora for lida" });
  } else if (declared.rows[0]) {
    const kept = exc.rows.find((e) => e.decision === "MANTER");
    checks.push({ key: "declarado_notas", area: "TRIBUTARIO", label: "Receita declarada × notas", status: "OK",
      detail: kept ? `Declarado ${brl(declared.rows[0].total)}; diferença justificada: ${kept.note}` : `Declarado ${brl(declared.rows[0].total)} confere com as notas` });
  } else if (simples) {
    checks.push({ key: "declarado_notas", area: "TRIBUTARIO", label: "Receita declarada × notas", status: "NAO_SE_APLICA", detail: "Declaração do mês ainda não lida" });
  }

  if (simples) {
    // Simples calculado × declarado / DAS pago
    const calc = await tx.query<{ status: string; total: string | null; reference_kind: string | null; reference_total: string | null; difference: string | null }>(
      `SELECT status, total::text, reference_kind, reference_total::text, difference::text FROM simples_calculation
        WHERE entity_id = $1 AND competence = $2 ORDER BY created_at DESC LIMIT 1`,
      [entityId, from],
    );
    const c = calc.rows[0];
    const ref = c?.reference_kind === "DAS_PAGO" ? "DAS pago" : "declarado";
    checks.push(
      !c ? { key: "simples_calculo", area: "TRIBUTARIO", label: "Simples calculado × declarado", status: "ALERTA", detail: "Simples do mês ainda não calculado" }
      : c.status === "CONFERE" ? { key: "simples_calculo", area: "TRIBUTARIO", label: "Simples calculado × declarado", status: "OK", detail: `Calculado ${brl(c.total ?? "0")} = ${ref} ${brl(c.reference_total ?? "0")}` }
      : c.status === "DIVERGE" ? { key: "simples_calculo", area: "TRIBUTARIO", label: "Simples calculado × declarado", status: "PENDENTE", amount: c.difference ?? undefined, critical: true,
          detail: `Calculado ${brl(c.total ?? "0")} × ${ref} ${brl(c.reference_total ?? "0")}: diferença ${brl(absDec(Dec.of(c.difference ?? "0")))}` }
      : c.status === "CALCULADO" ? { key: "simples_calculo", area: "TRIBUTARIO", label: "Simples calculado × declarado", status: "OK", detail: `Calculado ${brl(c.total ?? "0")}; declaração ainda não lida para conferir` }
      : { key: "simples_calculo", area: "TRIBUTARIO", label: "Simples calculado × declarado", status: "ALERTA",
          detail: { SEM_REFERENCIA: "Calculado sem declaração nem DAS para conferir", REGRA_PENDENTE: "Tabelas do Simples a aprovar", SEM_ANEXO: "Atividade sem anexo definido", NAO_SUPORTADO: "Caso que o motor ainda não calcula" }[c.status] ?? c.status },
    );
    // DAS × pagamento
    const g = await tx.query<{ status: string; due_on: string | null }>(
      "SELECT status, due_on::text FROM tax_guide_observation WHERE entity_id = $1 AND competence = $2 AND guide = 'DAS_SIMPLES' ORDER BY created_at DESC LIMIT 1",
      [entityId, from],
    );
    const gs = g.rows[0];
    const due = gs?.due_on ? ` (vencimento ${br(gs.due_on)})` : "";
    const amount = c?.reference_total ?? c?.total ?? undefined;
    const map: Record<string, Pick<ReviewCheck, "status" | "detail" | "critical">> = {
      PAGO: { status: "OK", detail: "DAS pago" },
      PAGO_EM_ATRASO: { status: "ALERTA", detail: `DAS pago depois do vencimento${due}: multa e juros a conferir` },
      SEM_DEBITO: { status: "OK", detail: "Declarado sem débito" },
      A_DECLARAR: { status: "OK", detail: `No prazo para declarar${due}` },
      DECLARADO_SEM_DAS: { status: "OK", detail: `Declarado; DAS a emitir no prazo${due}` },
      A_VENCER: { status: "OK", detail: `DAS emitido, a vencer${due}` },
      PAGAMENTO_NAO_IDENTIFICADO: { status: "PENDENTE", critical: true, detail: `Pagamento ainda não identificado${due}` },
      DECLARACAO_NAO_IDENTIFICADA: { status: "PENDENTE", critical: true, detail: `Prazo passou e a declaração ainda não aparece${due}` },
    };
    const m = gs ? map[gs.status] : null;
    checks.push(m
      ? { key: "das_pagamento", area: "TRIBUTARIO", label: "DAS × pagamento", ...m, ...(m.status !== "OK" && amount ? { amount } : {}) }
      : { key: "das_pagamento", area: "TRIBUTARIO", label: "DAS × pagamento", status: "NAO_SE_APLICA", detail: "Situação do DAS ainda não montada" });
  }

  // Retenções das notas tomadas × recolhimento (IRRF, CSRF e ISS por município)
  const wh = await tx.query<{ tax: string; status: string; withheld: string; paid: string | null; due_on: string | null; city: string | null }>(
    `SELECT DISTINCT ON (tax) tax, status, withheld::text, paid::text, due_on::text, details->>'cityName' AS city
       FROM withholding_observation WHERE entity_id = $1 AND competence = $2 ORDER BY tax, created_at DESC`,
    [entityId, from],
  );
  if (wh.rows.length) {
    const name = (t: string, city: string | null) => (t.startsWith("ISS:") ? `ISS ${city ?? t.slice(4)}` : t === "CSRF" ? "PIS/COFINS/CSLL" : t);
    const bad = wh.rows.filter((w) => ["PAGAMENTO_NAO_IDENTIFICADO", "GUIA_NAO_ENVIADA"].includes(w.status));
    const warn = wh.rows.filter((w) => ["PAGO_EM_ATRASO", "PAGO_DIVERGENTE", "PAGO_SEM_NOTA", "PRAZO_A_APROVAR"].includes(w.status));
    const label: Record<string, string> = {
      PAGAMENTO_NAO_IDENTIFICADO: "guia enviada, pagamento ainda não identificado", GUIA_NAO_ENVIADA: "guia não enviada ao cliente",
      PAGO_EM_ATRASO: "pago em atraso", PAGO_DIVERGENTE: "pago com valor diferente", PAGO_SEM_NOTA: "pago sem nota correspondente", PRAZO_A_APROVAR: "prazo a definir",
      PAGO: "pago", A_VENCER: "a vencer", ABAIXO_DO_MINIMO: "abaixo do mínimo (acumula)",
    };
    const amount = [...bad, ...warn].reduce((s, w) => s.add(w.status === "PAGO_DIVERGENTE" ? absDec(Dec.of(w.withheld).sub(w.paid ?? "0")) : Dec.of(w.withheld)), Dec.ZERO);
    checks.push({
      key: "retencoes", area: "TRIBUTARIO", label: "Retenções × recolhimento",
      status: bad.length ? "PENDENTE" : warn.length ? "ALERTA" : "OK", critical: bad.length > 0,
      ...(bad.length || warn.length ? { amount: amount.toFixed(2) } : {}),
      detail: bad.length || warn.length ? `${bad.length + warn.length} tributo(s) retido(s) a acompanhar` : `${wh.rows.length} tributo(s) retido(s) em dia`,
      items: wh.rows.map((w) => `${name(w.tax, w.city)}: ${brl(w.withheld)} — ${label[w.status] ?? w.status}${w.due_on ? ` (vence ${br(w.due_on)})` : ""}`),
    });
  }

  // CFOP/CST dos itens das NF-e do mês
  const flagged = await tx.query<{ n: number; notes: number; sample: string[] }>(
    `SELECT count(*)::int AS n, count(DISTINCT access_key)::int AS notes,
            (array_agg(coalesce(issuer_name, '—') || ' item ' || n_item || ': ' || (checks->0->>'text') ORDER BY issued_at DESC))[1:8] AS sample
       FROM nfe_item WHERE entity_id = $1 AND parser = $3 AND rules = $4 AND competence = $2 AND jsonb_array_length(checks) > 0`,
    [entityId, from, NFE_ITEMS_PARSER, rules],
  );
  const items = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM nfe_item WHERE entity_id = $1 AND parser = $3 AND rules = $4 AND competence = $2",
    [entityId, from, NFE_ITEMS_PARSER, rules]);
  if (items.rows[0]!.n) {
    const f = flagged.rows[0]!;
    checks.push({ key: "cfop_cst", area: "FISCAL", label: "CFOP e CST das NF-e", status: f.n ? "ALERTA" : "OK",
      detail: f.n ? `${f.n} item(ns) em ${f.notes} nota(s) com CFOP ou CST a olhar` : `${items.rows[0]!.n} item(ns) conferido(s)`, items: f.n ? f.sample.filter(Boolean) : undefined });
  }

  // Documentos: NF-e de compra só em resumo (ciência é do cliente) e lacunas de NSU
  const res = await tx.query<{ n: number; total: string }>(
    `SELECT count(*)::int AS n, coalesce(sum(r.total), 0)::text AS total FROM dfe_document r
      WHERE r.entity_id = $1 AND r.kind = 'RES_NFE' AND r.situation = '1' AND r.access_key IS NOT NULL
        AND (r.issued_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2 AND $3
        AND NOT EXISTS (SELECT 1 FROM dfe_document f WHERE f.entity_id = r.entity_id AND f.kind = 'NFE' AND f.access_key = r.access_key)
        AND NOT EXISTS (SELECT 1 FROM fiscal_xml x WHERE x.entity_id = r.entity_id AND x.access_key = r.access_key)`,
    [entityId, from, to],
  );
  const gaps = await tx.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pending_item WHERE entity_id = $1 AND status = 'OPEN' AND type LIKE 'DFE_NSU_GAP_%'",
    [entityId],
  );
  const anyDfe = await tx.query("SELECT 1 FROM dfe_query WHERE entity_id = $1 LIMIT 1", [entityId]);
  if (anyDfe.rowCount || res.rows[0]!.n) {
    const r = res.rows[0]!;
    const g = gaps.rows[0]!.n;
    checks.push({ key: "documentos", area: "DOCUMENTOS", label: "NF-e de compra com XML completo", status: r.n || g ? "ALERTA" : "OK",
      ...(r.n ? { amount: r.total } : {}),
      detail: [r.n ? `${r.n} NF-e só em resumo (${brl(r.total)}): ciência pedida ao cliente` : null, g ? `${g} lacuna(s) de NSU na SEFAZ a resolver` : null]
        .filter(Boolean).join("; ") || "Todas as NF-e do mês com XML completo" });
  }
  void today;
  return { checks, revenue: revenue ? revenue.toFixed(2) : null };
}

/** Revisão de uma competência (AAAA-MM). Não grava nada. */
export async function reviewMonth(pool: Pool, tenantId: string, entityId: string, month: string, today: string): Promise<ReviewResult> {
  const closing = await closingStatus(pool, tenantId, entityId, month);
  const hasChart = Boolean(closing.start) && `${month}-01` >= `${closing.start!.slice(0, 7)}-01`;
  const base: ReviewCheck[] = hasChart
    ? closing.checks.map((c: ClosingCheck) => ({ key: c.key, area: CLOSING_AREA[c.key] ?? "CONTABIL", label: c.label, status: c.status, detail: c.detail, ...(c.items?.length ? { items: c.items } : {}) }))
    : [];
  const extra = await withTenant(pool, tenantId, (tx) => crossChecks(tx, entityId, month, today, hasChart));
  // o fechamento já confere o Simples provisionado; a revisão olha o cálculo e o pagamento
  const checks = [...base, ...extra.checks];
  return { month, ...grade(checks, extra.revenue), revenue: extra.revenue, checks, locked: closing.locked };
}

const fingerprintOf = (r: ReviewResult) =>
  createHash("sha256")
    .update(JSON.stringify([REVIEW_VERSION, r.locked, r.checks.map((c) => [c.key, c.status, c.detail, c.amount ?? null, c.items ?? null])]))
    .digest("hex");

/** Meses a revisar: do início (plano de contas ou responsabilidade) ao mês anterior a hoje, no máximo 12. */
export async function monthsToReview(tx: PoolClient, entityId: string, today: string): Promise<string[]> {
  const start = await reviewStart(tx, entityId);
  if (!start) return [];
  const last = new Date(`${today.slice(0, 7)}-01T12:00:00Z`);
  last.setUTCMonth(last.getUTCMonth() - 1);
  const out: string[] = [];
  const d = new Date(`${start.slice(0, 7)}-01T12:00:00Z`);
  while (d <= last) {
    out.push(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out.slice(-MAX_MONTHS);
}

/**
 * Revisa os meses da empresa e grava a fotografia de cada um que mudou
 * (evento REVIEW_COMPLETED + auditoria). Meses fechados são revisados também:
 * achado depois do fechamento aparece (reabrir é decisão de pessoa).
 */
export async function runReview(pool: Pool, tenantId: string, entityId: string, today: string, actor: Actor = REVIEW) {
  const months = await withTenant(pool, tenantId, (tx) => monthsToReview(tx, entityId, today));
  let changed = 0;
  let pending = 0;
  let high = 0;
  for (const month of months) {
    const r = await reviewMonth(pool, tenantId, entityId, month, today);
    if (r.status === "PENDENTE") pending++;
    if (r.risk === "ALTO") high++;
    const fp = fingerprintOf(r);
    const competence = `${month}-01`;
    const wrote = await withTenant(pool, tenantId, async (tx) => {
      const last = await tx.query<{ fingerprint: string }>(
        "SELECT fingerprint FROM review_run WHERE entity_id = $1 AND competence = $2 ORDER BY created_at DESC LIMIT 1",
        [entityId, competence],
      );
      if (last.rows[0]?.fingerprint === fp) return false;
      const id = newId();
      await tx.query(
        `INSERT INTO review_run (id, tenant_id, entity_id, competence, version, status, coverage, risk, materiality, revenue, pending, alerts, checks, fingerprint, locked)
         VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [id, entityId, competence, REVIEW_VERSION, r.status, r.coverage, r.risk, r.materiality, r.revenue, r.pending, r.alerts, JSON.stringify(r.checks), fp, r.locked],
      );
      await appendEvent(tx, {
        type: "REVIEW_COMPLETED", schemaVersion: 1, producer: { kind: "agent", name: "review", version: REVIEW_VERSION },
        idempotencyKey: `revisao:${entityId}:${month}:${fp.slice(0, 16)}:${id}`, entityId, competence,
        payload: { entity_id: entityId, competence, run_id: id, status: r.status, coverage: r.coverage, risk: r.risk, materiality: r.materiality,
          pending: r.pending, alerts: r.alerts, locked: r.locked, version: REVIEW_VERSION },
      });
      await audit(tx, { actor, action: "review.completed", resourceType: "review_run", resourceId: id, entityId, competence,
        data: { status: r.status, coverage: r.coverage, risk: r.risk, materiality: r.materiality, version: REVIEW_VERSION,
          open: r.checks.filter((c) => c.status === "PENDENTE" || c.status === "ALERTA").map((c) => ({ key: c.key, status: c.status, amount: c.amount ?? null })) } });
      return true;
    });
    if (wrote) changed++;
  }
  return { months: months.length, changed, pending, high };
}

/** Última revisão de cada mês da empresa (para a tela). */
export async function reviewOverview(tx: PoolClient, entityId: string) {
  const r = await tx.query<{ competence: string; status: ReviewStatus; coverage: string; risk: Risk; materiality: string; revenue: string | null;
    pending: number; alerts: number; checks: ReviewCheck[]; locked: boolean; created_at: Date }>(
    `SELECT DISTINCT ON (competence) to_char(competence, 'YYYY-MM') AS competence, status, coverage::text, risk, materiality::text, revenue::text,
            pending, alerts, checks, locked, created_at
       FROM review_run WHERE entity_id = $1 ORDER BY competence DESC, created_at DESC`,
    [entityId],
  );
  const locked = await lockedCompetences(tx, entityId);
  return r.rows.map((x) => ({ ...x, locked: locked.has(`${x.competence}-01`), reviewedAt: x.created_at.toISOString() }));
}

/** Resumo do escritório: última revisão de cada empresa-mês com pendência ou risco alto. */
export async function reviewsNeedingAttention(tx: PoolClient) {
  const r = await tx.query<{ entity_id: string; entity: string; competence: string; status: ReviewStatus; coverage: string; risk: Risk; materiality: string; pending: number; alerts: number }>(
    `SELECT * FROM (
       SELECT DISTINCT ON (v.entity_id, v.competence) v.entity_id, coalesce(e.trade_name, e.legal_name) AS entity, to_char(v.competence, 'YYYY-MM') AS competence,
              v.status, v.coverage::text, v.risk, v.materiality::text, v.pending, v.alerts
         FROM review_run v JOIN entity e ON e.id = v.entity_id ORDER BY v.entity_id, v.competence, v.created_at DESC) x
      WHERE x.status = 'PENDENTE' OR x.risk = 'ALTO' ORDER BY x.competence DESC, x.entity`,
  );
  return r.rows;
}

export const reviewLabel = (s: ReviewStatus) =>
  ({ APROVADA: "Aprovada", COM_RESSALVAS: "Com ressalvas", PENDENTE: "Com pendência", NAO_SE_APLICA: "Sem o que revisar" })[s];
export { mm as reviewMonthLabel };
