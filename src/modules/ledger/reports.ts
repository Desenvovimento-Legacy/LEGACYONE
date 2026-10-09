import type { PoolClient } from "pg";
import { Dec } from "../../shared/decimal.js";
import { chartConfig, type DreGroup } from "./chart-config.js";

/**
 * Relatórios do One Ledger (só leitura): razão por conta, contas em aberto por
 * parceiro (fornecedores e clientes) e DRE.
 *
 * Parceiro da linha: a dimensão gravada no lançamento (parceiro_doc/parceiro);
 * para lançamentos antigos, a NFS-e de origem (evidência do lançamento ou do
 * lançamento estornado).
 */

const PARTNER_JOIN = `
  LEFT JOIN journal_entry o ON o.id = e.reverses_id
  LEFT JOIN LATERAL (
    SELECT (ev->>'id')::uuid AS id FROM jsonb_array_elements(coalesce(nullif(e.evidence, '[]'::jsonb), o.evidence, '[]'::jsonb)) ev
     WHERE ev->>'kind' = 'nfse_document' LIMIT 1) src ON true
  LEFT JOIN nfse_document nd ON nd.id = src.id`;
const PARTNER_COLS = `
  coalesce(l.dimensions->>'parceiro_doc', CASE nd.role WHEN 'TOMADA' THEN nd.provider_doc WHEN 'PRESTADA' THEN nd.taker_doc END) AS partner_doc,
  coalesce(l.dimensions->>'parceiro', CASE nd.role WHEN 'TOMADA' THEN nd.provider_name WHEN 'PRESTADA' THEN coalesce(nd.taker_name, nd.taker_doc) END) AS partner`;

export interface LedgerLine {
  date: string;
  entryId: string;
  history: string;
  partner: string | null;
  partnerDoc: string | null;
  origin: string;
  debit: string;
  credit: string;
  balance: string;
}

/** Razão de uma conta (analítica ou sintética, somando as filhas), com saldo acumulado. Saldo devedor positivo. */
export async function ledgerDetail(tx: PoolClient, entityId: string, account: string, from: string, to: string, partnerDoc: string | null = null) {
  const acc = await tx.query<{ code: string; name: string; analytic: boolean }>(
    "SELECT code, name, analytic FROM chart_account WHERE entity_id = $1 AND code = $2 ORDER BY valid_from DESC LIMIT 1",
    [entityId, account],
  );
  const a = acc.rows[0];
  if (!a) return null;
  const like = `${account}.%`;
  const opening = await tx.query<{ v: string | null }>(
    `SELECT sum(l.debit - l.credit)::text AS v
       FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN chart_account c ON c.id = l.account_id ${PARTNER_JOIN}
      WHERE l.entity_id = $1 AND (c.code = $2 OR c.code LIKE $3) AND e.entry_date < $4
        AND ($5::text IS NULL OR coalesce(l.dimensions->>'parceiro_doc', CASE nd.role WHEN 'TOMADA' THEN nd.provider_doc WHEN 'PRESTADA' THEN nd.taker_doc END) = $5)`,
    [entityId, account, like, from, partnerDoc],
  );
  const { rows } = await tx.query<{ date: string; entry_id: string; history: string; line_history: string | null; code: string; origin: string; debit: string; credit: string; partner_doc: string | null; partner: string | null }>(
    `SELECT e.entry_date::text AS date, e.id AS entry_id, e.history, l.history AS line_history, c.code, e.origin, l.debit::text, l.credit::text, ${PARTNER_COLS}
       FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN chart_account c ON c.id = l.account_id ${PARTNER_JOIN}
      WHERE l.entity_id = $1 AND (c.code = $2 OR c.code LIKE $3) AND e.entry_date BETWEEN $4 AND $5
      ORDER BY e.entry_date, e.created_at, l.seq`,
    [entityId, account, like, from, to],
  );
  let bal = Dec.of(opening.rows[0]?.v ?? "0");
  let d = Dec.ZERO;
  let c = Dec.ZERO;
  const lines: LedgerLine[] = [];
  for (const r of rows) {
    if (partnerDoc && r.partner_doc !== partnerDoc) continue;
    bal = bal.add(r.debit).sub(r.credit);
    d = d.add(r.debit);
    c = c.add(r.credit);
    lines.push({
      date: r.date, entryId: r.entry_id,
      history: `${r.history}${r.line_history ? ` · ${r.line_history}` : ""}${a.analytic ? "" : ` [${r.code}]`}`,
      partner: r.partner, partnerDoc: r.partner_doc, origin: r.origin,
      debit: Dec.of(r.debit).toFixed(2), credit: Dec.of(r.credit).toFixed(2), balance: bal.toFixed(2),
    });
  }
  return {
    account: { code: a.code, name: a.name, analytic: a.analytic },
    from, to, partnerDoc,
    opening: Dec.of(opening.rows[0]?.v ?? "0").toFixed(2),
    debit: d.toFixed(2), credit: c.toFixed(2), closing: bal.toFixed(2),
    lines,
  };
}

