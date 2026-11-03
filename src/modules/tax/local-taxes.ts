import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { NFSE_TAX_PARSER } from "../../integrations/nfse/nfse-taxes.js";
import { NFE_ITEMS_PARSER } from "../../integrations/sefaz/nfe-items.js";
import { audit } from "../../platform/audit/audit.js";
import { appendEvent } from "../../platform/events/outbox.js";
import { openPendingItem, resolvePendingItem } from "../../platform/pending/pending.js";
import type { Actor } from "../../shared/actor.js";
import { Dec, sumDec } from "../../shared/decimal.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";
import { normalize } from "../../shared/text.js";
import { CFOP_RULES_VERSION, CREDIT_RULES_VERSION } from "../fiscal/cfop-rules.js";
import { municipalIssDue } from "../fiscal/withholdings.js";
import { loadCalendar, type DueAdjust } from "../regulatory/calendar.js";

/**
 * Agente Tributos — ISS e ICMS próprios (fora do DAS).
 *
 * Quem: empresa fora do Simples na competência, ou do Simples impedida de
 * recolher ISS/ICMS no DAS (sublimite: o motor do Simples registra o impedimento).
 *
 * ISS próprio, por município de incidência: ISS destacado nas NFS-e prestadas
 * sem retenção pelo tomador (canceladas fora). O valor é o da nota; a IARIS
 * confere a alíquota mínima de 2% (LC 116/2003, art. 8º-A) e a nota sem ISS.
 *
 * ICMS próprio, PRÉVIA da apuração do mês pela UF da matriz:
 *   débitos  = ICMS destacado nas notas de saída emitidas pela empresa
 *   créditos = créditos de ICMS apropriáveis das entradas (agente Fiscal), sem o CIAP
 *   saldo    = débitos − créditos − saldo credor do mês anterior
 * Ajustes de apuração, CIAP (1/48 com coeficiente), DIFAL e ICMS-ST retido não
 * entram no saldo: aparecem como pontos a conferir. Mais de uma UF de
 * estabelecimento: a apuração por estabelecimento não é automática (A_CONFERIR).
 *
 * Vencimento: o que uma pessoa informou para o município (ISS) ou a UF (ICMS),
 * com o fundamento. Pagamento: débito do extrato com o mesmo valor e histórico
 * de tributo municipal/estadual, até 45 dias depois do vencimento.
 * Nada é transmitido nem gerado: a IARIS mostra o devido, o prazo e o pagamento.
 */

export const LOCAL_TAX_AGENT: Actor = { kind: "AGENT", id: "tax" };
const PRODUCER = { kind: "agent" as const, name: "tax", version: "local-taxes-1" };
export const ISS_MIN_RATE = "2.00";
const MAX_MONTHS = 24;

export type LocalTaxStatus =
  | "SEM_IMPOSTO" | "SALDO_CREDOR" | "PRAZO_A_APROVAR" | "A_VENCER" | "GUIA_NAO_ENVIADA"
  | "PAGAMENTO_NAO_IDENTIFICADO" | "PAGO" | "PAGO_EM_ATRASO" | "A_CONFERIR";

export interface LocalTaxRow {
  competence: string;
  /** ISSP:<IBGE> ou ICMS:<UF> */
  tax: string;
  kind: "ISS" | "ICMS";
  place: string;
  placeName: string;
  status: LocalTaxStatus;
  /** valor a recolher (ISS do mês ou saldo devedor do ICMS) */
  amount: string;
  paid: string | null;
  due: string | null;
  dueReason: string | null;
  why: string;
  details: Record<string, unknown>;
  checks: string[];
  payment: { transaction: string; postedOn: string; memo: string } | null;
  guide: { sentOn: string; channel: string; amount: string | null } | null;
  responsibility: "ANTERIOR" | "LEGACY" | null;
}

const ISS_TAX_RE = /\b(ISS|ISSQN|PREF|PREFEITURA|MUNICIPIO|MUNICIPAL|DAM|DAMS|TRIBUTO MUNICIPAL|SEFIN)\b/;
const ICMS_TAX_RE = /\b(ICMS|SEFA|SEFAZ|GNRE|DARE|GR PR|GRPR|DAE|DAR|SECRETARIA DA FAZENDA|FAZENDA ESTADUAL|TRIBUTO ESTADUAL)\b/;
/** Entrada de bem do ativo: crédito pelo CIAP (1/48 com coeficiente), fora da prévia. */
const ASSET_CFOP = /^[123](55[1-6]|406)$/;
const SALE_SIDE = /^[567]/;

