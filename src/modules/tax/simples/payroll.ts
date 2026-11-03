import type { Pool } from "pg";
import { audit } from "../../../platform/audit/audit.js";
import { appendEvent } from "../../../platform/events/outbox.js";
import type { Actor } from "../../../shared/actor.js";
import { Dec } from "../../../shared/decimal.js";
import { withTenant } from "../../../shared/db/tenant-tx.js";
import { newId } from "../../../shared/ids.js";

/**
 * Folha de salários informada por pessoa (base do fator r do Simples).
 *
 * Serve para os meses que nenhuma declaração do PGDAS-D trouxe ainda (o mês que
 * acabou de fechar, por exemplo). Valor com encargos: salários, pró-labore,
 * 13º no mês da contribuição, CPP e FGTS (Res. CGSN 140/2018, art. 26).
 * Insert-only: corrigir é informar de novo; vale a linha mais recente do mês.
 * O recálculo do Simples é reação ao evento PAYROLL_INFORMED (Orquestrador).
 */

export class PayrollInputError extends Error {}

/** "12.345,67" ou "12345,67" (padrão brasileiro) e "12345.67" → "12345.67"; senão null. */
export function moneyInput(v: string): string | null {
  const t = v.trim();
  if (/^\d{1,3}(\.\d{3})*(,\d{1,2})?$/.test(t) || /^\d+(,\d{1,2})?$/.test(t)) return t.replace(/\./g, "").replace(",", ".");
  if (/^\d+(\.\d{1,2})?$/.test(t)) return t;
  return null;
}

export async function informPayroll(
  pool: Pool,
  tenantId: string,
  input: { entityId: string; competence: string; total: string; reason: string },
  actor: Actor,
): Promise<{ id: string; changed: boolean }> {
  if (actor.kind !== "USER") throw new PayrollInputError("Só uma pessoa informa a folha de salários");
  if (!/^\d{4}-\d{2}-01$/.test(input.competence)) throw new PayrollInputError("Competência deve ser AAAA-MM-01");
  const raw = moneyInput(input.total);
  if (raw === null) throw new PayrollInputError("Valor da folha inválido (use 12.345,67)");
  const total = Dec.of(raw).toFixed(2);
  const reason = input.reason.trim();
  if (!reason) throw new PayrollInputError("Informe a origem do valor (ex.: resumo da folha, GFIP/eSocial)");
  return withTenant(pool, tenantId, async (tx) => {
    const ent = await tx.query("SELECT 1 FROM entity WHERE id = $1", [input.entityId]);
    if (!ent.rowCount) throw new PayrollInputError("Empresa não encontrada");
    const last = await tx.query<{ total: string }>(
      "SELECT total::text FROM payroll_informed WHERE entity_id = $1 AND competence = $2 ORDER BY created_at DESC, id DESC LIMIT 1",
      [input.entityId, input.competence],
    );
    if (last.rows[0] && Dec.of(last.rows[0].total).toFixed(2) === total) return { id: "", changed: false };
    const id = newId();
    await tx.query(
      `INSERT INTO payroll_informed (id, tenant_id, entity_id, competence, total, reason, informed_by)
       VALUES ($1, current_tenant(), $2, $3, $4, $5, $6)`,
      [id, input.entityId, input.competence, total, reason, actor.id],
    );
    await audit(tx, {
      actor,
      action: "tax.payroll_informed",
      resourceType: "payroll_informed",
      resourceId: id,
      entityId: input.entityId,
      competence: input.competence,
      data: { total, reason, previous: last.rows[0]?.total ?? null },
    });
    await appendEvent(tx, {
      type: "PAYROLL_INFORMED",
      schemaVersion: 1,
      producer: { kind: "user", name: actor.id, version: "1" },
      idempotencyKey: `folha:${input.entityId}:${input.competence.slice(0, 7)}:${id}`,
      entityId: input.entityId,
      competence: input.competence,
      payload: { entity_id: input.entityId, competence: input.competence, total, informed_by: actor.id },
    });
    return { id, changed: true };
  });
}
