import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { audit } from "../../../platform/audit/audit.js";
import { appendEvent } from "../../../platform/events/outbox.js";
import type { Actor } from "../../../shared/actor.js";
import { Dec, sumDec } from "../../../shared/decimal.js";
import { withTenant } from "../../../shared/db/tenant-tx.js";
import { newId } from "../../../shared/ids.js";
import { calculateSimples, ENGINE_VERSION, rbt12For, type RevenueSegment, type SimplesResult } from "./engine.js";
import { AnnexDefinition, ParamsDefinition, TAXES, checkAnnex, type Tax } from "./rules.js";

/**
 * Apuração do Simples Nacional por competência (agente Tributos, motor determinístico).
 *
 *   CONFERENCIA — competência já declarada: recalcula com a receita declarada e a
 *                 RBT12 declarada e compara com o débito do PDF da declaração
 *                 (ou, sem PDF, com o principal do DAS pago).
 *   APURACAO    — competência fechada e ainda não declarada: receita do mês pelas
 *                 NFS-e prestadas (sem canceladas); meses anteriores pelo declarado
 *                 (é o que o PGDAS-D usa) e, onde faltar, pelas notas.
 *
 * Só usa tabelas aprovadas pelo responsável técnico. Nada é transmitido.
 */

export const TAX_AGENT: Actor = { kind: "AGENT", id: "tax" };
export const SIMPLES_TOLERANCE = "0.05";

export class SimplesActionError extends Error {}

