import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { NFE_ITEMS_PARSER } from "../../../integrations/sefaz/nfe-items.js";
import { NFSE_TAX_PARSER } from "../../../integrations/nfse/nfse-taxes.js";
import { audit } from "../../../platform/audit/audit.js";
import { appendEvent } from "../../../platform/events/outbox.js";
import { resolvePendingItem } from "../../../platform/pending/pending.js";
import type { Actor } from "../../../shared/actor.js";
import { Dec } from "../../../shared/decimal.js";
import { withTenant } from "../../../shared/db/tenant-tx.js";
import { newId } from "../../../shared/ids.js";
import { CFOP_RULES_VERSION, CREDIT_RULES_VERSION, isSaleCfop } from "../../fiscal/cfop-rules.js";
import { loadCalendar } from "../../regulatory/calendar.js";
import {
  brlCorporate as brl, CORPORATE_ENGINE, csllDue, irpjDue, lc224Limits, presumedBase, quarterOf, quarterStart, quotasFor, realProfit, splitCsrf,
  type IrpjCsllRates, type Lc224, type PresumptionGroup,
} from "./engine.js";

/**
 * Agente Tributos — Lucro Presumido e Lucro Real.
 *
 *   Presumido      PIS 0,65% e COFINS 3% mensais (cumulativo); IRPJ e CSLL
 *                  trimestrais sobre a base presumida (com a LC 224/2025).
 *   Real trimestral IRPJ e CSLL sobre o lucro do razão + e-LALUR (Parte A),
 *                  compensação com trava de 30% (Parte B); PIS 1,65% e COFINS
 *                  7,6% não cumulativos com créditos.
 *   Real anual     estimativa mensal pela receita bruta e ajuste anual.
 *
 * Receita das notas (NFS-e prestadas e NF-e de venda) por mês de emissão;
 * retenções sofridas deduzidas; pagamento conferido no PagtoWeb pelo código do
 * DARF. Só lê as fontes e grava a própria fotografia — não emite guia, não
 * transmite, não lança no razão.
 */

const TAX_AGENT: Actor = { kind: "AGENT", id: "tax" };
const MAX_MONTHS = 24;
type Regime = "LUCRO_PRESUMIDO" | "LUCRO_REAL_TRIMESTRAL" | "LUCRO_REAL_ANUAL";
const REGIMES: Regime[] = ["LUCRO_PRESUMIDO", "LUCRO_REAL_TRIMESTRAL", "LUCRO_REAL_ANUAL"];
type Tax = "IRPJ" | "CSLL" | "PIS" | "COFINS";

export class CorporateTaxError extends Error {}

// ------------------------------------------------------------------ regras

interface Rule<T> { def: T; ref: string }
export interface CorporateRules {
  presuncao: Rule<{ groups: Record<string, PresumptionGroup> }> | null;
  lc224: Rule<Lc224 & { appliesToEstimate: boolean }> | null;
  rates: Rule<IrpjCsllRates> | null;
  cumulative: Rule<{ pis: string; cofins: string; excludeIcms: boolean; monophasicZero: boolean }> | null;
  noncumulative: Rule<{ pis: string; cofins: string; financialPis: string; financialCofins: string; excludeIcms: boolean; monophasicZero: boolean }> | null;
  loss: Rule<{ limit: string }> | null;
  payment: Rule<{ pisCofinsDay: number; minQuota: string; singleBelow: string; maxQuotas: number }> | null;
  darf: Rule<Record<string, Record<string, string>>> | null;
  pending: string[];
}

const RULE_KEY: Record<string, keyof Omit<CorporateRules, "pending">> = {
  PRESUNCAO: "presuncao", PRESUNCAO_LC224: "lc224", IRPJ_CSLL: "rates", PIS_COFINS_CUMULATIVO: "cumulative",
  PIS_COFINS_NAO_CUMULATIVO: "noncumulative", COMPENSACAO_PREJUIZO: "loss", PAGAMENTO: "payment", DARF_CODIGOS: "darf",
};

/** Última versão APROVADA de cada regra vigente na data. */
export async function loadCorporateRules(tx: PoolClient, on: string): Promise<CorporateRules> {
  const { rows } = await tx.query<{ code: string; version: number; definition: unknown }>(
    `SELECT DISTINCT ON (r.code) r.code, r.version, r.definition FROM corporate_tax_rule r
      WHERE r.valid_from <= $1 AND (r.valid_to IS NULL OR r.valid_to >= $1)
        AND EXISTS (SELECT 1 FROM corporate_tax_rule_approval a WHERE a.rule_id = r.id)
      ORDER BY r.code, r.version DESC`,
    [on],
  );
  const pend = await tx.query<{ code: string }>(
    `SELECT DISTINCT r.code FROM corporate_tax_rule r
      WHERE r.superseded_at IS NULL AND NOT EXISTS (SELECT 1 FROM corporate_tax_rule_approval a WHERE a.rule_id = r.id) ORDER BY 1`,
  );
  const out: CorporateRules = { presuncao: null, lc224: null, rates: null, cumulative: null, noncumulative: null, loss: null, payment: null, darf: null, pending: pend.rows.map((r) => r.code) };
  for (const r of rows) {
    const k = RULE_KEY[r.code];
    if (k) (out as unknown as Record<string, Rule<unknown>>)[k] = { def: r.definition, ref: `${r.code}@${r.version}` };
  }
  return out;
}

export async function corporateRulesList(tx: PoolClient) {
  const { rows } = await tx.query(
    `SELECT r.id, r.code, r.version, r.name, r.legal_basis, r.notes, r.valid_from::text, r.valid_to::text, r.superseded_at IS NOT NULL AS superseded,
            a.approved_by, a.approved_at, r.definition
       FROM corporate_tax_rule r LEFT JOIN corporate_tax_rule_approval a ON a.rule_id = r.id
      ORDER BY r.code, r.version DESC`,
  );
  return rows;
}

/** Aprovação das regras propostas, pelo responsável técnico. */
export async function approveCorporateRules(pool: Pool, tenantId: string, actor: Actor) {
  if (actor.kind !== "USER") throw new CorporateTaxError("Só uma pessoa aprova regras de cálculo");
  return withTenant(pool, tenantId, async (tx) => {
    const pending = await tx.query<{ id: string; code: string; version: number }>(
      `SELECT r.id, r.code, r.version FROM corporate_tax_rule r
        WHERE r.superseded_at IS NULL AND NOT EXISTS (SELECT 1 FROM corporate_tax_rule_approval a WHERE a.rule_id = r.id) ORDER BY r.code`,
    );
    if (!pending.rows.length) return { approved: [] as string[] };
    for (const r of pending.rows) {
      await tx.query("INSERT INTO corporate_tax_rule_approval (id, tenant_id, rule_id, approved_by) VALUES ($1, current_tenant(), $2, $3)", [newId(), r.id, actor.id]);
      await audit(tx, { actor, action: "regulatory.corporate_rule_approved", resourceType: "corporate_tax_rule", resourceId: r.id,
        ruleRef: `${r.code}@${r.version}`, approvedBy: actor.id, data: { code: r.code, version: r.version } });
    }
    const refs = pending.rows.map((r) => `${r.code}@${r.version}`);
    await appendEvent(tx, {
      type: "CORPORATE_TAX_RULES_APPROVED", schemaVersion: 1, producer: { kind: "user", name: actor.id, version: "1" },
      idempotencyKey: `lucro-regras:${refs.join(",")}`, payload: { rules: refs, approved_by: actor.id },
    });
    return { approved: refs };
  });
}

// ------------------------------------------------------------------ configuração da empresa (decisões de pessoa)

