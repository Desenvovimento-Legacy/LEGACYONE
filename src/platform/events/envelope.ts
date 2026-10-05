import type { StoredEvent } from "./outbox.js";

/** Envelope publicado no barramento. Mesmo formato para todo evento. */
export interface EventEnvelope {
  event_id: string;
  type: string;
  schema_version: number;
  tenant_id: string;
  entity_id: string | null;
  establishment_id: string | null;
  case_id: string | null;
  competence: string | null;
  occurred_at: string;
  producer: StoredEvent["producer"];
  causation_id: string | null;
  correlation_id: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  evidence_refs: string[];
  confidence: number | null;
}

export function toEnvelope(e: StoredEvent): EventEnvelope {
  return {
    event_id: e.event_id,
    type: e.type,
    schema_version: e.schema_version,
    tenant_id: e.tenant_id,
    entity_id: e.entity_id,
    establishment_id: e.establishment_id,
    case_id: e.case_id,
    competence: e.competence,
    occurred_at: e.occurred_at.toISOString(),
    producer: e.producer,
    causation_id: e.causation_id,
    correlation_id: e.correlation_id,
    idempotency_key: e.idempotency_key,
    payload: e.payload,
    evidence_refs: e.evidence_refs,
    confidence: e.confidence === null ? null : Number(e.confidence),
  };
}

/** Subject no NATS: isolado por tenant. Ex.: legacy.t.<tenant>.CASE_CREATED */
export function subjectFor(e: Pick<EventEnvelope, "tenant_id" | "type">): string {
  return `legacy.t.${e.tenant_id}.${e.type}`;
}
