import type { PoolClient } from "pg";
import type { Actor } from "../../shared/actor.js";
import { newId } from "../../shared/ids.js";
import { audit } from "../audit/audit.js";
import { appendEvent } from "../events/outbox.js";

export type ResponsibleSource = "CLIENT" | "OFFICE" | "EXTERNAL";

export interface NewPendingItem {
  type: string;
  entityId?: string | null;
  caseId?: string | null;
  requiredInformation: string;
  responsibleSource: ResponsibleSource;
  impact: string;
  channel?: string | null;
  deadline?: Date | null;
}

export interface PendingItemRow {
  id: string;
  type: string;
  entity_id: string | null;
  case_id: string | null;
  required_information: string;
  responsible_source: ResponsibleSource;
  impact: string;
  status: "OPEN" | "RESOLVED" | "WAIVED";
}

/**
 * Pending Engine: registra o que falta para um processo seguir. Idempotente:
 * a mesma pendência aberta (entidade + tipo) não é duplicada.
 * One Relationship agrupa as pendências do cliente em uma única solicitação.
 */
export async function openPendingItem(
  tx: PoolClient,
  p: NewPendingItem,
  actor: Actor,
): Promise<{ item: PendingItemRow; created: boolean }> {
  const id = newId();
  const ins = await tx.query<PendingItemRow>(
    `INSERT INTO pending_item (id, tenant_id, entity_id, case_id, type, required_information, responsible_source,
                               channel, impact, deadline)
     VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      id,
      p.entityId ?? null,
      p.caseId ?? null,
      p.type,
      p.requiredInformation,
      p.responsibleSource,
      p.channel ?? null,
      p.impact,
      p.deadline ?? null,
    ],
  );
  const created = ins.rows[0];
  if (!created) {
    const existing = await tx.query<PendingItemRow>(
      `SELECT * FROM pending_item WHERE status = 'OPEN' AND type = $1
          AND entity_id IS NOT DISTINCT FROM $2`,
      [p.type, p.entityId ?? null],
    );
    return { item: existing.rows[0]!, created: false };
  }

  await appendEvent(tx, {
    type: "PENDING_ITEM_CREATED",
    schemaVersion: 1,
    producer: { kind: "engine", name: "pending-engine", version: "0.1.0" },
    idempotencyKey: `pending:${created.id}:created`,
    entityId: created.entity_id,
    caseId: created.case_id,
    correlationId: created.case_id ?? created.id,
    payload: {
      pending_item_id: created.id,
      type: created.type,
      responsible_source: created.responsible_source,
      required_information: created.required_information,
      impact: created.impact,
    },
  });
  await audit(tx, {
    actor,
    action: "pending.open",
    resourceType: "pending_item",
    resourceId: created.id,
    entityId: created.entity_id,
    caseId: created.case_id,
    data: { type: created.type, responsible_source: created.responsible_source },
  });
  return { item: created, created: true };
}

export async function resolvePendingItem(
  tx: PoolClient,
  p: { id: string; resolution: string; waived?: boolean },
  actor: Actor,
): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE pending_item SET status = $2, resolution = $3, resolved_at = clock_timestamp()
      WHERE id = $1 AND status = 'OPEN'`,
    [p.id, p.waived ? "WAIVED" : "RESOLVED", p.resolution],
  );
  if (!rowCount) return;
  await audit(tx, {
    actor,
    action: p.waived ? "pending.waive" : "pending.resolve",
    resourceType: "pending_item",
    resourceId: p.id,
    data: { resolution: p.resolution },
  });
}

export async function openPendingItems(tx: PoolClient, filter: { caseId?: string; entityId?: string }) {
  const { rows } = await tx.query<PendingItemRow>(
    `SELECT * FROM pending_item
      WHERE status = 'OPEN'
        AND ($1::uuid IS NULL OR case_id = $1)
        AND ($2::uuid IS NULL OR entity_id = $2)
      ORDER BY created_at`,
    [filter.caseId ?? null, filter.entityId ?? null],
  );
  return rows;
}