const iso = (d: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new CorporateTaxError("Data inválida (use AAAA-MM-DD)");
  return d;
};
const dayBefore = (d: string) => new Date(new Date(`${d}T12:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);

async function setupChanged(tx: PoolClient, entityId: string, what: string, actor: Actor) {
  await appendEvent(tx, {
    type: "CORPORATE_TAX_SETUP_CHANGED", schemaVersion: 1, producer: { kind: "user", name: actor.id, version: "1" },
    idempotencyKey: `lucro-config:${entityId}:${what}:${newId()}`, entityId, payload: { entity_id: entityId, what, by: actor.id },
  });
}

/** Regime da empresa (Presumido ou Real) a partir de uma data; encerra o anterior no dia anterior. */
export async function defineCorporateRegime(
  pool: Pool, tenantId: string, input: { entityId: string; regime: string; validFrom: string; pendingItemId?: string | null }, actor: Actor,
) {
  if (actor.kind !== "USER") throw new CorporateTaxError("Regime tributário é informado por uma pessoa");
  if (!REGIMES.includes(input.regime as Regime)) throw new CorporateTaxError("Regime deve ser Lucro Presumido, Lucro Real trimestral ou Lucro Real anual");
  const from = iso(input.validFrom);
  if (from.slice(8) !== "01") throw new CorporateTaxError("O regime começa no dia 1º de um mês");
  return withTenant(pool, tenantId, async (tx) => {
    const cur = await tx.query<{ id: string; regime: string; valid_from: string }>(
      "SELECT id, regime, valid_from::text FROM tax_regime_history WHERE entity_id = $1 AND (valid_to IS NULL OR valid_to >= $2) ORDER BY valid_from DESC",
      [input.entityId, from],
    );
    for (const c of cur.rows) {
      if (c.valid_from >= from) throw new CorporateTaxError(`Já existe regime ${c.regime} desde ${c.valid_from.split("-").reverse().join("/")}: informe uma data posterior`);
      await tx.query("UPDATE tax_regime_history SET valid_to = $2 WHERE id = $1", [c.id, dayBefore(from)]);
    }
    const id = newId();
    await tx.query(
      "INSERT INTO tax_regime_history (id, tenant_id, entity_id, regime, valid_from, source) VALUES ($1, current_tenant(), $2, $3, $4, $5)",
      [id, input.entityId, input.regime, from, `pessoa:${actor.id}`],
    );
    await audit(tx, { actor, action: "tax_regime_history.add", resourceType: "tax_regime_history", resourceId: id, entityId: input.entityId,
      data: { regime: input.regime, valid_from: from, closed: cur.rows.map((c) => c.regime) } });
    const pend = input.pendingItemId
      ? [input.pendingItemId]
      : (await tx.query<{ id: string }>("SELECT id FROM pending_item WHERE entity_id = $1 AND type = 'TAX_REGIME_UNKNOWN' AND status = 'OPEN'", [input.entityId])).rows.map((r) => r.id);
    for (const p of pend) await resolvePendingItem(tx, { id: p, resolution: `Regime informado: ${input.regime} desde ${from}` }, actor);
    await appendEvent(tx, {
      type: "TAX_REGIME_DEFINED", schemaVersion: 1, producer: { kind: "user", name: actor.id, version: "1" },
      idempotencyKey: `regime:${input.entityId}:${input.regime}:${from}`, entityId: input.entityId,
      payload: { entity_id: input.entityId, regime: input.regime, valid_from: from, by: actor.id },
    });
    return { regime: input.regime, validFrom: from };
  });
}

/** Grupo de presunção de uma fonte de receita (NFSE ou NFE), a partir de uma data. */
export async function definePresumption(
  pool: Pool, tenantId: string, input: { entityId: string; scope: string; group: string; validFrom: string; reason: string }, actor: Actor,
) {
  if (actor.kind !== "USER") throw new CorporateTaxError("A atividade para a presunção é confirmada por uma pessoa");
  if (!["NFSE", "NFE"].includes(input.scope)) throw new CorporateTaxError("Fonte deve ser NFSE ou NFE");
  const from = iso(input.validFrom);
  if (input.reason.trim().length < 3) throw new CorporateTaxError("Escreva o motivo (ex.: atividade do contrato social, solução de consulta)");
  return withTenant(pool, tenantId, async (tx) => {
    const rules = await loadCorporateRules(tx, from);
    const groups = rules.presuncao?.def.groups ?? (await proposedGroups(tx));
    if (!groups[input.group]) throw new CorporateTaxError(`Grupo de presunção desconhecido: ${input.group}`);
    const cur = await tx.query<{ id: string; valid_from: string }>(
      "SELECT id, valid_from::text FROM entity_presumption WHERE entity_id = $1 AND scope = $2 AND (valid_to IS NULL OR valid_to >= $3)",
      [input.entityId, input.scope, from],
    );
    for (const c of cur.rows) {
      if (c.valid_from >= from) throw new CorporateTaxError("Já existe presunção definida a partir dessa data ou depois");
      await tx.query("UPDATE entity_presumption SET valid_to = $2 WHERE id = $1", [c.id, dayBefore(from)]);
    }
    const id = newId();
    await tx.query(
      `INSERT INTO entity_presumption (id, tenant_id, entity_id, scope, grp, valid_from, reason, set_by)
       VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7)`,
      [id, input.entityId, input.scope, input.group, from, input.reason.trim(), actor.id],
    );
    await audit(tx, { actor, action: "tax.presumption_defined", resourceType: "entity_presumption", resourceId: id, entityId: input.entityId,
      data: { scope: input.scope, group: input.group, valid_from: from, reason: input.reason.trim() } });
    await setupChanged(tx, input.entityId, "presuncao", actor);
    return { id };
  });
}

async function proposedGroups(tx: PoolClient): Promise<Record<string, PresumptionGroup>> {
  const r = await tx.query<{ definition: { groups: Record<string, PresumptionGroup> } }>(
    "SELECT definition FROM corporate_tax_rule WHERE code = 'PRESUNCAO' ORDER BY version DESC LIMIT 1",
  );
  return r.rows[0]?.definition.groups ?? {};
}

/** Opção do ano: quotas do IRPJ/CSLL trimestral e base da receita (competência ou caixa). */
export async function setCorporateOption(
  pool: Pool, tenantId: string, input: { entityId: string; year: number; quotas: string; revenueBasis: string }, actor: Actor,
) {
  if (actor.kind !== "USER") throw new CorporateTaxError("A opção do ano é decisão de uma pessoa");
  if (!["UNICA", "TRES"].includes(input.quotas)) throw new CorporateTaxError("Quotas: UNICA ou TRES");
  if (!["COMPETENCIA", "CAIXA"].includes(input.revenueBasis)) throw new CorporateTaxError("Receita: COMPETENCIA ou CAIXA");
  return withTenant(pool, tenantId, async (tx) => {
    const id = newId();
    await tx.query(
      `INSERT INTO corporate_tax_option (id, tenant_id, entity_id, year, real_annual_basis, quotas, revenue_basis, set_by)
       VALUES ($1, current_tenant(), $2, $3, 'RECEITA_BRUTA', $4, $5, $6)`,
      [id, input.entityId, input.year, input.quotas, input.revenueBasis, actor.id],
    );
    await audit(tx, { actor, action: "tax.corporate_option_set", resourceType: "corporate_tax_option", resourceId: id, entityId: input.entityId, data: input });
    await setupChanged(tx, input.entityId, "opcao", actor);
    return { id };
  });
}

/** e-LALUR/e-LACS Parte A: adição ou exclusão do período (pessoa, com fundamento). `cancels` cancela uma linha. */
export async function addLalurEntry(
  pool: Pool, tenantId: string,
  input: { entityId: string; periodStart: string; periodEnd: string; tax: string; kind: string; description: string; amount: string; legalBasis: string; partB?: string | null; accountCode?: string | null; cancels?: string | null },
  actor: Actor,
) {
  if (actor.kind !== "USER") throw new CorporateTaxError("Ajuste do e-LALUR é lançado por uma pessoa");
  return withTenant(pool, tenantId, async (tx) => {
    const id = newId();
    if (input.cancels) {
      const o = await tx.query("SELECT * FROM lalur_entry WHERE id = $1 AND entity_id = $2 AND cancels_id IS NULL", [input.cancels, input.entityId]);
      if (!o.rows[0]) throw new CorporateTaxError("Ajuste não encontrado");
      const r = o.rows[0] as Record<string, unknown>;
      await tx.query(
        `INSERT INTO lalur_entry (id, tenant_id, entity_id, period_start, period_end, tax, kind, description, amount, legal_basis, part_b, account_code, cancels_id, created_by)
         VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [id, input.entityId, r.period_start, r.period_end, r.tax, r.kind, `Cancelamento: ${String(r.description)}`, r.amount, r.legal_basis, r.part_b, r.account_code, input.cancels, actor.id],
      );
    } else {
      if (!["IRPJ", "CSLL", "AMBOS"].includes(input.tax)) throw new CorporateTaxError("Tributo: IRPJ, CSLL ou AMBOS");
      if (!["ADICAO", "EXCLUSAO"].includes(input.kind)) throw new CorporateTaxError("Tipo: ADICAO ou EXCLUSAO");
      if (!Dec.of(input.amount || "0").gt("0")) throw new CorporateTaxError("Valor deve ser maior que zero");
      if ((input.legalBasis ?? "").trim().length < 3) throw new CorporateTaxError("Informe o fundamento legal");
      await tx.query(
        `INSERT INTO lalur_entry (id, tenant_id, entity_id, period_start, period_end, tax, kind, description, amount, legal_basis, part_b, account_code, created_by)
         VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [id, input.entityId, iso(input.periodStart), iso(input.periodEnd), input.tax, input.kind, input.description.trim(), Dec.of(input.amount).toFixed(2),
          input.legalBasis.trim(), input.partB?.trim() || null, input.accountCode?.trim() || null, actor.id],
      );
    }
    await audit(tx, { actor, action: input.cancels ? "tax.lalur_entry_cancelled" : "tax.lalur_entry_added", resourceType: "lalur_entry", resourceId: id, entityId: input.entityId, data: input });
    await setupChanged(tx, input.entityId, "lalur", actor);
    return { id };
  });
}

/** Parte B: prejuízo fiscal / base negativa herdados (ECF anterior). */
export async function addLalurOpening(
  pool: Pool, tenantId: string, input: { entityId: string; kind: string; amount: string; asOf: string; evidence: string; cancels?: string | null }, actor: Actor,
) {
  if (actor.kind !== "USER") throw new CorporateTaxError("Saldo da Parte B é informado por uma pessoa");
  return withTenant(pool, tenantId, async (tx) => {
    const id = newId();
    if (input.cancels) {
      const o = (await tx.query("SELECT * FROM lalur_opening WHERE id = $1 AND entity_id = $2 AND cancels_id IS NULL", [input.cancels, input.entityId])).rows[0] as Record<string, unknown> | undefined;
      if (!o) throw new CorporateTaxError("Saldo não encontrado");
      await tx.query(
        "INSERT INTO lalur_opening (id, tenant_id, entity_id, kind, amount, as_of, evidence, cancels_id, created_by) VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8)",
        [id, input.entityId, o.kind, o.amount, o.as_of, `Cancelamento: ${String(o.evidence)}`, input.cancels, actor.id],
      );
    } else {
      if (!["PREJUIZO_FISCAL", "BASE_NEGATIVA_CSLL"].includes(input.kind)) throw new CorporateTaxError("Tipo: PREJUIZO_FISCAL ou BASE_NEGATIVA_CSLL");
      if (!Dec.of(input.amount || "0").gt("0")) throw new CorporateTaxError("Valor deve ser maior que zero");
      if ((input.evidence ?? "").trim().length < 3) throw new CorporateTaxError("Informe a origem do saldo (ex.: ECF 2025, registro M410)");
      await tx.query(
        "INSERT INTO lalur_opening (id, tenant_id, entity_id, kind, amount, as_of, evidence, created_by) VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7)",
        [id, input.entityId, input.kind, Dec.of(input.amount).toFixed(2), iso(input.asOf), input.evidence.trim(), actor.id],
      );
    }
    await audit(tx, { actor, action: "tax.lalur_opening", resourceType: "lalur_opening", resourceId: id, entityId: input.entityId, data: input });
    await setupChanged(tx, input.entityId, "parte-b", actor);
    return { id };
  });
}

/** Base de crédito do PIS/COFINS não cumulativo fora das NF-e. */
export async function addCreditEntry(
  pool: Pool, tenantId: string, input: { entityId: string; competence: string; kind: string; base: string; description: string; legalBasis: string; cancels?: string | null }, actor: Actor,
) {
  if (actor.kind !== "USER") throw new CorporateTaxError("Base de crédito é lançada por uma pessoa");
  return withTenant(pool, tenantId, async (tx) => {
    const id = newId();
    if (input.cancels) {
      const o = (await tx.query("SELECT * FROM pis_cofins_credit_entry WHERE id = $1 AND entity_id = $2 AND cancels_id IS NULL", [input.cancels, input.entityId])).rows[0] as Record<string, unknown> | undefined;
      if (!o) throw new CorporateTaxError("Crédito não encontrado");
      await tx.query(
        `INSERT INTO pis_cofins_credit_entry (id, tenant_id, entity_id, competence, kind, base, description, legal_basis, cancels_id, created_by)
         VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, input.entityId, o.competence, o.kind, o.base, `Cancelamento: ${String(o.description)}`, o.legal_basis, input.cancels, actor.id],
      );
    } else {
      const comp = `${iso(input.competence).slice(0, 7)}-01`;
      if (!Dec.of(input.base || "0").gt("0")) throw new CorporateTaxError("Base deve ser maior que zero");
      await tx.query(
        `INSERT INTO pis_cofins_credit_entry (id, tenant_id, entity_id, competence, kind, base, description, legal_basis, created_by)
         VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8)`,
        [id, input.entityId, comp, input.kind, Dec.of(input.base).toFixed(2), input.description.trim(), input.legalBasis.trim(), actor.id],
      );
    }
    await audit(tx, { actor, action: "tax.credit_entry", resourceType: "pis_cofins_credit_entry", resourceId: id, entityId: input.entityId, data: input });
    await setupChanged(tx, input.entityId, "creditos", actor);
    return { id };
  });
}

