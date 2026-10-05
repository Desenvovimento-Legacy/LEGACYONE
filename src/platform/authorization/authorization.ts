import type { PoolClient } from "pg";
import { Actor } from "../../shared/actor.js";
import { newId } from "../../shared/ids.js";
import { audit } from "../audit/audit.js";

/**
 * Authorization Service. Todo acesso a sistema externo em nome de um cliente
 * passa por aqui: o agente pede, a política decide, e só uma decisão ALLOW gera
 * uma autorização de uso único e curta. O conector troca essa autorização pela
 * credencial no cofre; o agente nunca toca na credencial.
 */

export type AuthorizationAction =
  /** Consulta somente leitura ao Integra Contador em nome do contribuinte. */
  | "integra.read"
  /** Transmissão de obrigação a órgão externo. */
  | "obligation.transmit";

/** Serviços do e-CAC exigidos por ação (código da procuração eletrônica). */
const REQUIRED_SCOPE: Partial<Record<AuthorizationAction, string>> = {
  "integra.read": "ECAC",
};

const GRANT_TTL_MS = 5 * 60 * 1000;

export type AuthorizationDecision =
  | { decision: "ALLOW"; grantId: string; expiresAt: Date; policy: string }
  | { decision: "DENY"; reason: string; policy: string };

export interface AuthorizationRequest {
  action: AuthorizationAction;
  entityId: string;
  /** Data de referência para checar vigência de procuração. Padrão: hoje. */
  onDate?: string;
  scope?: Record<string, unknown>;
}

async function hasActivePowerOfAttorney(tx: PoolClient, entityId: string, onDate: string, scope: string) {
  const { rows } = await tx.query(
    `SELECT 1 FROM power_of_attorney
      WHERE entity_id = $1 AND system = 'ECAC'
        AND $2::date <@ daterange(valid_from, valid_to, '[]')
        AND ($3 = 'ECAC' OR $3 = ANY (scopes))
      LIMIT 1`,
    [entityId, onDate, scope],
  );
  return rows.length > 0;
}

export async function requestAuthorization(
  tx: PoolClient,
  req: AuthorizationRequest,
  rawActor: Actor,
): Promise<AuthorizationDecision> {
  const actor = Actor.parse(rawActor);
  const onDate = req.onDate ?? new Date().toISOString().slice(0, 10);
  let result: AuthorizationDecision;

  if (req.action === "obligation.transmit") {
    // Transmissão exige aprovação humana até a promoção formal para L4 (seção 32).
    result = { decision: "DENY", policy: "transmit.requires-l4@1", reason: "Transmissão exige aprovação humana nesta fase" };
  } else {
    const scope = REQUIRED_SCOPE[req.action] ?? "ECAC";
    const ok = await hasActivePowerOfAttorney(tx, req.entityId, onDate, scope);
    result = ok
      ? { decision: "ALLOW", grantId: newId(), expiresAt: new Date(Date.now() + GRANT_TTL_MS), policy: "integra.read.poa@1" }
      : { decision: "DENY", policy: "integra.read.poa@1", reason: "Sem procuração eletrônica vigente para o escritório" };
  }

  if (result.decision === "ALLOW") {
    await tx.query(
      `INSERT INTO authorization_grant (id, tenant_id, actor_kind, actor_id, action, entity_id, scope, policy_ref, expires_at)
       VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8)`,
      [result.grantId, actor.kind, actor.id, req.action, req.entityId, JSON.stringify(req.scope ?? {}), result.policy, result.expiresAt],
    );
  }
  await audit(tx, {
    actor,
    action: `authorization.${result.decision.toLowerCase()}`,
    resourceType: "authorization",
    resourceId: result.decision === "ALLOW" ? result.grantId : null,
    entityId: req.entityId,
    ruleRef: result.policy,
    data: { action: req.action, ...(result.decision === "DENY" ? { reason: result.reason } : {}) },
  });
  return result;
}

export class GrantInvalidError extends Error {
  constructor(reason: string) {
    super(`Autorização inválida: ${reason}`);
    this.name = "GrantInvalidError";
  }
}

/**
 * Consome a autorização (uso único). Chamado pelo conector imediatamente antes
 * de buscar a credencial no cofre.
 */
export async function consumeGrant(tx: PoolClient, grantId: string, action: AuthorizationAction): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE authorization_grant SET consumed_at = clock_timestamp()
      WHERE id = $1 AND action = $2 AND consumed_at IS NULL AND expires_at > clock_timestamp()`,
    [grantId, action],
  );
  if (!rowCount) throw new GrantInvalidError("inexistente, expirada, já utilizada ou emitida para outra ação");
}
