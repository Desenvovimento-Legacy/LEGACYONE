import type { PoolClient } from "pg";
import { z } from "zod";
import { Actor } from "../../shared/actor.js";
import { isValidCnpj, isValidCpf, normalizeCnpj, normalizeCpf } from "../../shared/br/documents.js";
import { newId } from "../../shared/ids.js";
import { audit } from "../../platform/audit/audit.js";

/**
 * Cadastro de entidades (Entity Registry). Tipo de entidade, regime tributário
 * e serviços contratados são dimensões separadas e temporais.
 */

export const EntityType = z.enum([
  "SOCIEDADE_EMPRESARIA",
  "SOCIEDADE_SIMPLES",
  "EMPRESARIO_INDIVIDUAL",
  "SLU",
  "ASSOCIACAO",
  "FUNDACAO",
  "ORGANIZACAO_RELIGIOSA",
  "COOPERATIVA",
  "CONDOMINIO",
  "PRODUTOR_RURAL",
  "PESSOA_FISICA",
]);
export const TaxRegime = z.enum([
  "SIMPLES_NACIONAL",
  "MEI",
  "LUCRO_PRESUMIDO",
  "LUCRO_REAL_ANUAL",
  "LUCRO_REAL_TRIMESTRAL",
  "LUCRO_ARBITRADO",
  "IMUNE",
  "ISENTA",
]);
export const ContractedService = z.enum(["CONTABIL", "FISCAL", "FOLHA", "SOCIETARIO", "FINANCEIRO", "IRPF"]);

const IsoDate = z.iso.date();

export async function createClient(tx: PoolClient, name: string, actor: Actor): Promise<string> {
  const id = newId();
  await tx.query("INSERT INTO client (id, tenant_id, name) VALUES ($1, current_tenant(), $2)", [id, name]);
  await audit(tx, { actor, action: "client.create", resourceType: "client", resourceId: id, data: { name } });
  return id;
}

export const NewEntity = z.discriminatedUnion("personKind", [
  z.object({
    personKind: z.literal("PJ"),
    clientId: z.uuid(),
    cnpj: z.string().transform(normalizeCnpj).refine(isValidCnpj, "CNPJ inválido"),
    legalName: z.string().min(1),
    tradeName: z.string().optional(),
  }),
  z.object({
    personKind: z.literal("PF"),
    clientId: z.uuid(),
    cpf: z.string().transform(normalizeCpf).refine(isValidCpf, "CPF inválido"),
    legalName: z.string().min(1),
  }),
]);

export async function createEntity(tx: PoolClient, raw: z.input<typeof NewEntity>, actor: Actor): Promise<string> {
  const e = NewEntity.parse(raw);
  const id = newId();
  await tx.query(
    `INSERT INTO entity (id, tenant_id, client_id, person_kind, cnpj, cpf, legal_name, trade_name)
     VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7)`,
    [
      id,
      e.clientId,
      e.personKind,
      e.personKind === "PJ" ? e.cnpj : null,
      e.personKind === "PF" ? e.cpf : null,
      e.legalName,
      e.personKind === "PJ" ? (e.tradeName ?? null) : null,
    ],
  );
  await audit(tx, {
    actor,
    action: "entity.create",
    resourceType: "entity",
    resourceId: id,
    entityId: id,
    data: { person_kind: e.personKind, legal_name: e.legalName },
  });
  return id;
}

type HistoryTable = "entity_type_history" | "tax_regime_history" | "contracted_service_history";
const COLUMN: Record<HistoryTable, string> = {
  entity_type_history: "entity_type",
  tax_regime_history: "regime",
  contracted_service_history: "service",
};

/**
 * Registra uma vigência. A sobreposição de períodos é recusada pelo banco
 * (constraint de exclusão). Para trocar de regime: encerra a vigência atual
 * (closeVigency) e registra a nova.
 */
async function addVigency(
  tx: PoolClient,
  table: HistoryTable,
  p: { entityId: string; value: string; validFrom: string; validTo?: string | null; source: string },
  actor: Actor,
): Promise<string> {
  const id = newId();
  await tx.query(
    `INSERT INTO ${table} (id, tenant_id, entity_id, ${COLUMN[table]}, valid_from, valid_to, source)
     VALUES ($1, current_tenant(), $2, $3, $4, $5, $6)`,
    [id, p.entityId, p.value, IsoDate.parse(p.validFrom), p.validTo ? IsoDate.parse(p.validTo) : null, p.source],
  );
  await audit(tx, {
    actor,
    action: `${table}.add`,
    resourceType: table,
    resourceId: id,
    entityId: p.entityId,
    data: { value: p.value, valid_from: p.validFrom, valid_to: p.validTo ?? null, source: p.source },
  });
  return id;
}

export const setEntityType = (
  tx: PoolClient,
  p: { entityId: string; entityType: z.infer<typeof EntityType>; validFrom: string; validTo?: string | null; source: string },
  actor: Actor,
) => addVigency(tx, "entity_type_history", { ...p, value: EntityType.parse(p.entityType) }, actor);

export const setTaxRegime = (
  tx: PoolClient,
  p: { entityId: string; regime: z.infer<typeof TaxRegime>; validFrom: string; validTo?: string | null; source: string },
  actor: Actor,
) => addVigency(tx, "tax_regime_history", { ...p, value: TaxRegime.parse(p.regime) }, actor);

export const addContractedService = (
  tx: PoolClient,
  p: {
    entityId: string;
    service: z.infer<typeof ContractedService>;
    validFrom: string;
    validTo?: string | null;
    source: string;
  },
  actor: Actor,
) => addVigency(tx, "contracted_service_history", { ...p, value: ContractedService.parse(p.service) }, actor);

/** Encerra a vigência aberta (valid_to NULL) de um histórico em uma data. */
export async function closeVigency(
  tx: PoolClient,
  table: HistoryTable,
  p: { entityId: string; validTo: string; service?: string },
  actor: Actor,
): Promise<void> {
  const extra = table === "contracted_service_history" ? "AND service = $3" : "";
  const params = [p.entityId, IsoDate.parse(p.validTo), ...(p.service ? [p.service] : [])];
  const { rowCount } = await tx.query(
    `UPDATE ${table} SET valid_to = $2 WHERE entity_id = $1 AND valid_to IS NULL ${extra}`,
    params,
  );
  if (!rowCount) throw new Error(`Nenhuma vigência aberta em ${table} para a entidade ${p.entityId}`);
  await audit(tx, {
    actor,
    action: `${table}.close`,
    resourceType: table,
    entityId: p.entityId,
    data: { valid_to: p.validTo, service: p.service ?? null },
  });
}

export interface EntityProfile {
  entity_type: string | null;
  regime: string | null;
  services: string[];
}

/** Configuração vigente da entidade em uma data. */
export async function profileAsOf(tx: PoolClient, entityId: string, date: string): Promise<EntityProfile> {
  const { rows } = await tx.query<EntityProfile>("SELECT * FROM entity_profile_as_of($1, $2)", [
    entityId,
    IsoDate.parse(date),
  ]);
  return rows[0]!;
}