// ------------------------------------------------------------------ fontes

const monthEnd = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
const addMonths = (comp: string, n: number) => {
  const d = new Date(`${comp.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7) + "-01";
};
const mm = (c: string) => `${c.slice(5, 7)}/${c.slice(0, 4)}`;
const RETURN_CFOP = /^[12](20[1-9]|41[01])$/;

export interface MonthRevenue {
  month: string;
  nfse: string;
  nfseCount: number;
  nfe: string;
  nfeCount: number;
  returns: string;
  icms: string;
  monophasic: string;
  irrf: string;
  csrf: string;
}

/** Receita bruta do mês pelas notas (mês de emissão), devoluções, ICMS, monofásico e retenções sofridas. */
export async function monthRevenue(tx: PoolClient, entityId: string, cnpj8: string, month: string): Promise<MonthRevenue> {
  const from = `${month.slice(0, 7)}-01`;
  const to = monthEnd(from);
  const n = (await tx.query<{ total: string; n: number; irrf: string; csrf: string }>(
    `WITH cancelled AS (
       SELECT DISTINCT access_key FROM nfse_document
        WHERE entity_id = $1 AND role = 'EVENTO' AND access_key IS NOT NULL
          AND (event_type ILIKE '%101101%' OR event_type ILIKE '%105102%' OR event_type ILIKE '%cancel%'))
     SELECT coalesce(sum(d.service_value - coalesce(t.unconditional_discount, 0)), 0)::text AS total, count(*)::int AS n,
            coalesce(sum(t.irrf), 0)::text AS irrf, coalesce(sum(t.csrf), 0)::text AS csrf
       FROM nfse_document d LEFT JOIN nfse_tax t ON t.nfse_id = d.id AND t.parser = $4
      WHERE d.entity_id = $1 AND d.role = 'PRESTADA' AND d.service_value > 0
        AND (d.issued_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2 AND $3
        AND NOT (d.access_key IS NOT NULL AND d.access_key IN (SELECT access_key FROM cancelled))`,
    [entityId, from, to, NFSE_TAX_PARSER],
  )).rows[0]!;
  const rules = `${CFOP_RULES_VERSION}+${CREDIT_RULES_VERSION}`;
  const items = await tx.query<{ cfop: string | null; direction: string; mine: boolean; total: string; icms: string; mono: string; notes: number }>(
    `SELECT cfop, direction, left(issuer_doc, 8) = $4 AS mine, sum(total - discount)::text AS total, sum(icms_value)::text AS icms,
            coalesce(sum(total - discount) FILTER (WHERE monophasic), 0)::text AS mono, count(DISTINCT access_key)::int AS notes
       FROM nfe_item WHERE entity_id = $1 AND competence = $2 AND parser = $3 AND rules = $5 GROUP BY 1, 2, 3`,
    [entityId, from, NFE_ITEMS_PARSER, cnpj8, rules],
  );
  let nfe = Dec.ZERO, icms = Dec.ZERO, mono = Dec.ZERO, ret = Dec.ZERO, cnt = 0;
  for (const r of items.rows) {
    if (r.direction === "SAIDA" && r.mine && isSaleCfop(r.cfop)) {
      nfe = nfe.add(r.total); icms = icms.add(r.icms); mono = mono.add(r.mono); cnt += r.notes;
    } else if (r.direction === "ENTRADA" && r.cfop && RETURN_CFOP.test(r.cfop)) {
      ret = ret.add(r.total); icms = icms.sub(r.icms); mono = mono.sub(r.mono);
    }
  }
  return { month: from, nfse: Dec.of(n.total).toFixed(2), nfseCount: n.n, nfe: nfe.toFixed(2), nfeCount: cnt, returns: ret.toFixed(2),
    icms: (icms.cmp("0") < 0 ? Dec.ZERO : icms).toFixed(2), monophasic: (mono.cmp("0") < 0 ? Dec.ZERO : mono).toFixed(2), irrf: Dec.of(n.irrf).toFixed(2), csrf: Dec.of(n.csrf).toFixed(2) };
}

const FINANCIAL = /FINANCEIR|JUROS|RENDIMENT|APLICA|DESCONTOS? OBTIDO|VARIA[CÇ]/;

/** Razão do período: outras receitas (fora da receita bruta), resultado antes do IRPJ/CSLL, e se as competências estão fechadas. */
async function ledgerPeriod(tx: PoolClient, entityId: string, from: string, to: string) {
  const chart = await tx.query("SELECT 1 FROM chart_account WHERE entity_id = $1 AND source <> 'BANCO' LIMIT 1", [entityId]);
  if (!chart.rowCount) return null;
  const r = await tx.query<{ code: string; name: string; nature: string; net: string }>(
    `SELECT c.code, c.name, c.nature, sum(l.credit - l.debit)::text AS net
       FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN chart_account c ON c.id = l.account_id
      WHERE e.entity_id = $1 AND e.entry_date BETWEEN $2 AND $3 AND c.nature IN ('RECEITA', 'CUSTO', 'DESPESA')
        AND coalesce(e.rule_ref, '') NOT LIKE 'tributos-lucro%' AND coalesce(e.rule_ref, '') <> 'saldo-abertura'
      GROUP BY 1, 2, 3`,
    [entityId, from, to],
  );
  let result = Dec.ZERO, otherFin = Dec.ZERO, otherOp = Dec.ZERO;
  for (const x of r.rows) {
    result = result.add(x.net);
    // receita bruta (3.1) e deduções (3.2) vêm das notas; o resto das receitas é "outras"
    if (x.nature === "RECEITA" && !x.code.startsWith("3.1") && !x.code.startsWith("3.2") && Dec.of(x.net).gt("0")) {
      if (FINANCIAL.test(x.name.toUpperCase())) otherFin = otherFin.add(x.net); else otherOp = otherOp.add(x.net);
    }
  }
  const locks = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM (SELECT DISTINCT ON (competence) status FROM ledger_period_lock
       WHERE entity_id = $1 AND competence BETWEEN $2 AND $3 ORDER BY competence, created_at DESC) x WHERE status = 'BLOQUEADO'`,
    [entityId, from, to],
  );
  const months = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
  return { result: result.toFixed(2), otherFinancial: otherFin.toFixed(2), otherOperating: otherOp.toFixed(2), closed: locks.rows[0]!.n === months };
}

// ------------------------------------------------------------------ cálculo

export interface CalcRow {
  regime: Regime;
  periodKind: "MENSAL" | "TRIMESTRAL" | "ANUAL";
  periodStart: string;
  periodEnd: string;
  tax: Tax;
  status: "CALCULADO" | "BLOQUEADO" | "REGRA_PENDENTE";
  base: string | null;
  gross: string | null;
  deductions: string | null;
  amount: string | null;
  darfCode: string | null;
  dueOn: string | null;
  quotas: { n: number; due: string; amount: string }[];
  details: { lines: string[]; [k: string]: unknown };
  blockers: string[];
  ruleRefs: string[];
}

interface Ctx {
  tx: PoolClient;
  entityId: string;
  cnpj8: string;
  rules: CorporateRules;
  cal: Awaited<ReturnType<typeof loadCalendar>>;
  rev: Map<string, MonthRevenue>;
}

async function revenueOf(c: Ctx, month: string) {
  const k = month.slice(0, 7);
  if (!c.rev.has(k)) c.rev.set(k, await monthRevenue(c.tx, c.entityId, c.cnpj8, `${k}-01`));
  return c.rev.get(k)!;
}

async function presumptionAt(tx: PoolClient, entityId: string, scope: "NFSE" | "NFE", day: string): Promise<string | null> {
  const r = await tx.query<{ grp: string }>(
    "SELECT grp FROM entity_presumption WHERE entity_id = $1 AND scope = $2 AND valid_from <= $3 AND (valid_to IS NULL OR valid_to >= $3) ORDER BY valid_from DESC LIMIT 1",
    [entityId, scope, day],
  );
  return r.rows[0]?.grp ?? null;
}

async function optionFor(tx: PoolClient, entityId: string, year: number) {
  const r = await tx.query<{ quotas: "UNICA" | "TRES"; revenue_basis: string }>(
    "SELECT quotas, revenue_basis FROM corporate_tax_option WHERE entity_id = $1 AND year = $2 ORDER BY created_at DESC LIMIT 1",
    [entityId, year],
  );
  return r.rows[0] ?? null;
}

const lastBusinessDayOfNextMonth = (c: Ctx, periodEnd: string) => c.cal.adjust(monthEnd(addMonths(periodEnd, 1)), "PREVIOUS_BUSINESS_DAY").due;
const pisCofinsDue = (c: Ctx, month: string, day: number) => c.cal.adjust(`${addMonths(month, 1).slice(0, 8)}${String(day).padStart(2, "0")}`, "PREVIOUS_BUSINESS_DAY").due;
const darf = (c: Ctx, regime: Regime, tax: string) => c.rules.darf?.def[regime]?.[tax] ?? null;

function blocked(base: Omit<CalcRow, "status" | "base" | "gross" | "deductions" | "amount" | "quotas" | "details" | "blockers">, blockers: string[], status: CalcRow["status"] = "BLOQUEADO"): CalcRow {
  return { ...base, status, base: null, gross: null, deductions: null, amount: null, quotas: [], details: { lines: [] }, blockers };
}

/** Receita do mês por grupo de presunção (exige a atividade confirmada para cada fonte com receita). */
async function revenueByGroup(c: Ctx, months: string[]) {
  const out: Record<string, Dec> = {};
  const blockers: string[] = [];
  const lines: string[] = [];
  let ret = { irrf: Dec.ZERO, csrf: Dec.ZERO };
  for (const m of months) {
    const r = await revenueOf(c, m);
    const nfse = Dec.of(r.nfse);
    const nfe = Dec.of(r.nfe).sub(r.returns);
    if (!nfse.isZero()) {
      const g = await presumptionAt(c.tx, c.entityId, "NFSE", m);
      if (!g) blockers.push("Confirmar a atividade dos serviços (NFS-e) para a presunção");
      else out[g] = (out[g] ?? Dec.ZERO).add(nfse);
    }
    if (!nfe.isZero()) {
      const g = await presumptionAt(c.tx, c.entityId, "NFE", m);
      if (!g) blockers.push("Confirmar a atividade das vendas (NF-e) para a presunção");
      else out[g] = (out[g] ?? Dec.ZERO).add(nfe);
    }
    lines.push(`${mm(m)}: NFS-e ${brl(r.nfse)} (${r.nfseCount})${Dec.of(r.nfe).isZero() ? "" : ` · NF-e de venda ${brl(r.nfe)} (${r.nfeCount})`}${Dec.of(r.returns).isZero() ? "" : ` · devoluções −${brl(r.returns)}`}`);
    ret = { irrf: ret.irrf.add(r.irrf), csrf: ret.csrf.add(r.csrf) };
  }
  return { byGroup: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.toFixed(2)])), blockers: [...new Set(blockers)], lines, irrf: ret.irrf.toFixed(2), csrf: ret.csrf.toFixed(2) };
}

