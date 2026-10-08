import type { PoolClient } from "pg";
import { Dec } from "../../shared/decimal.js";

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

function dreLines(net: (p: string) => Dec): DreLine[] {
  const rb = net("3.1");
  const ded = net("3.2");
  const rl = rb.add(ded);
  const cost = net("4.1");
  const lb = rl.add(cost);
  const pes = net("4.2");
  const adm = net("4.3");
  const trib = net("4.5");
  const fin = net("3.3").add(net("4.4"));
  const res = lb.add(pes).add(adm).add(trib).add(fin);
  const f = (v: Dec) => v.toFixed(2);
  return [
    { key: "rb", label: "Receita bruta", value: f(rb), level: 0 },
    { key: "ded", label: "(−) Deduções (Simples Nacional, devoluções)", value: f(ded), level: 1 },
    { key: "rl", label: "Receita líquida", value: f(rl), level: 0, strong: true },
    { key: "cost", label: "(−) Custos", value: f(cost), level: 1 },
    { key: "lb", label: "Lucro bruto", value: f(lb), level: 0, strong: true },
    { key: "pes", label: "(−) Despesas com pessoal", value: f(pes), level: 1 },
    { key: "adm", label: "(−) Despesas administrativas", value: f(adm), level: 1 },
    { key: "trib", label: "(−) Despesas tributárias", value: f(trib), level: 1 },
    { key: "fin", label: "(+/−) Resultado financeiro", value: f(fin), level: 1 },
    { key: "res", label: "Resultado do período", value: f(res), level: 0, strong: true },
  ];
}

/** DRE do mês e do ano até o mês (desde o início da contabilidade, se for no mesmo ano). */
export async function incomeStatement(tx: PoolClient, entityId: string, month: string) {
  const from = `${month}-01`;
  const to = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const yearFrom = `${month.slice(0, 4)}-01-01`;
  const start = await tx.query<{ d: string | null }>("SELECT min(valid_from)::text AS d FROM chart_account WHERE entity_id = $1 AND source <> 'BANCO'", [entityId]);
  const ytdFrom = [yearFrom, start.rows[0]?.d ?? yearFrom].sort().pop()!;
  return {
    month, from, to, ytdFrom,
    monthLines: dreLines(await movement(tx, entityId, from, to)),
    ytdLines: dreLines(await movement(tx, entityId, ytdFrom, to)),
  };
}