export interface OpenItem {
  partnerDoc: string | null;
  partner: string | null;
  debit: string;
  credit: string;
  balance: string;
  lines: number;
  last: string;
}

/** Saldo por parceiro numa conta (ex.: 2.1.1.01 Fornecedores, 1.1.2.01 Clientes) até a data. */
export async function openItems(tx: PoolClient, entityId: string, account: string, until: string) {
  const { rows } = await tx.query<{ partner_doc: string | null; partner: string | null; debit: string; credit: string; n: number; last: string }>(
    `WITH x AS (
       SELECT l.debit, l.credit, e.entry_date, ${PARTNER_COLS}
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN chart_account c ON c.id = l.account_id ${PARTNER_JOIN}
        WHERE l.entity_id = $1 AND (c.code = $2 OR c.code LIKE $3) AND e.entry_date <= $4)
     SELECT partner_doc, max(partner) AS partner, sum(debit)::text AS debit, sum(credit)::text AS credit, count(*)::int AS n, max(entry_date)::text AS last
       FROM x GROUP BY partner_doc`,
    [entityId, account, `${account}.%`, until],
  );
  const items: OpenItem[] = rows
    .map((r) => ({
      partnerDoc: r.partner_doc, partner: r.partner, debit: Dec.of(r.debit).toFixed(2), credit: Dec.of(r.credit).toFixed(2),
      balance: Dec.of(r.debit).sub(r.credit).toFixed(2), lines: r.n, last: r.last,
    }))
    .filter((i) => !Dec.of(i.balance).isZero())
    .sort((a, b) => Math.abs(Number(b.balance)) - Math.abs(Number(a.balance)));
  const total = items.reduce((s, i) => s.add(i.balance), Dec.ZERO);
  return { account, until, items, total: total.toFixed(2) };
}

export interface DreLine { key: string; label: string; value: string; level: number; strong?: boolean }

async function movement(tx: PoolClient, entityId: string, from: string, to: string): Promise<(prefix: string) => Dec> {
  const { rows } = await tx.query<{ code: string; d: string; c: string }>(
    `SELECT c.code, sum(l.debit)::text AS d, sum(l.credit)::text AS c
       FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN chart_account c ON c.id = l.account_id
      WHERE l.entity_id = $1 AND e.entry_date BETWEEN $2 AND $3 GROUP BY c.code`,
    [entityId, from, to],
  );
  // saldo do período com sinal credor positivo (receita +, despesa −)
  return (prefix: string) =>
    rows.filter((r) => r.code === prefix || r.code.startsWith(`${prefix}.`)).reduce((s, r) => s.add(r.c).sub(r.d), Dec.ZERO);
}

function dreLines(net: (p: string) => Dec, groups: DreGroup[]): DreLine[] {
  const f = (v: Dec) => v.toFixed(2);
  const val = (g: DreGroup) => g.include.reduce((s, p) => s.add(net(p)), Dec.ZERO).sub((g.exclude ?? []).reduce((s, p) => s.add(net(p)), Dec.ZERO));
  const get = (k: string) => groups.find((g) => g.key === k);
  const line = (g: DreGroup | undefined, v: Dec): DreLine[] => (g ? [{ key: g.key, label: g.label, value: f(v), level: g.key === "rb" ? 0 : 1 }] : []);
  const rb = get("rb") ? val(get("rb")!) : Dec.ZERO;
  const ded = get("ded") ? val(get("ded")!) : Dec.ZERO;
  const rl = rb.add(ded);
  const cost = get("cost") ? val(get("cost")!) : Dec.ZERO;
  const lb = rl.add(cost);
  const rest = groups.filter((g) => !["rb", "ded", "cost"].includes(g.key));
  let res = lb;
  const restLines: DreLine[] = [];
  for (const g of rest) {
    const v = val(g);
    res = res.add(v);
    restLines.push(...line(g, v));
  }
  // conta de resultado fora dos grupos: aparece em linha própria, para o resultado bater com o razão
  const total = net("3").add(net("4")).add(net("5"));
  const other = total.sub(res);
  if (!other.isZero()) restLines.push({ key: "outros", label: "(+/−) Outras contas de resultado", value: f(other), level: 1 });
  return [
    ...line(get("rb"), rb),
    ...line(get("ded"), ded),
    { key: "rl", label: "Receita líquida", value: f(rl), level: 0, strong: true },
    ...line(get("cost"), cost),
    { key: "lb", label: "Lucro bruto", value: f(lb), level: 0, strong: true },
    ...restLines,
    { key: "res", label: "Resultado do período", value: f(total), level: 0, strong: true },
  ];
}