/** PIS e COFINS do mês (cumulativo no Presumido; não cumulativo no Real). `carry` = saldo credor do mês anterior. */
async function pisCofinsMonth(c: Ctx, regime: Regime, month: string, carry: { PIS: Dec; COFINS: Dec }): Promise<{ rows: CalcRow[]; carry: { PIS: Dec; COFINS: Dec } }> {
  const end = monthEnd(month);
  const cumulative = regime === "LUCRO_PRESUMIDO";
  const rule = cumulative ? c.rules.cumulative : c.rules.noncumulative;
  const mk = (tax: "PIS" | "COFINS") => ({ regime, periodKind: "MENSAL" as const, periodStart: month, periodEnd: end, tax, darfCode: darf(c, regime, tax), dueOn: null, ruleRefs: [] as string[] });
  if (!rule || !c.rules.payment || !c.rules.darf) {
    const miss = [!rule && (cumulative ? "PIS_COFINS_CUMULATIVO" : "PIS_COFINS_NAO_CUMULATIVO"), !c.rules.payment && "PAGAMENTO", !c.rules.darf && "DARF_CODIGOS"].filter(Boolean);
    return { rows: (["PIS", "COFINS"] as const).map((t) => blocked(mk(t), [`Regras a aprovar: ${miss.join(", ")}`], "REGRA_PENDENTE")), carry };
  }
  const r = await revenueOf(c, month);
  const gross = Dec.of(r.nfse).add(r.nfe).sub(r.returns);
  const excl = (rule.def.excludeIcms ? Dec.of(r.icms) : Dec.ZERO).add(rule.def.monophasicZero ? Dec.of(r.monophasic) : Dec.ZERO);
  const base = gross.sub(excl).cmp("0") > 0 ? gross.sub(excl) : Dec.ZERO;
  const split = splitCsrf(r.csrf);
  const led = cumulative ? null : await ledgerPeriod(c.tx, c.entityId, month, end);
  const rows: CalcRow[] = [];
  const nextCarry = { ...carry };
  for (const tax of ["PIS", "COFINS"] as const) {
    const rate = tax === "PIS" ? rule.def.pis : rule.def.cofins;
    const lines = [`Receita bruta ${brl(gross)}${excl.isZero() ? "" : ` − exclusões ${brl(excl)} (ICMS ${brl(r.icms)}${Dec.of(r.monophasic).isZero() ? "" : `, monofásico ${brl(r.monophasic)}`})`} = base ${brl(base)} × ${rate}%`];
    let debit = Dec.of(base.mul(Dec.of(rate).div("100")).toFixed(2));
    let credits = Dec.ZERO;
    const extra: Record<string, unknown> = {};
    if (!cumulative) {
      const nc = c.rules.noncumulative!.def;
      if (led) {
        const fin = Dec.of(led.otherFinancial), op = Dec.of(led.otherOperating);
        const fr = tax === "PIS" ? nc.financialPis : nc.financialCofins;
        const d1 = Dec.of(fin.mul(Dec.of(fr).div("100")).toFixed(2));
        const d2 = Dec.of(op.mul(Dec.of(rate).div("100")).toFixed(2));
        if (!fin.isZero()) lines.push(`Receitas financeiras ${brl(fin)} × ${fr}% = ${brl(d1)}`);
        if (!op.isZero()) lines.push(`Outras receitas ${brl(op)} × ${rate}% = ${brl(d2)}`);
        debit = debit.add(d1).add(d2);
      } else lines.push("Sem contabilidade na IARIS: receitas financeiras e outras receitas fora do cálculo");
      const cr = await c.tx.query<{ v: string }>(
        `SELECT coalesce(sum(c.value), 0)::text AS v FROM nfe_item_credit c JOIN nfe_item i ON i.id = c.item_id
          WHERE c.entity_id = $1 AND c.tax = $2 AND c.status = 'APROPRIAVEL' AND i.competence = $3 AND i.parser = $4 AND i.rules = $5`,
        [c.entityId, tax, month, NFE_ITEMS_PARSER, `${CFOP_RULES_VERSION}+${CREDIT_RULES_VERSION}`],
      );
      const nfeCredit = Dec.of(cr.rows[0]!.v);
      const ent = await c.tx.query<{ base: string }>(
        `SELECT coalesce(sum(CASE WHEN e.cancels_id IS NULL THEN e.base ELSE -e.base END), 0)::text AS base
           FROM pis_cofins_credit_entry e WHERE e.entity_id = $1 AND e.competence = $2`,
        [c.entityId, month],
      );
      const other = Dec.of(Dec.of(ent.rows[0]!.base).mul(Dec.of(rate).div("100")).toFixed(2));
      credits = nfeCredit.add(other);
      lines.push(`Créditos: NF-e de compra ${brl(nfeCredit)}${other.isZero() ? "" : ` + outras bases ${brl(ent.rows[0]!.base)} × ${rate}% = ${brl(other)}`}${carry[tax].isZero() ? "" : ` + saldo credor anterior ${brl(carry[tax])}`}`);
      extra.credits = credits.toFixed(2);
      extra.carryIn = carry[tax].toFixed(2);
    }
    const withheld = Dec.of(tax === "PIS" ? split.pis : split.cofins);
    const afterCredits = debit.sub(credits).sub(cumulative ? Dec.ZERO : carry[tax]);
    if (afterCredits.cmp("0") < 0) {
      nextCarry[tax] = afterCredits.mul("-1");
      lines.push(`Saldo credor para o mês seguinte: ${brl(nextCarry[tax])}`);
    } else nextCarry[tax] = Dec.ZERO;
    const due = afterCredits.cmp("0") > 0 ? afterCredits : Dec.ZERO;
    const ded = withheld.cmp(due) > 0 ? due : withheld;
    if (!withheld.isZero()) lines.push(`Retido pelos tomadores nas NFS-e: ${brl(withheld)}${withheld.cmp(due) > 0 ? ` (só ${brl(ded)} cabe no mês)` : ""}`);
    const amount = due.sub(ded);
    rows.push({
      ...mk(tax), status: "CALCULADO", base: base.toFixed(2), gross: debit.toFixed(2), deductions: credits.add(ded).add(cumulative ? Dec.ZERO : Dec.ZERO).toFixed(2),
      amount: amount.toFixed(2), dueOn: pisCofinsDue(c, month, c.rules.payment.def.pisCofinsDay), quotas: [],
      details: { lines, revenue: r, withheld: withheld.toFixed(2), ...extra }, blockers: [],
      ruleRefs: [rule.ref, c.rules.payment.ref, c.rules.darf.ref],
    });
  }
  return { rows, carry: cumulative ? carry : nextCarry };
}

