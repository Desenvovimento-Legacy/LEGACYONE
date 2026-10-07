import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";
import { z } from "zod";
import { newId } from "../../shared/ids.js";
import { validatePayload, type EventType } from "./registry.js";

export const Producer = z.object({
  kind: z.enum(["agent", "engine", "service", "user"]),
  name: z.string().min(1),
  version: z.string().min(1),
});
export type Producer = z.infer<typeof Producer>;

export interface NewEvent {
  type: EventType;
  schemaVersion: number;
  producer: Producer;
  /** Chave de idempotência por tenant: o mesmo fato não gera dois eventos. */
  idempotencyKey: string;
  payload: unknown;
  entityId?: string | null;
  establishmentId?: string | null;
  caseId?: string | null;
  /** Data no 1º dia do mês (YYYY-MM-01). */
  competence?: string | null;
  causationId?: string | null;
  /** Cadeia inteira de um Case. Padrão: o próprio event_id (início de cadeia). */
  correlationId?: string | null;
  evidenceRefs?: string[];
  confidence?: number | null;
}

export interface StoredEvent {
  event_id: string;
  tenant_id: string;
  type: string;
  schema_version: number;
  entity_id: string | null;
  establishment_id: string | null;
  case_id: string | null;
  competence: string | null;
  occurred_at: Date;
  producer: Producer;
  causation_id: string | null;
  correlation_id: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  evidence_refs: string[];
  confidence: string | null;
}

/**
 * Cadeia de causa: quando um agente reage a um evento (Orquestrador), todo
 * evento que ele gravar durante a reação aponta para o evento de origem
 * (causation_id) e herda a correlação. Assim a tela mostra o encadeamento.
 */
export const eventCause = new AsyncLocalStorage<{ causationId: string; correlationId: string }>();

/**
 * Grava um evento no outbox DENTRO da transação do chamador (`tx` vem de
 * withTenant). Se a transação fizer rollback, o evento também some.
 * Idempotente: repetir a mesma idempotencyKey devolve o evento já gravado.
 */
export async function appendEvent(tx: PoolClient, event: NewEvent): Promise<StoredEvent> {
  const payload = validatePayload(event.type, event.schemaVersion, event.payload);
  Producer.parse(event.producer);
  const eventId = newId();

  const inserted = await tx.query<StoredEvent>(
    `INSERT INTO outbox (event_id, tenant_id, type, schema_version, entity_id, establishment_id, case_id,
                         competence, producer, causation_id, correlation_id, idempotency_key, payload,
                         evidence_refs, confidence)
     VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
     RETURNING *`,
    [
      eventId,
      event.type,
      event.schemaVersion,
      event.entityId ?? null,
      event.establishmentId ?? null,
      event.caseId ?? null,
      event.competence ?? null,
      JSON.stringify(event.producer),
      event.causationId ?? eventCause.getStore()?.causationId ?? null,
      event.correlationId ?? eventCause.getStore()?.correlationId ?? eventId,
      event.idempotencyKey,
      JSON.stringify(payload),
      JSON.stringify(event.evidenceRefs ?? []),
      event.confidence ?? null,
    ],
  );
  if (inserted.rows[0]) return inserted.rows[0];

  const existing = await tx.query<StoredEvent>(
    "SELECT * FROM outbox WHERE tenant_id = current_tenant() AND idempotency_key = $1",
    [event.idempotencyKey],
  );
  return existing.rows[0]!;
}