const ym = (c: string) => c.slice(0, 7);
const my = (c: string) => `${c.slice(5, 7)}/${c.slice(0, 4)}`;
function addMonths(comp: string, n: number): string {
  const d = new Date(`${comp.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return `${d.toISOString().slice(0, 7)}-01`;
}
const lastDay = (comp: string) => new Date(Date.UTC(Number(comp.slice(0, 4)), Number(comp.slice(5, 7)), 0)).getUTCDate();
const addDaysIso = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayDiff = (a: string, b: string) => (Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000;
const clip = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 60);

// ------------------------------------------------------------------ prazos do ICMS

export interface StateIcmsDue { uf: string; day: number; adjust: DueAdjust; legalBasis: string; validFrom: string; createdBy: string }

export async function stateIcmsDue(tx: PoolClient): Promise<StateIcmsDue[]> {
  const { rows } = await tx.query<{ uf: string; day: number; adjust: DueAdjust; legal_basis: string; valid_from: string; created_by: string }>(
    "SELECT uf, day, adjust, legal_basis, valid_from::text, created_by FROM state_icms_due ORDER BY valid_from DESC, created_at DESC",
  );
  return rows.map((r) => ({ uf: r.uf, day: r.day, adjust: r.adjust, legalBasis: r.legal_basis, validFrom: r.valid_from, createdBy: r.created_by }));
}

export class LocalTaxError extends Error {}

/**
 * Pessoa informa o vencimento do ICMS normal da UF (regulamento do ICMS do
 * estado). Vale para todas as empresas do escritório a partir de `validFrom`.
 */
export async function setStateIcmsDue(
  pool: Pool, tenantId: string,
  input: { uf: string; day: number; adjust: DueAdjust; legalBasis: string; validFrom?: string },
  actor: Actor, today: string,
) {
  if (actor.kind !== "USER") throw new LocalTaxError("O prazo do ICMS da UF é informado por uma pessoa (com o fundamento)");
  const uf = (input.uf ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(uf)) throw new LocalTaxError("UF com 2 letras");
  if (!Number.isInteger(input.day) || input.day < 1 || input.day > 31) throw new LocalTaxError("Dia do vencimento entre 1 e 31");
  if (!["NONE", "NEXT_BUSINESS_DAY", "PREVIOUS_BUSINESS_DAY"].includes(input.adjust)) throw new LocalTaxError("Ajuste do vencimento inválido");
  if ((input.legalBasis ?? "").trim().length < 3) throw new LocalTaxError("Informe o fundamento (RICMS ou norma do estado)");
  const validFrom = input.validFrom ?? "2000-01-01";
  await withTenant(pool, tenantId, async (tx) => {
    const id = newId();
    await tx.query(
      `INSERT INTO state_icms_due (id, tenant_id, uf, day, adjust, legal_basis, valid_from, created_by)
       VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7) ON CONFLICT (tenant_id, uf, valid_from) DO NOTHING`,
      [id, uf, input.day, input.adjust, input.legalBasis.trim(), validFrom, actor.id],
    );
    await audit(tx, { actor, action: "tax.icms_due_set", resourceType: "state_icms_due", resourceId: id, data: { ...input, uf, validFrom } });
    const pend = await tx.query<{ id: string }>("SELECT id FROM pending_item WHERE status = 'OPEN' AND type = $1", [`ICMS_DUE_${uf}`]);
    for (const p of pend.rows) await resolvePendingItem(tx, { id: p.id, resolution: `Vencimento informado: dia ${input.day} (${input.legalBasis.trim()})` }, actor);
  });
  return refreshAllLocalTaxes(pool, tenantId, today);
}

// ------------------------------------------------------------------ quem recolhe

type Subject = { subject: true; why: string } | { subject: false; why: string };

async function regimeByMonth(tx: PoolClient, entityId: string) {
  const { rows } = await tx.query<{ regime: string; valid_from: string; valid_to: string | null }>(
    "SELECT regime, valid_from::text, valid_to::text FROM tax_regime_history WHERE entity_id = $1 ORDER BY valid_from",
    [entityId],
  );
  return (comp: string) => rows.filter((r) => r.valid_from <= comp && (!r.valid_to || r.valid_to >= comp)).pop()?.regime ?? null;
}

/** Impedimento de ISS/ICMS no DAS registrado pelo motor do Simples, por competência. */
async function simplesImpeded(tx: PoolClient, entityId: string): Promise<Map<string, string>> {
  const { rows } = await tx.query<{ competence: string; why: string | null }>(
    `SELECT DISTINCT ON (competence) competence::text, inputs->>'localImpeded' AS why
       FROM simples_calculation WHERE entity_id = $1 ORDER BY competence, created_at DESC, id DESC`,
    [entityId],
  );
  return new Map(rows.filter((r) => r.why).map((r) => [r.competence, r.why!]));
}

function subjectOf(regime: string | null, impeded: string | undefined): Subject {
  if (!regime) return { subject: false, why: "regime da empresa não cadastrado na competência" };
  if (regime === "MEI") return { subject: false, why: "MEI: ISS e ICMS no DAS-MEI" };
  if (regime === "SIMPLES_NACIONAL") return impeded
    ? { subject: true, why: `Simples impedido de recolher ISS/ICMS no DAS (${impeded})` }
    : { subject: false, why: "Simples Nacional: ISS e ICMS no DAS" };
  return { subject: true, why: regime === "LUCRO_PRESUMIDO" ? "Lucro Presumido" : regime.startsWith("LUCRO_REAL") ? "Lucro Real" : regime };
}

// ------------------------------------------------------------------ cálculo

interface Debit { id: string; posted_on: string; amount: string; memo: string }

function findPayment(debits: Debit[], used: Set<string>, amount: Dec, from: string, due: string | null, re: RegExp, name: string): Debit | null {
  const until = due ? addDaysIso(due, 45) : addDaysIso(from, 75);
  const n = normalize(name);
  const hit = debits
    .filter((t) => !used.has(t.id) && t.posted_on >= from && t.posted_on <= until && Dec.of(t.amount).cmp(amount) === 0
      && (re.test(normalize(t.memo)) || (n.length >= 4 && normalize(t.memo).includes(n))))
    .sort((a, b) => Math.abs(dayDiff(a.posted_on, due ?? from)) - Math.abs(dayDiff(b.posted_on, due ?? from)))[0];
  if (hit) used.add(hit.id);
  return hit ?? null;
}

/** ISS e ICMS próprios da empresa, competência a competência (só lê o banco). */
export async function localTaxesOverview(tx: PoolClient, entityId: string, today: string) {
  const ent = (await tx.query<{ cnpj: string | null; start: string | null }>(
    "SELECT cnpj, (SELECT min(valid_from)::text FROM contracted_service_history WHERE entity_id = $1) AS start FROM entity WHERE id = $1",
    [entityId],
  )).rows[0];
  if (!ent?.cnpj) return { rows: [] as LocalTaxRow[], missingIssDue: [], missingIcmsDue: [], ufs: [] as string[] };
  const cnpj8 = ent.cnpj.slice(0, 8);
  const current = `${today.slice(0, 7)}-01`;
  const floor = addMonths(current, -MAX_MONTHS);
  const regime = await regimeByMonth(tx, entityId);
  const impeded = await simplesImpeded(tx, entityId);
  const cal = await loadCalendar(tx);
  const respOf = (c: string): LocalTaxRow["responsibility"] => (ent.start ? (c < `${ent.start.slice(0, 7)}-01` ? "ANTERIOR" : "LEGACY") : null);

  const debits = (await tx.query<Debit>(
    `SELECT t.id, t.posted_on::text, (-t.amount)::text AS amount, concat_ws(' ', t.memo, t.payee) AS memo
       FROM bank_transaction t WHERE t.entity_id = $1 AND t.amount < 0 ORDER BY t.posted_on, t.id`,
    [entityId],
  )).rows;
  const usedIss = new Set<string>();
  const usedIcms = new Set<string>();
  const sent = await tx.query<{ tax: string; competence: string; sent_on: string; channel: string; amount: string | null }>(
    `SELECT DISTINCT ON (tax, competence) tax, competence::text, sent_on::text, channel, amount::text
       FROM guide_dispatch WHERE entity_id = $1 AND (tax LIKE 'ISSP:%' OR tax LIKE 'ICMS:%') ORDER BY tax, competence, created_at DESC`,
    [entityId],
  );
  const guides = new Map(sent.rows.map((g) => [`${g.tax}|${g.competence}`, { sentOn: g.sent_on, channel: g.channel, amount: g.amount }]));

  const rows: LocalTaxRow[] = [];
  const settle = (r: Omit<LocalTaxRow, "status" | "paid" | "payment" | "guide"> & { status?: LocalTaxStatus }, re: RegExp, used: Set<string>): LocalTaxRow => {
    const guide = guides.get(`${r.tax}|${r.competence}`) ?? null;
    if (r.status) return { ...r, status: r.status, paid: null, payment: null, guide };
    const amount = Dec.of(r.amount);
    const pay = findPayment(debits, used, amount, `${ym(addMonths(r.competence, 1))}-01`, r.due, re, r.placeName);
    let status: LocalTaxStatus;
    if (pay) status = r.due && pay.posted_on > r.due ? "PAGO_EM_ATRASO" : "PAGO";
    else if (!r.due) status = "PRAZO_A_APROVAR";
    else if (today <= r.due) status = "A_VENCER";
    else status = guide ? "PAGAMENTO_NAO_IDENTIFICADO" : "GUIA_NAO_ENVIADA";
    return {
      ...r, status, paid: pay ? Dec.of(pay.amount).toFixed(2) : null,
      payment: pay ? { transaction: pay.id, postedOn: pay.posted_on, memo: clip(pay.memo) } : null, guide,
    };
  };
  const dueFor = (comp: string, day: number, adjust: DueAdjust) => {
    const next = addMonths(comp, 1);
    const d = Math.min(day, lastDay(next));
    return cal.adjust(`${ym(next)}-${String(d).padStart(2, "0")}`, adjust);
  };

  // ---------------------------------------------------------------- ISS próprio
  const issRules = await municipalIssDue(tx, "PROPRIO");
  const missingIssDue = new Map<string, string>();
  const iss = await tx.query<{
    competence: string; code: string | null; city: string | null; notes: number; services: string; base: string; iss: string;
    withheld: number; low_rate: number; no_iss: number; min_rate: string | null; max_rate: string | null;
  }>(
    `WITH cancelled AS (
       SELECT DISTINCT access_key FROM nfse_document
        WHERE entity_id = $1 AND role = 'EVENTO' AND access_key IS NOT NULL
          AND (event_type ILIKE '%101101%' OR event_type ILIKE '%105102%' OR event_type ILIKE '%cancel%'))
     SELECT t.competence::text, t.incidence_city AS code, max(t.incidence_city_name) AS city, count(*)::int AS notes,
            coalesce(sum(t.service_value), 0)::text AS services,
            coalesce(sum(t.iss_base) FILTER (WHERE t.iss_withheld = 0), 0)::text AS base,
            coalesce(sum(t.iss_value) FILTER (WHERE t.iss_withheld = 0), 0)::text AS iss,
            count(*) FILTER (WHERE t.iss_withheld > 0)::int AS withheld,
            count(*) FILTER (WHERE t.iss_withheld = 0 AND t.iss_rate IS NOT NULL AND t.iss_rate < $3)::int AS low_rate,
            count(*) FILTER (WHERE t.iss_withheld = 0 AND coalesce(t.iss_value, 0) = 0 AND coalesce(t.service_value, 0) > 0)::int AS no_iss,
            min(t.iss_rate) FILTER (WHERE t.iss_withheld = 0)::text AS min_rate, max(t.iss_rate) FILTER (WHERE t.iss_withheld = 0)::text AS max_rate
       FROM nfse_tax t JOIN nfse_document d ON d.id = t.nfse_id
      WHERE t.entity_id = $1 AND t.role = 'PRESTADA' AND t.parser = $2 AND t.competence >= $4 AND t.competence < $5
        AND (d.access_key IS NULL OR d.access_key NOT IN (SELECT access_key FROM cancelled))
      GROUP BY t.competence, t.incidence_city ORDER BY 1, 2`,
    [entityId, NFSE_TAX_PARSER, ISS_MIN_RATE, floor, current],
  );
  for (const c of iss.rows) {
    const s = subjectOf(regime(c.competence), impeded.get(c.competence));
    if (!s.subject) continue;
    const name = c.city ?? c.code ?? "—";
    const checks: string[] = [];
    if (c.low_rate) checks.push(`${c.low_rate} nota(s) com alíquota de ISS abaixo de ${ISS_MIN_RATE.replace(".", ",")}% (LC 116/2003, art. 8º-A): conferir benefício do município`);
    if (c.no_iss) checks.push(`${c.no_iss} nota(s) sem retenção e sem ISS destacado: conferir isenção, imunidade ou erro na emissão`);
    if (!c.code || !/^\d{7}$/.test(c.code)) {
      rows.push(settle({
        competence: c.competence, tax: "ISSP:0000000", kind: "ISS", place: c.code ?? "", placeName: name, status: "A_CONFERIR", amount: Dec.of(c.iss).toFixed(2),
        due: null, dueReason: null, why: s.why, checks: [...checks, "Município de incidência sem código IBGE nas notas"],
        details: { notes: c.notes, services: c.services, base: c.base, withheldNotes: c.withheld }, responsibility: respOf(c.competence),
      }, ISS_TAX_RE, usedIss));
      continue;
    }
    const amount = Dec.of(c.iss);
    const rule = issRules.find((r) => r.ibge === c.code && r.validFrom <= addMonths(c.competence, 1));
    const due = rule ? dueFor(c.competence, rule.day, rule.adjust) : null;
    const resp = respOf(c.competence);
    if (!rule && amount.gt("0") && resp !== "ANTERIOR") missingIssDue.set(c.code, name);
    rows.push(settle({
      competence: c.competence, tax: `ISSP:${c.code}`, kind: "ISS", place: c.code, placeName: rule?.name ?? name,
      status: amount.isZero() ? (checks.length ? "A_CONFERIR" : "SEM_IMPOSTO") : undefined,
      amount: amount.toFixed(2), due: due?.due ?? null, dueReason: due?.reason ?? null, why: s.why, checks,
      details: { notes: c.notes, services: c.services, base: c.base, withheldNotes: c.withheld, rates: c.min_rate ? { min: c.min_rate, max: c.max_rate } : null, legalBasis: rule?.legalBasis ?? null },
      responsibility: resp,
    }, ISS_TAX_RE, usedIss));
  }

  // ---------------------------------------------------------------- ICMS próprio (prévia)
  const ufs = (await tx.query<{ uf: string }>(
    "SELECT DISTINCT uf FROM establishment WHERE entity_id = $1 AND uf IS NOT NULL AND closed_at IS NULL ORDER BY uf", [entityId],
  )).rows.map((r) => r.uf);
  const matrizUf = (await tx.query<{ uf: string | null }>(
    "SELECT uf FROM establishment WHERE entity_id = $1 AND kind = 'MATRIZ' ORDER BY opened_at NULLS LAST LIMIT 1", [entityId],
  )).rows[0]?.uf ?? ufs[0] ?? null;
  const missingIcmsDue = new Set<string>();
  const rules = `${CFOP_RULES_VERSION}+${CREDIT_RULES_VERSION}`;
  const icms = await tx.query<{ competence: string; debit: string; st: string; out_notes: number; difal: string }>(
    `SELECT i.competence::text, coalesce(sum(i.icms_value), 0)::text AS debit, coalesce(sum(i.st_value), 0)::text AS st,
            count(DISTINCT i.access_key)::int AS out_notes, '0' AS difal
       FROM nfe_item i
      WHERE i.entity_id = $1 AND i.parser = $2 AND i.rules = $3 AND i.competence IS NOT NULL AND i.competence < $5
        AND left(i.issuer_doc, 8) = $4 AND i.cfop ~ '^[567]'
      GROUP BY 1`,
    [entityId, NFE_ITEMS_PARSER, rules, cnpj8, current],
  );
  const cred = await tx.query<{ competence: string; credit: string; ciap: string; to_check: number; in_notes: number }>(
    `SELECT i.competence::text,
            coalesce(sum(c.value) FILTER (WHERE c.status = 'APROPRIAVEL' AND NOT coalesce(i.entry_cfop ~ $5, false)), 0)::text AS credit,
            coalesce(sum(c.value) FILTER (WHERE c.status = 'APROPRIAVEL' AND coalesce(i.entry_cfop ~ $5, false)), 0)::text AS ciap,
            count(*) FILTER (WHERE c.status = 'A_CONFERIR')::int AS to_check, count(DISTINCT i.access_key)::int AS in_notes
       FROM nfe_item_credit c JOIN nfe_item i ON i.id = c.item_id
      WHERE c.entity_id = $1 AND c.tax = 'ICMS' AND i.parser = $2 AND i.rules = $3 AND i.competence IS NOT NULL AND i.competence < $4
      GROUP BY 1`,
    [entityId, NFE_ITEMS_PARSER, rules, current, ASSET_CFOP.source],
  );
  const byComp = new Map<string, { debit: Dec; st: Dec; outNotes: number; credit: Dec; ciap: Dec; toCheck: number; inNotes: number }>();
  const get = (c: string) => {
    let v = byComp.get(c);
    if (!v) { v = { debit: Dec.ZERO, st: Dec.ZERO, outNotes: 0, credit: Dec.ZERO, ciap: Dec.ZERO, toCheck: 0, inNotes: 0 }; byComp.set(c, v); }
    return v;
  };
  for (const r of icms.rows) { const v = get(r.competence); v.debit = Dec.of(r.debit); v.st = Dec.of(r.st); v.outNotes = r.out_notes; }
  for (const r of cred.rows) { const v = get(r.competence); v.credit = Dec.of(r.credit); v.ciap = Dec.of(r.ciap); v.toCheck = r.to_check; v.inNotes = r.in_notes; }
  const icmsRules = await stateIcmsDue(tx);
  let carry = Dec.ZERO;
  let carryKnown = false;
  for (const comp of [...byComp.keys()].sort()) {
    const s = subjectOf(regime(comp), impeded.get(comp));
    if (!s.subject) { carry = Dec.ZERO; carryKnown = false; continue; }
    if (!matrizUf) continue;
    const v = byComp.get(comp)!;
    const carryIn = carry;
    const balance = v.debit.sub(v.credit).sub(carryIn);
    const due = balance.gt("0") ? balance : Dec.ZERO;
    carry = balance.gt("0") ? Dec.ZERO : balance.abs();
    const checks: string[] = [];
    if (!carryKnown) checks.push("Saldo credor de antes do 1º mês com notas na IARIS não informado (considerado zero)");
    carryKnown = true;
    if (ufs.length > 1) checks.push(`Estabelecimentos em mais de uma UF (${ufs.join(", ")}): a apuração é por estabelecimento e não foi separada`);
    if (v.toCheck) checks.push(`${v.toCheck} item(ns) de entrada com crédito de ICMS a conferir (fora da prévia)`);
    if (v.ciap.gt("0")) checks.push(`Crédito de ativo imobilizado de ${v.ciap.toFixed(2)} fora da prévia: entra pelo CIAP (1/48 por mês, LC 87/1996, art. 20, § 5º)`);
    if (v.st.gt("0")) checks.push(`ICMS-ST retido nas saídas de ${v.st.toFixed(2)}: guia própria do substituto, fora deste saldo`);
    checks.push("Prévia: sem ajustes de apuração, estornos, DIFAL e benefícios fiscais; confira com a EFD ICMS/IPI");
    const rule = icmsRules.find((r) => r.uf === matrizUf && r.validFrom <= addMonths(comp, 1));
    const d = rule ? dueFor(comp, rule.day, rule.adjust) : null;
    const resp = respOf(comp);
    if (!rule && due.gt("0") && resp !== "ANTERIOR") missingIcmsDue.add(matrizUf);
    const ufFixed = ufs.length > 1;
    rows.push(settle({
      competence: comp, tax: `ICMS:${matrizUf}`, kind: "ICMS", place: matrizUf, placeName: matrizUf,
      status: ufFixed ? "A_CONFERIR" : due.isZero() ? (carry.gt("0") ? "SALDO_CREDOR" : "SEM_IMPOSTO") : undefined,
      amount: due.toFixed(2), due: d?.due ?? null, dueReason: d?.reason ?? null, why: s.why, checks,
      details: {
        debits: v.debit.toFixed(2), credits: v.credit.toFixed(2), carryIn: carryIn.toFixed(2), carryOut: carry.toFixed(2),
        outNotes: v.outNotes, inNotes: v.inNotes, ciap: v.ciap.toFixed(2), st: v.st.toFixed(2), legalBasis: rule?.legalBasis ?? null,
      },
      responsibility: resp,
    }, ICMS_TAX_RE, usedIcms));
  }

  rows.sort((a, b) => b.competence.localeCompare(a.competence) || a.tax.localeCompare(b.tax));
  return {
    rows,
    missingIssDue: [...missingIssDue.entries()].map(([ibge, name]) => ({ ibge, name })),
    missingIcmsDue: [...missingIcmsDue],
    ufs,
  };
}

/** Grava a situação de cada tributo quando muda (LOCAL_TAX_STATUS_CHANGED) e abre as pendências de prazo. */
export async function refreshLocalTaxes(pool: Pool, tenantId: string, entityId: string, today: string) {
  return withTenant(pool, tenantId, async (tx) => {
    const o = await localTaxesOverview(tx, entityId, today);
    for (const m of o.missingIssDue) {
      await openPendingItem(tx, {
        type: `ISSP_DUE_${m.ibge}`, entityId, responsibleSource: "OFFICE",
        requiredInformation: `Informe o dia de vencimento do ISS próprio em ${m.name} (IBGE ${m.ibge}) e o fundamento (lei ou decreto municipal), na tela da empresa, em ISS e ICMS próprios`,
        impact: "Sem o prazo, a IARIS mostra o ISS devido mas não acompanha vencimento nem pagamento",
      }, LOCAL_TAX_AGENT);
    }
    for (const uf of o.missingIcmsDue) {
      await openPendingItem(tx, {
        type: `ICMS_DUE_${uf}`, entityId, responsibleSource: "OFFICE",
        requiredInformation: `Informe o dia de vencimento do ICMS normal em ${uf} e o fundamento (regulamento do ICMS), na tela da empresa, em ISS e ICMS próprios`,
        impact: "Sem o prazo, a IARIS mostra a prévia do ICMS mas não acompanha vencimento nem pagamento",
      }, LOCAL_TAX_AGENT);
    }
    let changed = 0;
    for (const r of o.rows) {
      const details = { kind: r.kind, placeName: r.placeName, why: r.why, checks: r.checks, dueReason: r.dueReason, payment: r.payment, guide: r.guide, responsibility: r.responsibility, ...r.details };
      const last = await tx.query<{ id: string; fingerprint: string }>(
        "SELECT id, fingerprint FROM local_tax_observation WHERE entity_id = $1 AND competence = $2 AND tax = $3 ORDER BY created_at DESC, id DESC LIMIT 1",
        [entityId, r.competence, r.tax],
      );
      const content = createHash("sha256").update(JSON.stringify({ s: r.status, a: r.amount, p: r.paid, d: r.due, details })).digest("hex");
      const prev = last.rows[0];
      if (prev && prev.fingerprint.startsWith(content)) continue;
      const fingerprint = prev ? `${content}:${prev.id}` : content;
      const ins = await tx.query(
        `INSERT INTO local_tax_observation (id, tenant_id, entity_id, competence, tax, status, amount, paid, due_on, details, fingerprint)
         VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id, entity_id, competence, tax, fingerprint) DO NOTHING`,
        [newId(), entityId, r.competence, r.tax, r.status, r.amount, r.paid, r.due, JSON.stringify(details), fingerprint],
      );
      if (!ins.rowCount) continue;
      changed++;
      await appendEvent(tx, {
        type: "LOCAL_TAX_STATUS_CHANGED",
        schemaVersion: 1,
        producer: PRODUCER,
        idempotencyKey: `tributo-proprio:${entityId}:${ym(r.competence)}:${r.tax}:${fingerprint}`,
        entityId,
        competence: r.competence,
        payload: { entity_id: entityId, competence: r.competence, tax: r.tax, status: r.status, amount: r.amount, paid: r.paid, due: r.due },
      });
    }
    return { taxes: o.rows.length, changed };
  });
}

export async function refreshAllLocalTaxes(pool: Pool, tenantId: string, today: string) {
  const ents = await withTenant(pool, tenantId, (tx) =>
    tx.query<{ id: string }>("SELECT DISTINCT entity_id AS id FROM tax_regime_history WHERE regime <> 'MEI'"));
  let changed = 0;
  for (const e of ents.rows) changed += (await refreshLocalTaxes(pool, tenantId, e.id, today)).changed;
  return { entities: ents.rows.length, changed };
}

/** Situação atual de cada tributo próprio (para a tela). */
export async function localTaxesView(tx: PoolClient, entityId: string, today: string) {
  const o = await localTaxesOverview(tx, entityId, today);
  return { ...o, total: sumDec(o.rows.filter((r) => r.status !== "PAGO").map((r) => Dec.of(r.amount))).toFixed(2), months: [...new Set(o.rows.map((r) => my(r.competence)))].length };
}