/** IRPJ e CSLL do Presumido no trimestre. */
async function presumedQuarter(c: Ctx, year: number, q: number, quotasOpt: "UNICA" | "TRES", qRevenues: Record<number, string>): Promise<CalcRow[]> {
  const start = quarterStart(year, q);
  const end = monthEnd(addMonths(start, 2));
  const regime: Regime = "LUCRO_PRESUMIDO";
  const mk = (tax: "IRPJ" | "CSLL") => ({ regime, periodKind: "TRIMESTRAL" as const, periodStart: start, periodEnd: end, tax, darfCode: darf(c, regime, tax), dueOn: null, ruleRefs: [] as string[] });
  const R = c.rules;
  if (!R.presuncao || !R.rates || !R.payment || !R.darf) {
    const miss = [!R.presuncao && "PRESUNCAO", !R.rates && "IRPJ_CSLL", !R.payment && "PAGAMENTO", !R.darf && "DARF_CODIGOS"].filter(Boolean);
    return (["IRPJ", "CSLL"] as const).map((t) => blocked(mk(t), [`Regras a aprovar: ${miss.join(", ")}`], "REGRA_PENDENTE"));
  }
  const months = [0, 1, 2].map((i) => addMonths(start, i));
  const g = await revenueByGroup(c, months);
  if (g.blockers.length) return (["IRPJ", "CSLL"] as const).map((t) => blocked(mk(t), g.blockers));
  const led = await ledgerPeriod(c.tx, c.entityId, start, end);
  const other = led ? Dec.of(led.otherFinancial).add(led.otherOperating) : Dec.ZERO;
  const limits = R.lc224 ? lc224Limits(qRevenues, R.lc224.def.quarterLimit) : {};
  const split = splitCsrf(g.csrf);
  const out: CalcRow[] = [];
  for (const tax of ["IRPJ", "CSLL"] as const) {
    const from = R.lc224 ? (tax === "IRPJ" ? R.lc224.def.irpjFrom : R.lc224.def.csllFrom) : null;
    const lc = R.lc224 && from && start >= from ? { increase: R.lc224.def.increase, limit: limits[q]! } : null;
    const pb = presumedBase({ revenue: g.byGroup, groups: R.presuncao.def.groups, tax, lc224: lc });
    const base = Dec.of(pb.base).add(other);
    const lines = [...g.lines, ...pb.lines];
    if (lc) lines.push(`LC 224: limite do trimestre ${brl(lc.limit)}${Dec.of(pb.excess).isZero() ? " (receita dentro do limite)" : `, excedente ${brl(pb.excess)}`}`);
    if (!other.isZero()) lines.push(`Outras receitas (razão: financeiras e demais) ${brl(other)} entram inteiras`);
    else if (!led) lines.push("Sem contabilidade na IARIS: receitas financeiras e ganhos de capital não incluídos");
    lines.push(`Base de cálculo ${brl(base)}`);
    let gross: Dec;
    if (tax === "IRPJ") {
      const t = irpjDue(base.toFixed(2), 3, R.rates.def);
      gross = Dec.of(t.total);
      lines.push(`IRPJ ${R.rates.def.irpj}% ${brl(t.normal)}${Dec.of(t.additional).isZero() ? "" : ` + adicional ${R.rates.def.additional}% sobre o que passa de ${brl(t.threshold)} = ${brl(t.additional)}`}`);
    } else {
      gross = Dec.of(csllDue(base.toFixed(2), R.rates.def));
      lines.push(`CSLL ${R.rates.def.csll}% = ${brl(gross)}`);
    }
    const withheld = Dec.of(tax === "IRPJ" ? g.irrf : split.csll);
    const ded = withheld.cmp(gross) > 0 ? gross : withheld;
    if (!withheld.isZero()) lines.push(`${tax === "IRPJ" ? "IRRF" : "CSLL"} retido nas NFS-e: −${brl(ded)}${withheld.cmp(gross) > 0 ? ` (excedente ${brl(withheld.sub(gross))} vira saldo negativo a compensar)` : ""}`);
    const amount = gross.sub(ded);
    const due = lastBusinessDayOfNextMonth(c, end);
    const qs = quotasFor(amount.toFixed(2), quotasOpt, R.payment.def.minQuota, R.payment.def.singleBelow, R.payment.def.maxQuotas)
      .map((a, i) => ({ n: i + 1, amount: a, due: lastBusinessDayOfNextMonth(c, monthEnd(addMonths(end, i))) }));
    const alerts: string[] = [];
    if (lc && q === 4 && R.lc224) {
      const annual = [1, 2, 3, 4].reduce((s, k) => s.add(qRevenues[k] ?? "0"), Dec.ZERO);
      const hadExcess = [1, 2, 3].some((k) => Dec.of(qRevenues[k] ?? "0").cmp(limits[k] ?? "0") > 0);
      if (hadExcess) alerts.push(`Ajuste anual da LC 224 a conferir (IN RFB 2.306/2026, art. 15, § 5º): receita do ano ${brl(annual)} × limite ${brl(R.lc224.def.annualLimit)}`);
    }
    out.push({
      ...mk(tax), status: "CALCULADO", base: base.toFixed(2), gross: gross.toFixed(2), deductions: ded.toFixed(2), amount: amount.toFixed(2), dueOn: due, quotas: qs,
      details: { lines, alerts, presumed: pb, other: other.toFixed(2), withheld: withheld.toFixed(2), provisional: led ? !led.closed : null },
      blockers: [], ruleRefs: [R.presuncao.ref, R.rates.ref, R.payment.ref, R.darf.ref, ...(lc && R.lc224 ? [R.lc224.ref] : [])],
    });
  }
  return out;
}

async function lalurTotals(tx: PoolClient, entityId: string, from: string, to: string, tax: "IRPJ" | "CSLL") {
  const r = await tx.query<{ kind: string; v: string }>(
    `SELECT kind, coalesce(sum(CASE WHEN cancels_id IS NULL THEN amount ELSE -amount END), 0)::text AS v
       FROM lalur_entry WHERE entity_id = $1 AND period_start >= $2 AND period_end <= $3 AND tax IN ($4, 'AMBOS') GROUP BY kind`,
    [entityId, from, to, tax],
  );
  const get = (k: string) => r.rows.find((x) => x.kind === k)?.v ?? "0.00";
  return { additions: Dec.of(get("ADICAO")).toFixed(2), exclusions: Dec.of(get("EXCLUSAO")).toFixed(2) };
}

