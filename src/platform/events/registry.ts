import { z } from "zod";
import { CaseStatus } from "../cases/state-machine.js";

/**
 * Registro de contratos de eventos. Um evento só entra no outbox se o tipo e a
 * versão de schema estiverem aqui e o payload validar. Quebrar um contrato exige
 * nova versão, mantendo a anterior durante o período de convivência.
 *
 * Nomenclatura: ENTIDADE_VERBO_NO_PASSADO.
 */
const CaseRef = z.object({
  case_id: z.uuid(),
  case_type: z.string(),
});

export const EventContracts = {
  CASE_CREATED: {
    1: CaseRef.extend({
      status: CaseStatus,
      owner_agent: z.string(),
      origin: z.string(),
      parent_case_id: z.uuid().nullable(),
    }),
  },
  CASE_STATUS_CHANGED: {
    1: CaseRef.extend({
      from: CaseStatus,
      to: CaseStatus,
      reason: z.string().nullable(),
    }),
  },
  CASE_COMPLETED: {
    1: CaseRef.extend({ reason: z.string().nullable() }),
  },
  CASE_CANCELLED: {
    1: CaseRef.extend({ reason: z.string().nullable() }),
  },
  ENTITY_PROFILE_CREATED: {
    1: z.object({
      entity_id: z.uuid(),
      cnpj: z.string().nullable(),
      entity_type: z.string().nullable(),
      regime: z.string().nullable(),
      establishments: z.number().int(),
      activities: z.number().int(),
      partners: z.number().int(),
      source: z.string(),
    }),
  },
  PENDING_ITEM_CREATED: {
    1: z.object({
      pending_item_id: z.uuid(),
      type: z.string(),
      responsible_source: z.enum(["CLIENT", "OFFICE", "EXTERNAL"]),
      required_information: z.string(),
      impact: z.string(),
    }),
  },
  POWER_OF_ATTORNEY_VERIFIED: {
    1: z.object({
      entity_id: z.uuid(),
      system: z.string(),
      active: z.boolean(),
      services: z.array(z.string()),
      source: z.string(),
    }),
  },
  CONTRACTED_SERVICES_DEFINED: {
    1: z.object({
      entity_id: z.uuid(),
      services: z.array(z.string()).min(1),
      valid_from: z.iso.date(),
      defined_by: z.string(),
    }),
  },
  IMPLEMENTATION_PLAN_CREATED: {
    1: z.object({
      entity_id: z.uuid(),
      checklist_items: z.number().int(),
      obligations_added: z.number().int(),
      rules_pending_approval: z.number().int(),
      migration_case_id: z.uuid().nullable(),
      facts: z.record(z.string(), z.unknown()),
    }),
  },
  PGDAS_INDEX_SYNCED: {
    1: z.object({
      entity_id: z.uuid(),
      year: z.number().int(),
      /** Presente na busca por competência; nulo na carga do ano inteiro. */
      competence: z.iso.date().nullable().optional(),
      declarations: z.number().int(),
      das: z.number().int(),
      new_declarations: z.number().int(),
      new_das: z.number().int(),
      source: z.string(),
    }),
  },
  FEDERAL_PAYMENTS_SYNCED: {
    1: z.object({
      entity_id: z.uuid(),
      from: z.iso.date(),
      to: z.iso.date(),
      payments: z.number().int(),
      new_payments: z.number().int(),
      source: z.string(),
    }),
  },
  DIGITAL_CERTIFICATE_REGISTERED: {
    1: z.object({
      entity_id: z.uuid(),
      certificate_id: z.uuid(),
      kind: z.enum(["A1", "A3"]),
      holder_document: z.string(),
      valid_to: z.iso.date(),
      replaced: z.number().int(),
    }),
  },
  DFE_BATCH_RECEIVED: {
    1: z.object({
      entity_id: z.uuid(),
      documents: z.number().int(),
      kinds: z.record(z.string(), z.number().int()),
      ult_nsu: z.string().nullable(),
      max_nsu: z.string().nullable(),
    }),
  },
  NFE_MANIFESTATION_APPROVED: {
    1: z.object({
      entity_id: z.uuid(),
      event_type: z.string(),
      access_keys: z.array(z.string()).min(1),
      approved_by: z.string(),
    }),
  },
  NFSE_BATCH_RECEIVED: {
    1: z.object({
      entity_id: z.uuid(),
      documents: z.number().int(),
      roles: z.record(z.string(), z.number().int()),
      from_nsu: z.number().int(),
      to_nsu: z.number().int(),
    }),
  },
  PGDAS_DECLARATION_READ: {
    1: z.object({
      entity_id: z.uuid(),
      competence: z.iso.date(),
      declaration_number: z.string().nullable(),
      months: z.number().int(),
      regime: z.string().nullable(),
      found: z.boolean(),
    }),
  },
  REVENUE_DIVERGENCE_DETECTED: {
    1: z.object({
      entity_id: z.uuid(),
      competence: z.iso.date(),
      declared: z.string(),
      nfse: z.string(),
      difference: z.string(),
      hypothesis: z.string(),
      responsibility: z.enum(["ANTERIOR", "LEGACY"]).nullable(),
    }),
  },
  EXCEPTION_DECIDED: {
    1: z.object({
      case_id: z.uuid(),
      decision: z.string(),
      note: z.string().nullable(),
      decided_by: z.string(),
    }),
  },
  SIMPLES_RULES_APPROVED: {
    1: z.object({
      rules: z.array(z.string()).min(1),
      approved_by: z.string(),
    }),
  },
  SIMPLES_CALCULATED: {
    1: z.object({
      entity_id: z.uuid(),
      competence: z.iso.date(),
      mode: z.enum(["CONFERENCIA", "APURACAO"]),
      status: z.string(),
      total: z.string().nullable(),
      reference_total: z.string().nullable(),
      difference: z.string().nullable(),
      rules: z.array(z.string()),
    }),
  },
  GUIDE_STATUS_CHANGED: {
    1: z.object({
      entity_id: z.uuid(),
      competence: z.iso.date(),
      guide: z.enum(["DAS_SIMPLES"]),
      from: z.string().nullable(),
      to: z.string(),
      due: z.iso.date().nullable(),
      documents: z.array(z.string()),
    }),
  },
  USER_INVITED: {
    1: z.object({
      user_id: z.uuid(),
      role: z.enum(["LEITURA", "OPERADOR", "RESPONSAVEL_TECNICO"]),
      expires_at: z.iso.datetime(),
    }),
  },
  USER_ENROLLED: {
    1: z.object({ user_id: z.uuid() }),
  },
  USER_ACCESS_CHANGED: {
    1: z.object({
      user_id: z.uuid(),
      role: z.enum(["LEITURA", "OPERADOR", "RESPONSAVEL_TECNICO"]),
      active: z.boolean(),
      reason: z.string().nullable(),
    }),
  },
} as const satisfies Record<string, Record<number, z.ZodType>>;

export type EventType = keyof typeof EventContracts;

export function validatePayload(type: string, version: number, payload: unknown): unknown {
  const versions = (EventContracts as Record<string, Record<number, z.ZodType>>)[type];
  if (!versions) throw new Error(`Evento não registrado: ${type}`);
  const schema = versions[version];
  if (!schema) throw new Error(`Versão ${version} do evento ${type} não registrada`);
  return schema.parse(payload);
}