/** DRE do mês e do ano até o mês (desde o início da contabilidade, se for no mesmo ano). */
export async function incomeStatement(tx: PoolClient, entityId: string, month: string) {
  const from = `${month}-01`;
  const to = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const yearFrom = `${month.slice(0, 4)}-01-01`;
  const start = await tx.query<{ d: string | null }>("SELECT min(valid_from)::text AS d FROM chart_account WHERE entity_id = $1 AND source <> 'BANCO'", [entityId]);
  const ytdFrom = [yearFrom, start.rows[0]?.d ?? yearFrom].sort().pop()!;
  const cfg = await chartConfig(tx, entityId);
  return {
    month, from, to, ytdFrom,
    monthLines: dreLines(await movement(tx, entityId, from, to), cfg.dre),
    ytdLines: dreLines(await movement(tx, entityId, ytdFrom, to), cfg.dre),
  };
}

export interface BalanceLine { code: string; label: string; value: string; level: number; strong?: boolean }

/**
 * Balanço patrimonial na data (saldos acumulados desde o início da contabilidade).
 * Sem encerramento do exercício, o resultado das contas 3 e 4 aparece no PL como
 * "Resultado do período (não encerrado)". Ativo positivo; passivo e PL positivos.
 */
export async function balanceSheet(tx: PoolClient, entityId: string, date: string) {
  const start = await tx.query<{ d: string | null }>("SELECT min(valid_from)::text AS d FROM chart_account WHERE entity_id = $1 AND source <> 'BANCO'", [entityId]);
  const from = start.rows[0]?.d ?? date;
  const { rows } = await tx.query<{ code: string; name: string; analytic: boolean; bal: string }>(
    `WITH acc AS (SELECT DISTINCT ON (code) code, name, analytic FROM chart_account WHERE entity_id = $1 AND valid_from <= $2 ORDER BY code, valid_from DESC),
          mov AS (SELECT c.code, sum(l.debit - l.credit) AS bal FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN chart_account c ON c.id = l.account_id
                   WHERE l.entity_id = $1 AND e.entry_date <= $2 GROUP BY c.code)
     SELECT a.code, a.name, a.analytic,
            coalesce((SELECT sum(m.bal) FROM mov m WHERE m.code = a.code OR m.code LIKE a.code || '.%'), 0)::text AS bal
       FROM acc a ORDER BY a.code`,
    [entityId, date],
  );
  const bal = (code: string) => Dec.of(rows.find((r) => r.code === code)?.bal ?? "0");
  const result = Dec.ZERO.sub(bal("3")).sub(bal("4")).sub(bal("5")); // crédito positivo
  const f = (v: Dec) => v.toFixed(2);
  const section = (root: string, sign: 1 | -1) =>
    rows
      .filter((r) => r.code.startsWith(`${root}.`) && !r.analytic && r.code.split(".").length <= 3 && !Dec.of(r.bal).isZero())
      .map((r) => ({ code: r.code, label: r.name, value: f(sign === 1 ? Dec.of(r.bal) : Dec.ZERO.sub(r.bal)), level: r.code.split(".").length - 1 }));
  const ativo = bal("1");
  const passivo = Dec.ZERO.sub(bal("2.1")).sub(bal("2.2"));
  const pl = Dec.ZERO.sub(bal("2.3")).add(result);
  const assets: BalanceLine[] = [{ code: "1", label: "ATIVO", value: f(ativo), level: 0, strong: true }, ...section("1", 1)];
  const liabilities: BalanceLine[] = [
    { code: "2", label: "PASSIVO E PATRIMÔNIO LÍQUIDO", value: f(passivo.add(pl)), level: 0, strong: true },
    ...section("2", -1).filter((l) => !l.code.startsWith("2.3")),
    { code: "2.3", label: "PATRIMÔNIO LÍQUIDO", value: f(pl), level: 1 },
    ...rows.filter((r) => r.code.startsWith("2.3.") && r.analytic && !Dec.of(r.bal).isZero()).map((r) => ({ code: r.code, label: r.name, value: f(Dec.ZERO.sub(r.bal)), level: 2 })),
    ...(result.isZero() ? [] : [{ code: "", label: "Resultado do período (não encerrado)", value: f(result), level: 2 }]),
  ];
  const diff = ativo.sub(passivo.add(pl));
  return { date, from, assets, liabilities, totals: { ativo: f(ativo), passivo: f(passivo), pl: f(pl), result: f(result), balanced: diff.isZero(), diff: f(diff) } };
}
