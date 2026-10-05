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
} as const satisfies Record<string, Record<number, z.ZodType>>;

export type EventType = keyof typeof EventContracts;

export function validatePayload(type: string, version: number, payload: unknown): unknown {
  const versions = (EventContracts as Record<string, Record<number, z.ZodType>>)[type];
  if (!versions) throw new Error(`Evento não registrado: ${type}`);
  const schema = versions[version];
  if (!schema) throw new Error(`Versão ${version} do evento ${type} não registrada`);
  return schema.parse(payload);
}
