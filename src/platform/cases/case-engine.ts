import type { PoolClient } from "pg";
import { z } from "zod";
import { Actor } from "../../shared/actor.js";
import { parseCompetence } from "../../shared/competence.js";
import { newId } from "../../shared/ids.js";
import { audit } from "../audit/audit.js";
import { appendEvent, type Producer } from "../events/outbox.js";
import { CASE_TYPES, CaseTypeSchema, type CaseType } from "./case-types.js";
import { canTransition, CaseStatus, InvalidTransitionError, TERMINAL } from "./state-machine.js";

const PRODUCER: Producer = { kind: "engine", name: "case-engine", version: "0.1.0" };

export const NewCaseInput = z.object({
  type: CaseTypeSchema,
  /** Chave de idempotência por tenant: repetir o pedido devolve o mesmo Case. */
  idempotencyKey: z.string().min(1).max(200),
  origin: z.string().min(1),
  requester: z.string().min(1),
  entityId: z.uuid().nullish(),
  establishmentId: z.uuid().nullish(),
  /** "YYYY-MM" */
  competence: z.string().nullish(),
  priority: z.number().int().min(1).max(5).default(3),
  ownerAgent: z.string().min(1).optional(),
  deadlineLegal: z.date().nullish(),
  deadlineInternal: z.date().nullish(),
  parentCaseId: z.uuid().nullish(),
});
export type NewCaseInput = z.input<typeof NewCaseInput>;

export interface CaseRow {
  id: string;
  tenant_id: string;
  type: CaseType;
  entity_id: string | null;
  establishment_id: string | null;
  competence: string | null;
  origin: string;
  requester: string;
  status: CaseStatus;
  priority: number;
  owner_agent: string;
  deadline_legal: Date | null;
  deadline_internal: Date | null;
  parent_case_id: string | null;
  idempotency_key: string;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}

export class CaseNotFoundError extends Error {
  constructor(readonly caseId: string) {
    super(`Case não encontrado: ${caseId}`);
    this.name = "CaseNotFoundError";
  }
}

/**
 * Abre um Case. Na mesma transação: Case, transição inicial, evento
 * CASE_CREATED no outbox e registro de auditoria. Idempotente pela chave.
 */
export async function openCase(
  tx: PoolClient,
  rawInput: NewCaseInput,
  rawActor: Actor,
): Promise<{ case: CaseRow; created: boolean }> {
  const input = NewCaseInput.parse(rawInput);
  const actor = Actor.parse(rawActor);
  const spec = CASE_TYPES[input.type];
  if (spec.requiresEntity && !input.entityId) {
    throw new Error(`Case ${input.type} exige entityId`);
  }
  const competence = input.competence ? parseCompetence(input.competence) : null;
  const id = newId();

  const inserted = await tx.query<CaseRow>(
    `INSERT INTO "case" (id, tenant_id, type, entity_id, establishment_id, competence, origin, requester,
                         priority, owner_agent, deadline_legal, deadline_internal, parent_case_id, idempotency_key)
     VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
     RETURNING *`,
    [
      id,
      input.type,
      input.entityId ?? null,
      input.establishmentId ?? null,
      competence,
      input.origin,
      input.requester,
      input.priority,
      input.ownerAgent ?? spec.owner,
      input.deadlineLegal ?? null,
      input.deadlineInternal ?? null,
      input.parentCaseId ?? null,
      input.idempotencyKey,
    ],
  );

  const row = inserted.rows[0];
  if (!row) {
    const existing = await tx.query<CaseRow>(
      `SELECT * FROM "case" WHERE tenant_id = current_tenant() AND idempotency_key = $1`,
      [input.idempotencyKey],
    );
    return { case: existing.rows[0]!, created: false };
  }

  await tx.query(
    `INSERT INTO case_transition (id, tenant_id, case_id, from_status, to_status, reason, actor_kind, actor_id)
     VALUES ($1, current_tenant(), $2, NULL, 'OPEN', 'case aberto', $3, $4)`,
    [newId(), row.id, actor.kind, actor.id],
  );

  await appendEvent(tx, {
    type: "CASE_CREATED",
    schemaVersion: 1,
    producer: PRODUCER,
    idempotencyKey: `case:${row.id}:created`,
    caseId: row.id,
    entityId: row.entity_id,
    establishmentId: row.establishment_id,
    competence: row.competence,
    correlationId: row.id,
    payload: {
      case_id: row.id,
      case_type: row.type,
      status: row.status,
      owner_agent: row.owner_agent,
      origin: row.origin,
      parent_case_id: row.parent_case_id,
    },
  });

  await audit(tx, {
    actor,
    action: "case.open",
    resourceType: "case",
    resourceId: row.id,
    caseId: row.id,
    entityId: row.entity_id,
    establishmentId: row.establishment_id,
    competence: row.competence,
    correlationId: row.id,
    data: { type: row.type, idempotency_key: row.idempotency_key, owner_agent: row.owner_agent },
  });

  return { case: row, created: true };
}

