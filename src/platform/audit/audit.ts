import type { PoolClient } from "pg";
import type { Actor } from "../../shared/actor.js";

export interface AuditEntry {
  actor: Actor;
  /** Verbo no formato dominio.acao: "case.create", "case.transition". */
  action: string;
  resourceType: string;
  resourceId?: string | null;
  entityId?: string | null;
  establishmentId?: string | null;
  competence?: string | null;
  caseId?: string | null;
  /** Regra e versão aplicadas, quando houver: "posting-rule:energia@3". */
  ruleRef?: string | null;
  confidence?: number | null;
  /** Entrada, saída, antes/depois — o que for necessário para reproduzir a decisão. */
  data?: Record<string, unknown>;
  evidenceRefs?: string[];
  approvedBy?: string | null;
  correlationId?: string | null;
}

export interface AuditRecord {
  seq: string;
  hash: Buffer;
}

/**
 * Registra uma ação no audit log DENTRO da transação do chamador.
 * Sequência e hash encadeado são calculados pelo banco.
 */
export async function audit(tx: PoolClient, e: AuditEntry): Promise<AuditRecord> {
  const { rows } = await tx.query<AuditRecord>(
    `INSERT INTO audit_log (tenant_id, seq, actor_kind, actor_id, ai_model, action, resource_type, resource_id,
                            entity_id, establishment_id, competence, case_id, rule_ref, confidence, data,
                            evidence_refs, approved_by, correlation_id, prev_hash, hash)
     VALUES (current_tenant(), 0, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, '\\x', '\\x')
     RETURNING seq, hash`,
    [
      e.actor.kind,
      e.actor.id,
      e.actor.model ?? null,
      e.action,
      e.resourceType,
      e.resourceId ?? null,
      e.entityId ?? null,
      e.establishmentId ?? null,
      e.competence ?? null,
      e.caseId ?? null,
      e.ruleRef ?? null,
      e.confidence ?? null,
      JSON.stringify(e.data ?? {}),
      JSON.stringify(e.evidenceRefs ?? []),
      e.approvedBy ?? null,
      e.correlationId ?? null,
    ],
  );
  return rows[0]!;
}

/** null = cadeia íntegra; número = primeira posição adulterada. */
export async function verifyAuditChain(tx: PoolClient): Promise<number | null> {
  const { rows } = await tx.query<{ broken: string | null }>(
    "SELECT audit_verify_chain(current_tenant()) AS broken",
  );
  const broken = rows[0]?.broken;
  return broken == null ? null : Number(broken);
}
