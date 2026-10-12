import type { Pool } from "pg";
import { audit } from "../../platform/audit/audit.js";
import { DailyLimitExceededError } from "../../platform/metering/metering.js";
import type { Actor } from "../../shared/actor.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";
import { FEDERAL_AGENT, syncPaymentsWindow, type FederalSyncDeps } from "./federal-sync.js";

/**
 * Atualização automática dos pagamentos na Receita (PagtoWeb, consulta cobrada),
 * autorizada pelo responsável técnico (12/10/2026): uma vez por empresa, a partir
 * de 5 dias depois do vencimento de guia ainda sem pagamento identificado (DARF
 * das retenções, ISS fica no extrato, DAS do Simples), dentro do teto diário.
 * Não consulta de novo se já houve consulta depois de vencimento + 5 dias.
 */

export const AUTO_PAYMENTS_POLICY = "pagamentos-automatico@1";
export const AFTER_DUE_DAYS = 5;
/** Guias vencidas há mais que isto não disparam consulta automática (fica para pessoa). */
export const MAX_AGE_DAYS = 60;

const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export async function autoPaymentsApproved(pool: Pool, tenantId: string): Promise<boolean> {
  return withTenant(pool, tenantId, async (tx) => Boolean((await tx.query("SELECT 1 FROM accounting_rule_approval WHERE rule_set = $1", [AUTO_PAYMENTS_POLICY])).rowCount));
}

export async function approveAutoPayments(pool: Pool, tenantId: string, actor: Actor, instruction: string) {
  if (actor.kind !== "USER") throw new Error("Autorizar consulta cobrada automática é decisão de pessoa");
  await withTenant(pool, tenantId, async (tx) => {
    const ins = await tx.query("INSERT INTO accounting_rule_approval (id, tenant_id, rule_set, approved_by) VALUES ($1, current_tenant(), $2, $3) ON CONFLICT DO NOTHING", [newId(), AUTO_PAYMENTS_POLICY, actor.id]);
    if (ins.rowCount) await audit(tx, { actor, action: "integra.auto_payments_authorized", resourceType: "accounting_rule_approval", resourceId: AUTO_PAYMENTS_POLICY, ruleRef: AUTO_PAYMENTS_POLICY, approvedBy: actor.id, data: { instruction, afterDueDays: AFTER_DUE_DAYS, maxAgeDays: MAX_AGE_DAYS } });
  });
}

/** Empresas que precisam de consulta hoje, com o intervalo a consultar. */
export async function paymentsToRefresh(pool: Pool, tenantId: string, today: string): Promise<{ entityId: string; from: string; to: string; reason: string }[]> {
  return withTenant(pool, tenantId, async (tx) => {
    const { rows } = await tx.query<{ entity_id: string; competence: string; due_on: string; what: string; checked: string | null }>(
      `WITH pend AS (
         SELECT entity_id, competence, due_on, tax AS what FROM (
           SELECT DISTINCT ON (entity_id, competence, tax) * FROM withholding_observation ORDER BY entity_id, competence, tax, created_at DESC) w
          WHERE status IN ('PAGAMENTO_NAO_IDENTIFICADO', 'GUIA_NAO_ENVIADA', 'A_VENCER') AND tax IN ('IRRF', 'CSRF')
            AND coalesce(details->>'responsibility', 'LEGACY') = 'LEGACY'
         UNION ALL
         SELECT entity_id, competence, due_on, 'DAS' FROM (
           SELECT DISTINCT ON (entity_id, competence) * FROM tax_guide_observation WHERE guide = 'DAS_SIMPLES' ORDER BY entity_id, competence, created_at DESC) g
          WHERE status IN ('PAGAMENTO_NAO_IDENTIFICADO', 'A_VENCER') AND coalesce(details->>'responsibility', 'LEGACY') = 'LEGACY'
       )
       SELECT p.entity_id, p.competence::text, p.due_on::text, p.what,
              (SELECT max(s.fetched_at)::date::text FROM external_snapshot s WHERE s.entity_id = p.entity_id AND s.request_key LIKE 'pagtoweb:pagamentos:%') AS checked
         FROM pend p
        WHERE p.due_on IS NOT NULL AND p.due_on <= ($1::date - $2::int) AND p.due_on >= ($1::date - $3::int)
          AND EXISTS (SELECT 1 FROM power_of_attorney a WHERE a.entity_id = p.entity_id AND a.system = 'ECAC' AND $1::date <@ daterange(a.valid_from, a.valid_to, '[]'))`,
      [today, AFTER_DUE_DAYS, MAX_AGE_DAYS],
    );
    const by = new Map<string, { entityId: string; from: string; to: string; reason: string }>();
    for (const r of rows) {
      // já consultado depois do vencimento + 5 dias: não repete
      if (r.checked && r.checked >= addDays(r.due_on, AFTER_DUE_DAYS)) continue;
      const cur = by.get(r.entity_id);
      const from = r.competence;
      if (!cur) by.set(r.entity_id, { entityId: r.entity_id, from, to: today, reason: `${r.what} ${r.competence.slice(5, 7)}/${r.competence.slice(0, 4)} venceu em ${r.due_on.split("-").reverse().join("/")}` });
      else if (from < cur.from) cur.from = from;
    }
    return [...by.values()];
  });
}

/** Roda a atualização (se autorizada). Para no teto diário sem erro. */
export async function runAutoPayments(deps: FederalSyncDeps, tenantId: string, today: string, actor: Actor = FEDERAL_AGENT) {
  if (!(await autoPaymentsApproved(deps.appPool, tenantId))) return { skipped: "não autorizada", entities: 0, calls: 0 };
  const list = await paymentsToRefresh(deps.appPool, tenantId, today);
  let calls = 0;
  let entities = 0;
  for (const x of list) {
    try {
      const r = await syncPaymentsWindow(deps, tenantId, { entityId: x.entityId, from: x.from, to: x.to }, actor);
      calls += r.calls;
      entities++;
    } catch (err) {
      if (err instanceof DailyLimitExceededError) return { skipped: "teto diário de consultas", entities, calls };
      console.error(`[receita] pagamentos ${x.entityId.slice(0, 8)}: ${(err as Error).message}`);
    }
  }
  return { skipped: null, entities, calls };
}