/**
 * Muda o status de um Case respeitando a máquina de estados. Na mesma
 * transação: transição registrada, eventos no outbox e auditoria.
 * Pedir o status em que o Case já está é uma no-op (reexecução segura).
 */
export async function transitionCase(
  tx: PoolClient,
  params: { caseId: string; to: CaseStatus; reason?: string; causationId?: string },
  rawActor: Actor,
): Promise<{ case: CaseRow; changed: boolean }> {
  const actor = Actor.parse(rawActor);
  const to = CaseStatus.parse(params.to);
  const current = await tx.query<CaseRow>(`SELECT * FROM "case" WHERE id = $1 FOR UPDATE`, [params.caseId]);
  const before = current.rows[0];
  if (!before) throw new CaseNotFoundError(params.caseId);
  if (before.status === to) return { case: before, changed: false };
  if (!canTransition(before.status, to)) throw new InvalidTransitionError(before.status, to);

  const terminal = TERMINAL.has(to);
  const updated = await tx.query<CaseRow>(
    `UPDATE "case" SET status = $2, closed_at = CASE WHEN $3 THEN clock_timestamp() ELSE NULL END
      WHERE id = $1 RETURNING *`,
    [before.id, to, terminal],
  );
  const after = updated.rows[0]!;
  const reason = params.reason ?? null;
  const transitionId = newId();

  await tx.query(
    `INSERT INTO case_transition (id, tenant_id, case_id, from_status, to_status, reason, actor_kind, actor_id)
     VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7)`,
    [transitionId, after.id, before.status, to, reason, actor.kind, actor.id],
  );

  const common = {
    schemaVersion: 1,
    producer: PRODUCER,
    caseId: after.id,
    entityId: after.entity_id,
    establishmentId: after.establishment_id,
    competence: after.competence,
    correlationId: after.id,
    causationId: params.causationId ?? null,
  };
  const changedEvent = await appendEvent(tx, {
    ...common,
    type: "CASE_STATUS_CHANGED",
    idempotencyKey: `case:${after.id}:transition:${transitionId}`,
    payload: { case_id: after.id, case_type: after.type, from: before.status, to, reason },
  });
  if (to === "COMPLETED" || to === "CANCELLED") {
    await appendEvent(tx, {
      ...common,
      type: to === "COMPLETED" ? "CASE_COMPLETED" : "CASE_CANCELLED",
      idempotencyKey: `case:${after.id}:${to.toLowerCase()}`,
      causationId: changedEvent.event_id,
      payload: { case_id: after.id, case_type: after.type, reason },
    });
  }

  await audit(tx, {
    actor,
    action: "case.transition",
    resourceType: "case",
    resourceId: after.id,
    caseId: after.id,
    entityId: after.entity_id,
    establishmentId: after.establishment_id,
    competence: after.competence,
    correlationId: after.id,
    data: { from: before.status, to, reason },
  });

  return { case: after, changed: true };
}

export async function getCase(tx: PoolClient, caseId: string): Promise<CaseRow | null> {
  const { rows } = await tx.query<CaseRow>(`SELECT * FROM "case" WHERE id = $1`, [caseId]);
  return rows[0] ?? null;
}