async function openingLoss(tx: PoolClient, entityId: string, kind: "PREJUIZO_FISCAL" | "BASE_NEGATIVA_CSLL", before: string) {
  const r = await tx.query<{ v: string }>(
    `SELECT coalesce(sum(CASE WHEN cancels_id IS NULL THEN amount ELSE -amount END), 0)::text AS v FROM lalur_opening
      WHERE entity_id = $1 AND kind = $2 AND as_of < $3`,
    [entityId, kind, before],
  );
  return Dec.of(r.rows[0]!.v);
}

/** IRPJ e CSLL do Lucro Real (trimestre, ou o ano inteiro no ajuste anual). `loss` = saldos da Parte B (mutável). */
async function realPeriod(c: Ctx, regime: Regime, start: string, end: string, kind: "TRIMESTRAL" | "ANUAL", quotasOpt: "UNICA" | "TRES",
  loss: { IRPJ: Dec; CSLL: Dec }, estimates?: { IRPJ: Dec; CSLL: Dec }): Promise<CalcRow[]> {
  const R = c.rules;
  const annualTax = (t: "IRPJ" | "CSLL") => (kind === "ANUAL" ? `${t}_AJUSTE` : t);
  const mk = (tax: "IRPJ" | "CSLL") => ({ regime, periodKind: kind, periodStart: start, periodEnd: end, tax, darfCode: darf(c, regime, annualTax(tax)), dueOn: null, ruleRefs: [] as string[] });
  if (!R.rates || !R.loss || !R.payment || !R.darf) {
    const miss = [!R.rates && "IRPJ_CSLL", !R.loss && "COMPENSACAO_PREJUIZO", !R.payment && "PAGAMENTO", !R.darf && "DARF_CODIGOS"].filter(Boolean);
    return (["IRPJ", "CSLL"] as const).map((t) => blocked(mk(t), [`Regras a aprovar: ${miss.join(", ")}`], "REGRA_PENDENTE"));
  }
  const led = await ledgerPeriod(c.tx, c.entityId, start, end);
  if (!led) return (["IRPJ", "CSLL"] as const).map((t) => blocked(mk(t), ["Lucro Real precisa da contabilidade na IARIS (plano de contas e lançamentos)"]));
  const months = (Number(end.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + Number(end.slice(5, 7)) - Number(start.slice(5, 7)) + 1;
  let irrf = Dec.ZERO, csrf = Dec.ZERO;
  for (let i = 0; i < months; i++) { const r = await revenueOf(c, addMonths(start, i)); irrf = irrf.add(r.irrf); csrf = csrf.add(r.csrf); }
  const split = splitCsrf(csrf.toFixed(2));
  const out: CalcRow[] = [];
  for (const tax of ["IRPJ", "CSLL"] as const) {
    const adj = await lalurTotals(c.tx, c.entityId, start, end, tax);
    const rp = realProfit({ result: led.result, additions: adj.additions, exclusions: adj.exclusions, lossBalance: loss[tax].toFixed(2), limitPct: R.loss.def.limit });
    const label = tax === "IRPJ" ? "prejuízo fiscal" : "base negativa";
    const lines = [
      `Resultado contábil antes do IRPJ/CSLL ${brl(led.result)}${led.closed ? "" : " (competências ainda não fechadas: valor provisório)"}`,
      `+ adições ${brl(adj.additions)} − exclusões ${brl(adj.exclusions)} = ${brl(rp.adjusted)}`,
    ];
    if (Dec.of(rp.compensated).gt("0")) lines.push(`− compensação de ${label} ${brl(rp.compensated)} (saldo ${brl(loss[tax])}, trava ${R.loss.def.limit}%)`);
    if (Dec.of(rp.newLoss).gt("0")) lines.push(`${label[0]!.toUpperCase()}${label.slice(1)} do período ${brl(rp.newLoss)} (vai para a Parte B)`);
    lines.push(`${tax === "IRPJ" ? "Lucro real" : "Base da CSLL"} ${brl(rp.taxable)}`);
    loss[tax] = Dec.of(rp.lossAfter);
    let gross: Dec;
    if (tax === "IRPJ") {
      const t = irpjDue(rp.taxable, months, R.rates.def);
      gross = Dec.of(t.total);
      lines.push(`IRPJ ${R.rates.def.irpj}% ${brl(t.normal)}${Dec.of(t.additional).isZero() ? "" : ` + adicional ${brl(t.additional)} (acima de ${brl(t.threshold)})`}`);
    } else {
      gross = Dec.of(csllDue(rp.taxable, R.rates.def));
      lines.push(`CSLL ${R.rates.def.csll}% = ${brl(gross)}`);
    }
    const withheld = Dec.of(tax === "IRPJ" ? irrf.toFixed(2) : split.csll);
    const est = estimates ? estimates[tax] : Dec.ZERO;
    if (!withheld.isZero()) lines.push(`− ${tax === "IRPJ" ? "IRRF" : "CSLL"} retido nas NFS-e ${brl(withheld)}`);
    if (estimates) lines.push(`− estimativas mensais devidas no ano ${brl(est)}`);
    const net = gross.sub(withheld).sub(est);
    const amount = net.cmp("0") > 0 ? net : Dec.ZERO;
    if (net.cmp("0") < 0) lines.push(`Saldo negativo de ${tax} ${brl(net.mul("-1"))}: restituir ou compensar (PER/DCOMP)`);
    const due = kind === "ANUAL" ? c.cal.adjust(`${Number(end.slice(0, 4)) + 1}-03-31`, "PREVIOUS_BUSINESS_DAY").due : lastBusinessDayOfNextMonth(c, end);
    const qs = kind === "ANUAL" ? (amount.gt("0") ? [{ n: 1, amount: amount.toFixed(2), due }] : [])
      : quotasFor(amount.toFixed(2), quotasOpt, R.payment.def.minQuota, R.payment.def.singleBelow, R.payment.def.maxQuotas)
        .map((a, i) => ({ n: i + 1, amount: a, due: lastBusinessDayOfNextMonth(c, monthEnd(addMonths(end, i))) }));
    out.push({
      ...mk(tax), status: "CALCULADO", base: rp.taxable, gross: gross.toFixed(2), deductions: withheld.add(est).toFixed(2), amount: amount.toFixed(2), dueOn: due, quotas: qs,
      details: { lines, ledger: led, lalur: adj, profit: rp, withheld: withheld.toFixed(2), provisional: !led.closed, negativeBalance: net.cmp("0") < 0 ? net.mul("-1").toFixed(2) : null },
      blockers: [], ruleRefs: [R.rates.ref, R.loss.ref, R.payment.ref, R.darf.ref],
    });
  }
  return out;
}

/** Estimativa mensal do Lucro Real anual pela receita bruta. */
async function estimateMonth(c: Ctx, month: string): Promise<CalcRow[]> {
  const R = c.rules;
  const regime: Regime = "LUCRO_REAL_ANUAL";
  const end = monthEnd(month);
  const mk = (tax: "IRPJ" | "CSLL") => ({ regime, periodKind: "MENSAL" as const, periodStart: month, periodEnd: end, tax, darfCode: darf(c, regime, tax), dueOn: null, ruleRefs: [] as string[] });
  if (!R.presuncao || !R.rates || !R.payment || !R.darf) {
    const miss = [!R.presuncao && "PRESUNCAO", !R.rates && "IRPJ_CSLL", !R.payment && "PAGAMENTO", !R.darf && "DARF_CODIGOS"].filter(Boolean);
    return (["IRPJ", "CSLL"] as const).map((t) => blocked(mk(t), [`Regras a aprovar: ${miss.join(", ")}`], "REGRA_PENDENTE"));
  }
  const g = await revenueByGroup(c, [month]);
  if (g.blockers.length) return (["IRPJ", "CSLL"] as const).map((t) => blocked(mk(t), g.blockers));
  const led = await ledgerPeriod(c.tx, c.entityId, month, end);
  const other = led ? Dec.of(led.otherFinancial).add(led.otherOperating) : Dec.ZERO;
  const split = splitCsrf(g.csrf);
  const out: CalcRow[] = [];
  for (const tax of ["IRPJ", "CSLL"] as const) {
    const pb = presumedBase({ revenue: g.byGroup, groups: R.presuncao.def.groups, tax, lc224: null });
    const base = Dec.of(pb.base).add(other);
    const lines = [...g.lines, ...pb.lines, ...(other.isZero() ? [] : [`Outras receitas ${brl(other)}`]), `Base da estimativa ${brl(base)}`];
    const gross = tax === "IRPJ" ? Dec.of(irpjDue(base.toFixed(2), 1, R.rates.def).total) : Dec.of(csllDue(base.toFixed(2), R.rates.def));
    lines.push(`${tax} devido na estimativa ${brl(gross)}`);
    const withheld = Dec.of(tax === "IRPJ" ? g.irrf : split.csll);
    const ded = withheld.cmp(gross) > 0 ? gross : withheld;
    if (!withheld.isZero()) lines.push(`− retido nas NFS-e ${brl(ded)}`);
    const amount = gross.sub(ded);
    const due = lastBusinessDayOfNextMonth(c, end);
    out.push({
      ...mk(tax), status: "CALCULADO", base: base.toFixed(2), gross: gross.toFixed(2), deductions: ded.toFixed(2), amount: amount.toFixed(2), dueOn: due,
      quotas: amount.gt("0") ? [{ n: 1, amount: amount.toFixed(2), due }] : [],
      details: { lines, presumed: pb, withheld: withheld.toFixed(2), alerts: ["Estimativa pela receita bruta; suspensão/redução por balancete ainda não calculada"] },
      blockers: [], ruleRefs: [R.presuncao.ref, R.rates.ref, R.payment.ref, R.darf.ref],
    });
  }
  return out;
}

/** Períodos de regime do lucro da empresa: [{regime, from, to}] recortados no intervalo. */
async function regimeSpans(tx: PoolClient, entityId: string) {
  const r = await tx.query<{ regime: Regime; valid_from: string; valid_to: string | null }>(
    `SELECT regime, valid_from::text, valid_to::text FROM tax_regime_history
      WHERE entity_id = $1 AND regime IN ('LUCRO_PRESUMIDO', 'LUCRO_REAL_TRIMESTRAL', 'LUCRO_REAL_ANUAL') ORDER BY valid_from`,
    [entityId],
  );
  return r.rows;
}

/** Calcula todos os períodos encerrados (até o mês anterior a hoje, no máximo 24 meses). Não grava. */
export async function computeCorporate(tx: PoolClient, entityId: string, today: string): Promise<CalcRow[]> {
  const spans = await regimeSpans(tx, entityId);
  if (!spans.length) return [];
  const ent = (await tx.query<{ cnpj: string; start: string | null }>(
    "SELECT cnpj, (SELECT min(valid_from)::text FROM contracted_service_history WHERE entity_id = $1) AS start FROM entity WHERE id = $1", [entityId],
  )).rows[0];
  if (!ent?.cnpj) return [];
  const lastMonth = addMonths(`${today.slice(0, 7)}-01`, -1);
  const floor = addMonths(lastMonth, -(MAX_MONTHS - 1));
  const cal = await loadCalendar(tx);
  const rules = await loadCorporateRules(tx, lastMonth);
  const c: Ctx = { tx, entityId, cnpj8: ent.cnpj.slice(0, 8), rules, cal, rev: new Map() };
  const out: CalcRow[] = [];
  for (const s of spans) {
    let from = `${s.valid_from.slice(0, 7)}-01`;
    if (ent.start && from < `${ent.start.slice(0, 7)}-01`) from = `${ent.start.slice(0, 7)}-01`;
    if (from < floor) from = floor;
    const until = s.valid_to && s.valid_to < monthEnd(lastMonth) ? `${s.valid_to.slice(0, 7)}-01` : lastMonth;
    if (from > until) continue;
    // PIS/COFINS mês a mês (saldo credor encadeado)
    let carry = { PIS: Dec.ZERO, COFINS: Dec.ZERO };
    for (let m = from; m <= until; m = addMonths(m, 1)) {
      const r = await pisCofinsMonth(c, s.regime, m, carry);
      carry = r.carry;
      out.push(...r.rows);
    }
    // IRPJ/CSLL
    const firstYear = Number(from.slice(0, 4));
    const loss = { IRPJ: await openingLoss(tx, entityId, "PREJUIZO_FISCAL", from), CSLL: await openingLoss(tx, entityId, "BASE_NEGATIVA_CSLL", from) };
    for (let y = firstYear; y <= Number(until.slice(0, 4)); y++) {
      const opt = await optionFor(tx, entityId, y);
      const quotas = opt?.quotas ?? "UNICA";
      if (opt?.revenue_basis === "CAIXA") {
        for (const t of ["IRPJ", "CSLL"] as const) out.push(blocked({ regime: s.regime, periodKind: "TRIMESTRAL", periodStart: `${y}-01-01`, periodEnd: `${y}-12-31`, tax: t, darfCode: null, dueOn: null, ruleRefs: [] },
          [`Regime de caixa em ${y}: apuração pelos recebimentos ainda não suportada`]));
        continue;
      }
      if (s.regime === "LUCRO_REAL_ANUAL") {
        const est = { IRPJ: Dec.ZERO, CSLL: Dec.ZERO };
        for (let m = 1; m <= 12; m++) {
          const comp = `${y}-${String(m).padStart(2, "0")}-01`;
          if (comp < from || comp > until) continue;
          const rows = await estimateMonth(c, comp);
          for (const r of rows) if (r.gross) est[r.tax as "IRPJ" | "CSLL"] = est[r.tax as "IRPJ" | "CSLL"].add(r.gross);
          out.push(...rows);
        }
        if (until >= `${y}-12-01` && from <= `${y}-01-01`) out.push(...(await realPeriod(c, s.regime, `${y}-01-01`, `${y}-12-31`, "ANUAL", quotas, loss, est)));
        continue;
      }
      // receita bruta de cada trimestre do ano (limite da LC 224 com sobra)
      const qRevenues: Record<number, string> = {};
      for (let q = 1; q <= 4; q++) {
        const qs = quarterStart(y, q);
        if (addMonths(qs, 2) > until) break;
        let t = Dec.ZERO;
        for (let i = 0; i < 3; i++) { const r = await revenueOf(c, addMonths(qs, i)); t = t.add(r.nfse).add(r.nfe).sub(r.returns); }
        qRevenues[q] = t.toFixed(2);
      }
      for (let q = 1; q <= 4; q++) {
        const qs = quarterStart(y, q);
        if (qs < from || addMonths(qs, 2) > until) continue;
        if (s.regime === "LUCRO_PRESUMIDO") out.push(...(await presumedQuarter(c, y, q, quotas, qRevenues)));
        else out.push(...(await realPeriod(c, s.regime, qs, monthEnd(addMonths(qs, 2)), "TRIMESTRAL", quotas, loss)));
      }
    }
  }
  void quarterOf;
  return out;
}

const fingerprintOf = (r: CalcRow) =>
  createHash("sha256").update(JSON.stringify([CORPORATE_ENGINE, r.status, r.base, r.gross, r.deductions, r.amount, r.darfCode, r.dueOn, r.quotas, r.details.lines, r.blockers, r.ruleRefs])).digest("hex");

/**
 * Presunção sem pessoa: com receita e sem atividade confirmada, o agente usa o
 * grupo da CNAE principal (Presumido e estimativa do Real anual). Fica marcada
 * como do agente; o DARF pago na Receita confere o cálculo (pago × calculado).
 * Pessoa pode trocar a qualquer momento (nova vigência).
 */
async function autoPresumption(tx: PoolClient, entityId: string, actor: Actor) {
  const spans = (await regimeSpans(tx, entityId)).filter((s) => s.regime === "LUCRO_PRESUMIDO" || s.regime === "LUCRO_REAL_ANUAL");
  if (!spans.length) return 0;
  const from = spans[0]!.valid_from;
  const prop = await presumptionProposal(tx, entityId);
  if (!prop.cnae) return 0;
  let added = 0;
  for (const scope of ["NFSE", "NFE"] as const) {
    const has = await tx.query("SELECT 1 FROM entity_presumption WHERE entity_id = $1 AND scope = $2 LIMIT 1", [entityId, scope]);
    if (has.rowCount) continue;
    const rev = scope === "NFSE"
      ? await tx.query("SELECT 1 FROM nfse_document WHERE entity_id = $1 AND role = 'PRESTADA' AND issued_at >= $2 LIMIT 1", [entityId, from])
      : await tx.query("SELECT 1 FROM nfe_item WHERE entity_id = $1 AND direction = 'SAIDA' AND competence >= $2 LIMIT 1", [entityId, from]);
    if (!rev.rowCount) continue;
    const id = newId();
    const reason = `Sugerida pela CNAE principal ${prop.cnae ?? "—"} (agente); conferida pelo DARF pago quando houver`;
    await tx.query(
      `INSERT INTO entity_presumption (id, tenant_id, entity_id, scope, grp, valid_from, reason, set_by)
       VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7)`,
      [id, entityId, scope, prop[scope], from, reason, `agente:${actor.id}`],
    );
    await audit(tx, { actor, action: "tax.presumption_proposed", resourceType: "entity_presumption", resourceId: id, entityId, data: { scope, group: prop[scope], cnae: prop.cnae, valid_from: from } });
    added++;
  }
  return added;
}

/** Calcula e grava o que mudou (evento CORPORATE_TAX_CALCULATED + auditoria). */
export async function refreshCorporate(pool: Pool, tenantId: string, entityId: string, today: string, actor: Actor = TAX_AGENT) {
  return withTenant(pool, tenantId, async (tx) => {
    await autoPresumption(tx, entityId, actor);
    const rows = await computeCorporate(tx, entityId, today);
    let changed = 0;
    const touched: string[] = [];
    for (const r of rows) {
      const fp = fingerprintOf(r);
      const last = await tx.query<{ fingerprint: string }>(
        "SELECT fingerprint FROM corporate_tax_calc WHERE entity_id = $1 AND period_start = $2 AND period_kind = $3 AND tax = $4 ORDER BY created_at DESC LIMIT 1",
        [entityId, r.periodStart, r.periodKind, r.tax],
      );
      if (last.rows[0]?.fingerprint === fp) continue;
      await tx.query(
        `INSERT INTO corporate_tax_calc (id, tenant_id, entity_id, regime, period_kind, period_start, period_end, tax, status, base, gross, deductions, amount,
                                         darf_code, due_on, quotas, details, blockers, rule_refs, engine_version, fingerprint)
         VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [newId(), entityId, r.regime, r.periodKind, r.periodStart, r.periodEnd, r.tax, r.status, r.base, r.gross, r.deductions, r.amount,
          r.darfCode, r.dueOn, JSON.stringify(r.quotas), JSON.stringify(r.details), JSON.stringify(r.blockers), r.ruleRefs, CORPORATE_ENGINE, fp],
      );
      changed++;
      touched.push(`${r.tax}:${r.periodStart.slice(0, 7)}`);
    }
    if (changed) {
      const batch = newId();
      await appendEvent(tx, {
        type: "CORPORATE_TAX_CALCULATED", schemaVersion: 1, producer: { kind: "engine", name: "tax", version: CORPORATE_ENGINE },
        idempotencyKey: `lucro:${entityId}:${batch}`, entityId,
        payload: { entity_id: entityId, changed, periods: touched.slice(0, 50), engine: CORPORATE_ENGINE },
      });
      await audit(tx, { actor, action: "tax.corporate_calculated", resourceType: "corporate_tax_calc", resourceId: batch, entityId, data: { changed, periods: touched } });
    }
    return { periods: rows.length, changed };
  });
}

/** Situação do pagamento pelo PagtoWeb: código do DARF e período de apuração (mês final do período). */
async function paymentFor(tx: PoolClient, entityId: string, code: string | null, periodEnd: string) {
  if (!code) return null;
  const r = await tx.query<{ total: string; principal: string; on: string | null; docs: string[] }>(
    `SELECT coalesce(sum(coalesce((b->>'principal')::numeric, (b->>'total')::numeric, 0)), 0)::text AS principal,
            coalesce(sum(coalesce((b->>'total')::numeric, 0)), 0)::text AS total, max(p.collected_on)::text AS on, array_agg(DISTINCT p.document_number) AS docs
       FROM federal_payment p, jsonb_array_elements(CASE WHEN jsonb_array_length(p.breakdown) > 0 THEN p.breakdown
                                                          ELSE jsonb_build_array(jsonb_build_object('revenueCode', p.revenue_code, 'principal', p.amount_principal, 'total', p.amount_total)) END) b
      WHERE p.entity_id = $1 AND b->>'revenueCode' = $2 AND p.competence = $3`,
    [entityId, code, `${periodEnd.slice(0, 7)}-01`],
  );
  const x = r.rows[0]!;
  return Dec.of(x.principal).gt("0") ? { principal: Dec.of(x.principal).toFixed(2), total: Dec.of(x.total).toFixed(2), collectedOn: x.on, documents: x.docs } : null;
}

/** Última fotografia de cada período/tributo, com a situação do pagamento (para a tela). */
export async function corporateOverview(tx: PoolClient, entityId: string, today: string) {
  const calcs = await tx.query<{
    regime: Regime; period_kind: string; period_start: string; period_end: string; tax: Tax; status: string; base: string | null; gross: string | null;
    deductions: string | null; amount: string | null; darf_code: string | null; due_on: string | null; quotas: { n: number; due: string; amount: string }[];
    details: { lines: string[]; alerts?: string[]; provisional?: boolean | null }; blockers: string[]; rule_refs: string[]; created_at: Date;
  }>(
    `SELECT DISTINCT ON (period_start, period_kind, tax) regime, period_kind, to_char(period_start, 'YYYY-MM-DD') AS period_start, to_char(period_end, 'YYYY-MM-DD') AS period_end,
            tax, status, base::text, gross::text, deductions::text, amount::text, darf_code, to_char(due_on, 'YYYY-MM-DD') AS due_on, quotas, details, blockers, rule_refs, created_at
       FROM corporate_tax_calc WHERE entity_id = $1 ORDER BY period_start, period_kind, tax, created_at DESC`,
    [entityId],
  );
  const rows = [];
  for (const c of calcs.rows.sort((a, b) => b.period_start.localeCompare(a.period_start) || a.period_kind.localeCompare(b.period_kind) || a.tax.localeCompare(b.tax))) {
    const pay = c.status === "CALCULADO" ? await paymentFor(tx, entityId, c.darf_code, c.period_end) : null;
    const amt = Dec.of(c.amount ?? "0");
    const firstDue = c.quotas[0]?.due ?? c.due_on;
    const payment = c.status !== "CALCULADO" ? null
      : !amt.gt("0") ? "SEM_SALDO"
      : pay ? (Dec.of(pay.principal).cmp(amt) >= 0 ? "PAGO" : "PAGO_PARCIAL")
      : firstDue && firstDue < today ? "PAGAMENTO_NAO_IDENTIFICADO" : "A_VENCER";
    rows.push({ ...c, payment, paid: pay });
  }
  const regimes = await regimeSpans(tx, entityId);
  const pres = await tx.query(
    "SELECT scope, grp, valid_from::text, valid_to::text, reason, set_by FROM entity_presumption WHERE entity_id = $1 ORDER BY scope, valid_from DESC", [entityId]);
  const opts = await tx.query(
    "SELECT DISTINCT ON (year) year, quotas, revenue_basis, set_by, created_at FROM corporate_tax_option WHERE entity_id = $1 ORDER BY year DESC, created_at DESC", [entityId]);
  const lalur = await tx.query(
    `SELECT e.id, to_char(e.period_start, 'YYYY-MM-DD') AS period_start, to_char(e.period_end, 'YYYY-MM-DD') AS period_end, e.tax, e.kind, e.description, e.amount::text,
            e.legal_basis, e.part_b, e.account_code, e.created_by, e.created_at,
            EXISTS (SELECT 1 FROM lalur_entry x WHERE x.cancels_id = e.id) AS cancelled
       FROM lalur_entry e WHERE e.entity_id = $1 AND e.cancels_id IS NULL ORDER BY e.period_start DESC, e.created_at`, [entityId]);
  const openings = await tx.query(
    `SELECT o.id, o.kind, o.amount::text, o.as_of::text, o.evidence, o.created_by, EXISTS (SELECT 1 FROM lalur_opening x WHERE x.cancels_id = o.id) AS cancelled
       FROM lalur_opening o WHERE o.entity_id = $1 AND o.cancels_id IS NULL ORDER BY o.as_of DESC`, [entityId]);
  const credits = await tx.query(
    `SELECT e.id, to_char(e.competence, 'YYYY-MM') AS competence, e.kind, e.base::text, e.description, e.legal_basis, e.created_by,
            EXISTS (SELECT 1 FROM pis_cofins_credit_entry x WHERE x.cancels_id = e.id) AS cancelled
       FROM pis_cofins_credit_entry e WHERE e.entity_id = $1 AND e.cancels_id IS NULL ORDER BY e.competence DESC`, [entityId]);
  const rules = await loadCorporateRules(tx, today);
  return {
    regimes, rows, presumption: pres.rows, proposal: await presumptionProposal(tx, entityId), options: opts.rows,
    lalur: lalur.rows, openings: openings.rows, credits: credits.rows, rulesPending: rules.pending,
    groups: rules.presuncao?.def.groups ?? (await proposedGroups(tx)),
  };
}

/** Proposta de grupo de presunção pela CNAE principal (a pessoa confirma). */
export async function presumptionProposal(tx: PoolClient, entityId: string) {
  const r = await tx.query<{ cnae: string }>(
    `SELECT a.cnae FROM activity_history a JOIN establishment s ON s.id = a.establishment_id
      WHERE s.entity_id = $1 AND a.valid_to IS NULL ORDER BY a.is_primary DESC NULLS LAST LIMIT 1`,
    [entityId],
  );
  const cnae = r.rows[0]?.cnae ?? null;
  return { cnae, NFSE: cnae ? groupForCnae(cnae, "NFSE") : "SERVICOS_GERAIS", NFE: cnae ? groupForCnae(cnae, "NFE") : "COMERCIO_INDUSTRIA" };
}

/** Grupo sugerido pela CNAE. Sugestão: só vale depois de confirmada por pessoa. */
export function groupForCnae(cnae: string, scope: "NFSE" | "NFE"): string {
  const c = cnae.replace(/\D/g, "");
  if (scope === "NFE") return /^4731|^4681/.test(c) ? "COMBUSTIVEIS" : /^41/.test(c) ? "ATIVIDADE_IMOBILIARIA" : "COMERCIO_INDUSTRIA";
  if (/^493[0-9]/.test(c) && /^4930/.test(c)) return "TRANSPORTE_CARGA";
  if (/^492/.test(c)) return "TRANSPORTE_PASSAGEIROS";
  if (/^861/.test(c)) return "HOSPITALAR";
  if (/^4[12]/.test(c) || /^43/.test(c)) return "CONSTRUCAO_SEM_MATERIAIS";
  return "SERVICOS_GERAIS";
}

export { mm as corporateMonthLabel };

/** Situação dos tributos do lucro que vencem por causa de uma competência (para a revisão independente). */
export async function corporateForMonth(tx: PoolClient, entityId: string, month: string, today: string) {
  const ov = await corporateOverview(tx, entityId, today);
  const end = monthEnd(`${month}-01`);
  return ov.rows.filter((r) => r.period_end === end);
}
