import type { Pool, PoolClient } from "pg";
import { audit } from "../../platform/audit/audit.js";
import { appendEvent } from "../../platform/events/outbox.js";
import type { Actor } from "../../shared/actor.js";
import { formatCnpj } from "../../shared/br/documents.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";
import { dfeCursor } from "./dfe-sync.js";

/** Documentos fiscais recebidos: listas para a tela e a decisão de ciência da operação. */

export const CIENCIA = "210210";

/**
 * NF-e que chegaram só como resumo, autorizadas, sem XML completo e sem
 * ciência aprovada: esperam a decisão humana (política do escritório).
 */
const AWAITING_CIENCIA = `
  FROM dfe_document r
 WHERE r.kind = 'RES_NFE' AND r.situation = '1' AND r.access_key IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM dfe_document f WHERE f.entity_id = r.entity_id AND f.kind = 'NFE' AND f.access_key = r.access_key)
   AND NOT EXISTS (SELECT 1 FROM nfe_manifestation m WHERE m.entity_id = r.entity_id AND m.access_key = r.access_key
                     AND m.event_type = '${CIENCIA}' AND m.status IN ('APROVADA', 'ENVIADA', 'REGISTRADA'))`;

export async function cienciaQueue(tx: PoolClient) {
  const { rows } = await tx.query<{ entity_id: string; entity: string; n: number; total: string | null; oldest: Date | null }>(
    `SELECT r.entity_id, coalesce(e.trade_name, e.legal_name) AS entity, count(*)::int AS n, sum(r.total)::text AS total,
            min(r.received_at) AS oldest
       ${AWAITING_CIENCIA.replace("FROM dfe_document r", "FROM dfe_document r JOIN entity e ON e.id = r.entity_id")}
      GROUP BY r.entity_id, e.trade_name, e.legal_name ORDER BY entity`,
  );
  return rows;
}

/** Aprovação humana da ciência para todas as notas que aguardam, de uma empresa. */
export async function approveCiencia(pool: Pool, tenantId: string, entityId: string, actor: Actor) {
  if (actor.kind !== "USER") throw new Error("Só uma pessoa aprova a ciência da operação");
  return withTenant(pool, tenantId, async (tx) => {
    const { rows } = await tx.query<{ access_key: string }>(`SELECT DISTINCT r.access_key ${AWAITING_CIENCIA} AND r.entity_id = $1`, [entityId]);
    const keys = rows.map((r) => r.access_key);
    if (!keys.length) return { approved: 0 };
    for (const k of keys) {
      await tx.query(
        `INSERT INTO nfe_manifestation (id, tenant_id, entity_id, access_key, event_type, status, actor_kind, actor_id)
         VALUES ($1, current_tenant(), $2, $3, '${CIENCIA}', 'APROVADA', $4, $5) ON CONFLICT DO NOTHING`,
        [newId(), entityId, k, actor.kind, actor.id],
      );
    }
    await appendEvent(tx, {
      type: "NFE_MANIFESTATION_APPROVED",
      schemaVersion: 1,
      producer: { kind: "user", name: actor.id, version: "1" },
      idempotencyKey: `ciencia:${entityId}:${keys.join(",").slice(0, 400)}:${keys.length}`,
      entityId,
      payload: { entity_id: entityId, event_type: CIENCIA, access_keys: keys, approved_by: actor.id },
    });
    await audit(tx, {
      actor,
      action: "documents.ciencia_approved",
      resourceType: "nfe_manifestation",
      entityId,
      approvedBy: actor.id,
      data: { event_type: CIENCIA, access_keys: keys },
    });
    return { approved: keys.length };
  });
}

/** Situação da busca por empresa (para a tela). */
export async function dfeStatus(tx: PoolClient) {
  const ents = await tx.query<{ id: string; name: string; cnpj: string; has_cert: boolean; docs: number; full: number; summaries: number }>(
    `SELECT e.id, coalesce(e.trade_name, e.legal_name) AS name, e.cnpj,
            EXISTS (SELECT 1 FROM digital_certificate d WHERE d.entity_id = e.id AND d.status = 'ACTIVE' AND d.valid_to > now()) AS has_cert,
            (SELECT count(*)::int FROM dfe_document x WHERE x.entity_id = e.id) AS docs,
            (SELECT count(*)::int FROM dfe_document x WHERE x.entity_id = e.id AND x.kind = 'NFE') AS full,
            (SELECT count(*)::int FROM dfe_document x WHERE x.entity_id = e.id AND x.kind = 'RES_NFE') AS summaries
       FROM entity e WHERE e.cnpj IS NOT NULL ORDER BY e.legal_name`,
  );
  const out = [];
  for (const e of ents.rows) {
    const c = await dfeCursor(tx, e.id);
    out.push({
      id: e.id,
      name: e.name,
      cnpj: formatCnpj(e.cnpj),
      hasCertificate: e.has_cert,
      documents: e.docs,
      fullNfe: e.full,
      summaries: e.summaries,
      ultNsu: c.ultNsu,
      maxNsu: c.maxNsu,
      lastStatus: c.lastStatus,
      lastMessage: c.lastMessage,
      lastQueryAt: c.lastQueryAt ? c.lastQueryAt.toISOString() : null,
      nextAllowedAt: c.nextAllowedAt ? c.nextAllowedAt.toISOString() : null,
    });
  }
  return out;
}

/** Notas e eventos recebidos (mais recentes primeiro). Situação de ciência por chave. */
export async function documentsList(tx: PoolClient, filter: { entityId?: string | null; limit?: number }) {
  const { rows } = await tx.query<{
    id: string; entity: string; nsu: string; kind: string; access_key: string | null; issuer_doc: string | null; issuer_name: string | null;
    issued_at: Date | null; total: string | null; situation: string | null; event_type: string | null; event_desc: string | null;
    received_at: Date; has_full: boolean; ciencia: string | null;
  }>(
    `SELECT d.id, coalesce(e.trade_name, e.legal_name) AS entity, d.nsu, d.kind, d.access_key, d.issuer_doc, d.issuer_name,
            d.issued_at, d.total::text, d.situation, d.event_type, d.event_desc, d.received_at,
            EXISTS (SELECT 1 FROM dfe_document f WHERE f.entity_id = d.entity_id AND f.kind = 'NFE' AND f.access_key = d.access_key) AS has_full,
            (SELECT m.status FROM nfe_manifestation m WHERE m.entity_id = d.entity_id AND m.access_key = d.access_key
                AND m.event_type = '${CIENCIA}' ORDER BY m.at DESC LIMIT 1) AS ciencia
       FROM dfe_document d JOIN entity e ON e.id = d.entity_id
      WHERE ($1::uuid IS NULL OR d.entity_id = $1)
      ORDER BY coalesce(d.issued_at, d.received_at) DESC, d.nsu DESC
      LIMIT $2`,
    [filter.entityId ?? null, filter.limit ?? 300],
  );
  return rows.map((r) => ({
    id: r.id,
    entity: r.entity,
    nsu: r.nsu,
    kind: r.kind,
    accessKey: r.access_key,
    issuerDoc: r.issuer_doc && r.issuer_doc.length === 14 ? formatCnpj(r.issuer_doc) : r.issuer_doc,
    issuerName: r.issuer_name,
    issuedAt: r.issued_at ? r.issued_at.toISOString() : null,
    total: r.total,
    situation: r.situation,
    eventType: r.event_type,
    eventDesc: r.event_desc,
    receivedAt: r.received_at.toISOString(),
    hasFull: r.has_full,
    ciencia: r.ciencia,
  }));
}