const ym = (d: string) => d.slice(0, 7);
function addMonths(comp: string, n: number): string {
  const y = Number(comp.slice(0, 4));
  const m = Number(comp.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}-01`;
}
const monthsBetween = (a: string, b: string) =>
  (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

// ------------------------------------------------------------------ regras

interface LoadedRule<T> { def: T; ref: string }
export interface SimplesRules {
  annexes: Map<string, LoadedRule<AnnexDefinition>>;
  params: LoadedRule<ParamsDefinition> | null;
  /** códigos com versão proposta ainda não aprovada */
  pending: string[];
}

/** Última versão APROVADA de cada tabela, vigente na competência. */
export async function loadSimplesRules(tx: PoolClient, competence: string, opts: { proposed?: boolean } = {}): Promise<SimplesRules> {
  // proposed = simulação: usa a versão proposta mais recente, sem aprovação (nada é gravado)
  const { rows } = await tx.query<{ code: string; version: number; definition: unknown }>(
    `SELECT DISTINCT ON (r.code) r.code, r.version, r.definition
       FROM simples_rule r
      WHERE r.valid_from <= $1 AND (r.valid_to IS NULL OR r.valid_to >= $1)
        AND ($2 AND r.superseded_at IS NULL OR EXISTS (SELECT 1 FROM simples_rule_approval a WHERE a.rule_id = r.id))
      ORDER BY r.code, r.version DESC`,
    [competence, opts.proposed === true],
  );
  const pend = await tx.query<{ code: string }>(
    `SELECT DISTINCT r.code FROM simples_rule r
      WHERE r.superseded_at IS NULL AND NOT EXISTS (SELECT 1 FROM simples_rule_approval a WHERE a.rule_id = r.id)`,
  );
  const annexes = new Map<string, LoadedRule<AnnexDefinition>>();
  let params: LoadedRule<ParamsDefinition> | null = null;
  for (const r of rows) {
    const ref = `${r.code}@${r.version}`;
    if (r.code === "PARAMETROS") params = { def: ParamsDefinition.parse(r.definition), ref };
    else {
      const def = AnnexDefinition.parse(r.definition);
      const errs = checkAnnex(def);
      if (errs.length) throw new Error(`Tabela ${ref} incoerente: ${errs.join("; ")}`);
      annexes.set(def.annex, { def, ref });
    }
  }
  return { annexes, params, pending: pend.rows.map((r) => r.code).sort() };
}

/** Aprovação das tabelas propostas, pelo responsável técnico. */
export async function approveSimplesRules(pool: Pool, tenantId: string, actor: Actor) {
  if (actor.kind !== "USER") throw new SimplesActionError("Só uma pessoa aprova tabelas de cálculo");
  const approved = await withTenant(pool, tenantId, async (tx) => {
    const pending = await tx.query<{ id: string; code: string; version: number }>(
      `SELECT r.id, r.code, r.version FROM simples_rule r
        WHERE r.superseded_at IS NULL AND NOT EXISTS (SELECT 1 FROM simples_rule_approval a WHERE a.rule_id = r.id)
        ORDER BY r.code`,
    );
    if (!pending.rows.length) return [];
    for (const r of pending.rows) {
      await tx.query("INSERT INTO simples_rule_approval (id, tenant_id, rule_id, approved_by) VALUES ($1, current_tenant(), $2, $3)", [newId(), r.id, actor.id]);
      await audit(tx, {
        actor,
        action: "regulatory.simples_rule_approved",
        resourceType: "simples_rule",
        resourceId: r.id,
        ruleRef: `${r.code}@${r.version}`,
        approvedBy: actor.id,
        data: { code: r.code, version: r.version },
      });
    }
    const refs = pending.rows.map((r) => `${r.code}@${r.version}`);
    await appendEvent(tx, {
      type: "SIMPLES_RULES_APPROVED",
      schemaVersion: 1,
      producer: { kind: "user", name: actor.id, version: "1" },
      idempotencyKey: `simples-regras:${refs.join(",")}`,
      payload: { rules: refs, approved_by: actor.id },
    });
    return refs;
  });
  // O recálculo das empresas é reação ao evento SIMPLES_RULES_APPROVED (Orquestrador).
  return { approved };
}

export async function simplesRulesList(tx: PoolClient) {
  const { rows } = await tx.query(
    `SELECT r.id, r.code, r.version, r.name, r.legal_basis, r.notes, r.valid_from::text, r.superseded_at IS NOT NULL AS superseded,
            a.approved_by, a.approved_at, r.definition
       FROM simples_rule r LEFT JOIN simples_rule_approval a ON a.rule_id = r.id
      ORDER BY r.code, r.version`,
  );
  return rows;
}

// ------------------------------------------------------------------ dados

interface MonthData {
  declared: string | null;
  nfse: string;
  nfseWithheld: string;
  nfseCount: number;
}

async function monthlyData(tx: PoolClient, entityId: string): Promise<Map<string, MonthData>> {
  const { rows } = await tx.query<{ competence: string; declared: string | null; nfse: string | null; withheld: string | null; n: number | null }>(
    `WITH declared AS (
       SELECT DISTINCT ON (competence) competence, total FROM pgdas_declared_revenue
        WHERE entity_id = $1 ORDER BY competence, declared_in DESC, created_at DESC
     ), cancelled AS (
       SELECT DISTINCT access_key FROM nfse_document
        WHERE entity_id = $1 AND role = 'EVENTO' AND access_key IS NOT NULL
          AND (event_type ILIKE '%101101%' OR event_type ILIKE '%105102%' OR event_type ILIKE '%cancel%')
     ), nfse AS (
       SELECT date_trunc('month', issued_at AT TIME ZONE 'America/Sao_Paulo')::date AS competence,
              sum(service_value) AS total,
              coalesce(sum(service_value) FILTER (WHERE iss_withheld), 0) AS withheld,
              count(*)::int AS n
         FROM nfse_document
        WHERE entity_id = $1 AND role = 'PRESTADA' AND issued_at IS NOT NULL
          AND (access_key IS NULL OR access_key NOT IN (SELECT access_key FROM cancelled))
        GROUP BY 1
     )
     SELECT coalesce(d.competence, n.competence)::text AS competence, d.total::text AS declared,
            n.total::text AS nfse, n.withheld::text AS withheld, n.n
       FROM declared d FULL JOIN nfse n ON n.competence = d.competence`,
    [entityId],
  );
  const out = new Map<string, MonthData>();
  for (const r of rows) {
    out.set(r.competence, {
      declared: r.declared,
      nfse: Dec.of(r.nfse ?? "0").toFixed(2),
      nfseWithheld: Dec.of(r.withheld ?? "0").toFixed(2),
      nfseCount: r.n ?? 0,
    });
  }
  return out;
}

interface DeclaredTaxRow {
  competence: string;
  seq: number;
  activity: string;
  annex: string | null;
  local_withheld: boolean | null;
  factor_r: boolean;
  revenue: string;
  total: string;
  rbt12: string | null;
  taxes: Record<Tax, string>;
}

async function declaredTaxes(tx: PoolClient, entityId: string): Promise<Map<string, DeclaredTaxRow[]>> {
  // da declaração mais recente de cada PA
  const { rows } = await tx.query(
    `WITH last AS (
       SELECT DISTINCT ON (competence) competence, pdf_id FROM pgdas_declared_tax
        WHERE entity_id = $1 ORDER BY competence, declaration_number DESC NULLS LAST, created_at DESC
     )
     SELECT t.competence::text, t.seq, t.activity, t.annex, t.local_withheld, t.factor_r,
            t.revenue::text, t.total::text, t.rbt12::text, t.irpj::text, t.csll::text, t.cofins::text, t.pis::text,
            t.cpp::text, t.icms::text, t.ipi::text, t.iss::text
       FROM pgdas_declared_tax t JOIN last l ON l.pdf_id = t.pdf_id AND l.competence = t.competence
      WHERE t.entity_id = $1
        -- leitura da versão mais recente do leitor para esse PDF
        AND t.parser = (SELECT max(x.parser) FROM pgdas_declared_tax x WHERE x.pdf_id = t.pdf_id)
      ORDER BY t.competence, t.seq`,
    [entityId],
  );
  const out = new Map<string, DeclaredTaxRow[]>();
  for (const r of rows) {
    const row: DeclaredTaxRow = {
      competence: r.competence, seq: r.seq, activity: r.activity, annex: r.annex, local_withheld: r.local_withheld, factor_r: r.factor_r,
      revenue: r.revenue, total: r.total, rbt12: r.rbt12,
      taxes: { IRPJ: r.irpj, CSLL: r.csll, COFINS: r.cofins, PIS: r.pis, CPP: r.cpp, ICMS: r.icms, IPI: r.ipi, ISS: r.iss },
    };
    out.set(r.competence, [...(out.get(r.competence) ?? []), row]);
  }
  return out;
}

const PAID_TAX: [RegExp, Tax][] = [
  [/^IRPJ/i, "IRPJ"], [/^CSLL/i, "CSLL"], [/^COFINS/i, "COFINS"], [/^PIS/i, "PIS"],
  [/^(INSS|CPP|Contribui)/i, "CPP"], [/^ICMS/i, "ICMS"], [/^IPI/i, "IPI"], [/^ISS/i, "ISS"],
];

/**
 * Principal do DAS pago por competência (PagtoWeb). Só itens do próprio PA no
 * documento do PA: parcelamentos e débitos antigos pagos depois ficam de fora.
 */
async function paidDas(tx: PoolClient, entityId: string): Promise<Map<string, Record<Tax, string>>> {
  const { rows } = await tx.query<{ competence: string; description: string; principal: string }>(
    `SELECT b->>'competence' AS competence, b->>'revenueDescription' AS description, sum((b->>'principal')::numeric)::text AS principal
       FROM federal_payment p, jsonb_array_elements(p.breakdown) b
      WHERE p.entity_id = $1 AND p.revenue_code = '3333'
        AND b->>'competence' = p.competence::text AND b->>'revenueDescription' ILIKE '%Simples Nacional%'
      GROUP BY 1, 2`,
    [entityId],
  );
  const out = new Map<string, Record<Tax, string>>();
  for (const r of rows) {
    const tax = PAID_TAX.find(([re]) => re.test(r.description))?.[1];
    if (!tax) continue;
    const cur = out.get(r.competence) ?? (Object.fromEntries(TAXES.map((t) => [t, "0.00"])) as Record<Tax, string>);
    cur[tax] = Dec.of(cur[tax]).add(r.principal).toFixed(2);
    out.set(r.competence, cur);
  }
  return out;
}

async function openingMonth(tx: PoolClient, entityId: string): Promise<string | null> {
  const r = await tx.query<{ d: string | null }>(
    "SELECT date_trunc('month', min(opened_at))::date::text AS d FROM establishment WHERE entity_id = $1 AND kind = 'MATRIZ'",
    [entityId],
  );
  return r.rows[0]?.d ?? null;
}

// ------------------------------------------------------------------ cálculo

type Status = "CONFERE" | "DIVERGE" | "CALCULADO" | "SEM_REFERENCIA" | "REGRA_PENDENTE" | "SEM_ANEXO" | "NAO_SUPORTADO";

export interface SimplesComputation {
  competence: string;
  mode: "CONFERENCIA" | "APURACAO";
  status: Status;
  ruleRefs: string[];
  inputs: Record<string, unknown>;
  result: (SimplesResult & { activities?: unknown[] }) | null;
  total: string | null;
  reference: { kind: "DECLARACAO" | "DAS_PAGO"; total: string; taxes: Record<Tax, string> } | null;
  difference: string | null;
  taxDifferences: Partial<Record<Tax, string>>;
  reason: string | null;
}

interface Context {
  months: Map<string, MonthData>;
  declared: Map<string, DeclaredTaxRow[]>;
  paid: Map<string, Record<Tax, string>>;
  opening: string | null;
}

function pickActivities(ctx: Context, competence: string): { rows: DeclaredTaxRow[]; from: string } | null {
  if (ctx.declared.has(competence)) return { rows: ctx.declared.get(competence)!, from: competence };
  const keys = [...ctx.declared.keys()].sort();
  const before = keys.filter((k) => k <= competence).pop();
  const after = keys.find((k) => k > competence);
  const k = before ?? after;
  return k ? { rows: ctx.declared.get(k)!, from: k } : null;
}

function computeOne(ctx: Context, rules: SimplesRules, competence: string, mode: "CONFERENCIA" | "APURACAO"): SimplesComputation {
  const base: SimplesComputation = {
    competence, mode, status: "SEM_ANEXO", ruleRefs: [], inputs: {}, result: null, total: null,
    reference: null, difference: null, taxDifferences: {}, reason: null,
  };
  const month = ctx.months.get(competence)!;
  const value = (c: string) => {
    const m = ctx.months.get(c);
    if (m?.declared != null) return { v: m.declared, src: "DECLARADA" as const };
    if (m && m.nfseCount > 0) return { v: m.nfse, src: "NFSE" as const };
    return { v: "0.00", src: "SEM_DADO" as const };
  };

  // RBT12 (proporcional no início de atividade), RBA e RBAA
  const start = ctx.opening && ctx.opening <= competence ? ctx.opening : null;
  const k = start ? monthsBetween(start, competence) : 12;
  const window: string[] = [];
  for (let i = Math.min(k, 12); i >= 1; i--) window.push(addMonths(competence, -i));
  const windowValues = window.map((c) => ({ c, ...value(c) }));
  const missing = windowValues.filter((w) => w.src === "SEM_DADO").map((w) => ym(w.c));
  const rpaTotal = mode === "CONFERENCIA" ? month.declared! : month.nfse;
  const r12 = k >= 12 ? { rbt12: sumDec(windowValues.map((w) => Dec.of(w.v))).toFixed(2), proportional: false } : rbt12For(windowValues.map((w) => w.v), rpaTotal);
  const year = competence.slice(0, 4);
  let rbaBefore = Dec.ZERO;
  for (let c = `${year}-01-01`; c < competence; c = addMonths(c, 1)) if (!start || c >= start) rbaBefore = rbaBefore.add(value(c).v);
  let rbaa = Dec.ZERO;
  const prevYear = String(Number(year) - 1);
  for (let c = `${prevYear}-01-01`; c < `${year}-01-01`; c = addMonths(c, 1)) if (!start || c >= start) rbaa = rbaa.add(value(c).v);
  const monthsInYear = start && start.slice(0, 4) === year ? 13 - Number(start.slice(5, 7)) : 12;
  const monthsPrevYear = start && start.slice(0, 4) === prevYear ? 13 - Number(start.slice(5, 7)) : start && start.slice(0, 4) > prevYear ? 0 : 12;

  base.inputs = {
    rpa: rpaTotal,
    rpaSource: mode === "CONFERENCIA" ? "DECLARADA" : "NFSE",
    nfse: month.nfse,
    nfseWithheld: month.nfseWithheld,
    rbt12: Dec.of(r12.rbt12).toFixed(2),
    rbt12Proportional: r12.proportional,
    rbaBefore: rbaBefore.toFixed(2),
    rbaa: rbaa.toFixed(2),
    opening: ctx.opening,
    sources: Object.fromEntries(windowValues.map((w) => [ym(w.c), w.src])),
    missingMonths: missing,
  };

  // Referência (só na conferência)
  if (mode === "CONFERENCIA") {
    const d = ctx.declared.get(competence);
    const paid = ctx.paid.get(competence);
    if (d) {
      const taxes = Object.fromEntries(TAXES.map((t) => [t, sumDec(d.map((x) => Dec.of(x.taxes[t]))).toFixed(2)])) as Record<Tax, string>;
      base.reference = { kind: "DECLARACAO", total: sumDec(d.map((x) => Dec.of(x.total))).toFixed(2), taxes };
    } else if (paid) {
      base.reference = { kind: "DAS_PAGO", total: sumDec(Object.values(paid).map((v) => Dec.of(v))).toFixed(2), taxes: paid };
    }
  }

  const acts = pickActivities(ctx, competence);
  if (!acts) return { ...base, status: "SEM_ANEXO", reason: "Sem declaração com a atividade (anexo) da empresa: buscar uma declaração do PGDAS-D" };
  base.inputs.activitiesFrom = ym(acts.from);
  if (acts.rows.some((a) => !a.annex)) return { ...base, status: "SEM_ANEXO", reason: "Atividade da declaração sem anexo identificado" };
  if (acts.rows.some((a) => a.factor_r)) return { ...base, status: "NAO_SUPORTADO", reason: "Atividade sujeita ao fator r (folha ainda não integrada)" };
  if (mode === "APURACAO" && acts.rows.length > 1) return { ...base, status: "NAO_SUPORTADO", reason: "Mais de uma atividade: a separação da receita das notas por atividade ainda não é automática" };
  if (!rules.params) return { ...base, status: "REGRA_PENDENTE", reason: "Parâmetros do Simples (limite e sublimite) ainda não aprovados" };
  const missingAnnex = acts.rows.map((a) => a.annex!).filter((a) => !rules.annexes.has(a));
  if (missingAnnex.length) return { ...base, status: "REGRA_PENDENTE", reason: `Tabela do Anexo ${missingAnnex.join(", ")} ainda não aprovada` };

  const ruleRefs = [rules.params.ref, ...new Set(acts.rows.map((a) => rules.annexes.get(a.annex!)!.ref))];
  base.ruleRefs = ruleRefs;

  // Receita por atividade: na conferência, a declarada em cada atividade quando a
  // declaração é do próprio PA; senão, a receita do mês inteira na atividade única.
  const own = ctx.declared.has(competence);
  const segmentsFor = (a: DeclaredTaxRow): RevenueSegment[] => {
    if (mode === "CONFERENCIA") return [{ value: own ? a.revenue : rpaTotal, localWithheld: a.local_withheld === true }];
    const withheld = Dec.of(month.nfseWithheld);
    const free = Dec.of(month.nfse).sub(withheld);
    const segs: RevenueSegment[] = [];
    if (free.gt("0")) segs.push({ value: free.toFixed(2) });
    if (withheld.gt("0")) segs.push({ value: withheld.toFixed(2), localWithheld: true });
    return segs.length ? segs : [{ value: "0.00" }];
  };
  if (mode === "CONFERENCIA" && !own && acts.rows.length > 1)
    return { ...base, status: "NAO_SUPORTADO", reason: "Mais de uma atividade e sem a declaração do próprio mês" };

  const results: SimplesResult[] = [];
  let before = rbaBefore;
  for (const a of acts.rows) {
    const segs = segmentsFor(a);
    const r = calculateSimples({
      annex: rules.annexes.get(a.annex!)!.def,
      params: rules.params.def,
      rpa: segs,
      rbt12: r12.rbt12,
      rbaBefore: before.toFixed(2),
      rbaa: rbaa.toFixed(2),
      monthsInYear,
      monthsPrevYear,
    });
    if (!r.ok) return { ...base, status: "NAO_SUPORTADO", reason: r.reason };
    results.push(r);
    before = before.add(sumDec(segs.map((s) => Dec.of(s.value))));
  }
  const taxes = Object.fromEntries(TAXES.map((t) => [t, sumDec(results.map((r) => (r.ok ? Dec.of(r.taxes[t]) : Dec.ZERO))).toFixed(2)])) as Record<Tax, string>;
  const total = sumDec(Object.values(taxes).map((v) => Dec.of(v))).toFixed(2);
  const first = results[0]!;
  const result = {
    ...first,
    taxes,
    total,
    activities: acts.rows.map((a, i) => ({ seq: a.seq, annex: a.annex, activity: a.activity, result: results[i] })),
    notes: [...new Set(results.flatMap((r) => (r.ok ? r.notes : [])))],
  } as SimplesComputation["result"];

  const out: SimplesComputation = { ...base, ruleRefs, result, total };
  const declaredRbt12 = own ? acts.rows[0]!.rbt12 : null;
  if (declaredRbt12 && !Dec.of(declaredRbt12).sub(r12.rbt12).round(2).isZero()) {
    base.inputs.rbt12Declared = declaredRbt12;
    out.reason = `RBT12 da declaração (${declaredRbt12}) difere da soma dos meses declarados (${Dec.of(r12.rbt12).toFixed(2)})`;
  }
  if (mode === "APURACAO") {
    if (missing.length) out.reason = `Meses sem receita conhecida (contados como zero): ${missing.join(", ")}`;
    return { ...out, status: "CALCULADO" };
  }
  if (!base.reference) return { ...out, status: "SEM_REFERENCIA", reason: out.reason ?? "Sem débito declarado nem DAS pago para comparar" };
  const diff = Dec.of(total).sub(base.reference.total);
  out.difference = diff.toFixed(2);
  let ok = Dec.of(diff.toFixed(2).replace("-", "")).lte(SIMPLES_TOLERANCE);
  for (const t of TAXES) {
    const d = Dec.of(taxes[t]).sub(base.reference.taxes[t]);
    if (!d.isZero()) out.taxDifferences[t] = d.toFixed(2);
    if (Dec.of(d.toFixed(2).replace("-", "")).gt(SIMPLES_TOLERANCE)) ok = false;
  }
  return { ...out, status: ok ? "CONFERE" : "DIVERGE" };
}

/** Recalcula todas as competências da empresa e grava o que mudou. */
async function computeAll(tx: PoolClient, entityId: string, now: Date, proposed: boolean): Promise<SimplesComputation[]> {
  const ctx: Context = {
    months: await monthlyData(tx, entityId),
    declared: await declaredTaxes(tx, entityId),
    paid: await paidDas(tx, entityId),
    opening: await openingMonth(tx, entityId),
  };
  const firstDeclared = [...ctx.months.entries()].filter(([, m]) => m.declared != null).map(([c]) => c).sort()[0];
  if (!firstDeclared) return [];
  const current = `${now.toISOString().slice(0, 7)}-01`;
  const out: SimplesComputation[] = [];
  for (const [competence, m] of [...ctx.months.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const declared = m.declared != null;
    if (declared && Dec.of(m.declared!).isZero() && m.nfseCount === 0) continue;
    if (!declared && (m.nfseCount === 0 || competence < firstDeclared || competence >= current)) continue;
    const rules = await loadSimplesRules(tx, competence, { proposed });
    out.push(computeOne(ctx, rules, competence, declared ? "CONFERENCIA" : "APURACAO"));
  }
  return out;
}

export async function refreshSimples(pool: Pool, tenantId: string, entityId: string, now: Date = new Date()) {
  return withTenant(pool, tenantId, async (tx) => {
    const all = await computeAll(tx, entityId, now, false);
    let changed = 0;
    for (const c of all) if (await storeComputation(tx, entityId, c)) changed++;
    return { calculated: all.length, changed };
  });
}

/** Simulação com as tabelas PROPOSTAS (antes da aprovação). Não grava nada. */
export async function simulateSimples(tx: PoolClient, entityId: string, now: Date = new Date()) {
  return computeAll(tx, entityId, now, true);
}

export async function refreshAllSimples(pool: Pool, tenantId: string, now: Date = new Date()): Promise<number> {
  const ents = await withTenant(pool, tenantId, (tx) =>
    tx.query<{ id: string }>("SELECT DISTINCT entity_id AS id FROM pgdas_declared_revenue"),
  );
  let n = 0;
  for (const e of ents.rows) n += (await refreshSimples(pool, tenantId, e.id, now)).changed;
  return n;
}

async function storeComputation(tx: PoolClient, entityId: string, c: SimplesComputation): Promise<boolean> {
  const stored = {
    inputs: c.inputs,
    result: c.result ? { ...c.result, reason: c.reason, reference: c.reference, taxDifferences: c.taxDifferences } : { reason: c.reason, reference: c.reference },
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ m: c.mode, s: c.status, r: c.ruleRefs, e: ENGINE_VERSION, ...stored, t: c.total }))
    .digest("hex");
  const ins = await tx.query(
    `INSERT INTO simples_calculation (id, tenant_id, entity_id, competence, mode, status, rule_refs, engine_version, inputs, result,
                                      total, reference_kind, reference_total, difference, fingerprint)
     VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (tenant_id, entity_id, competence, fingerprint) DO NOTHING`,
    [newId(), entityId, c.competence, c.mode, c.status, c.ruleRefs, ENGINE_VERSION, JSON.stringify(stored.inputs), JSON.stringify(stored.result),
     c.total, c.reference?.kind ?? null, c.reference?.total ?? null, c.difference, fingerprint],
  );
  if (!ins.rowCount) return false;
  await appendEvent(tx, {
    type: "SIMPLES_CALCULATED",
    schemaVersion: 1,
    producer: { kind: "agent", name: "tax", version: ENGINE_VERSION },
    idempotencyKey: `simples:${entityId}:${ym(c.competence)}:${fingerprint}`,
    entityId,
    competence: c.competence,
    payload: {
      entity_id: entityId,
      competence: c.competence,
      mode: c.mode,
      status: c.status,
      total: c.total,
      reference_total: c.reference?.total ?? null,
      difference: c.difference,
      rules: c.ruleRefs,
    },
  });
  return true;
}

/** Último cálculo de cada competência (mais recente primeiro). */
export async function simplesOverview(tx: PoolClient, entityId: string) {
  const { rows } = await tx.query(
    `SELECT DISTINCT ON (competence) competence::text, mode, status, rule_refs, engine_version, inputs, result,
            total::text, reference_kind, reference_total::text, difference::text, created_at
       FROM simples_calculation WHERE entity_id = $1
      ORDER BY competence DESC, created_at DESC`,
    [entityId],
  );
  return rows;
}
