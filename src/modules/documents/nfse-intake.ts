import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isAbrasf, splitAbrasf, summarizeAbrasf } from "../../integrations/nfse/abrasf.js";
import { nfseRole, summarizeNfse, type NfseSummary } from "../../integrations/nfse/nfse-parse.js";
import { audit } from "../../platform/audit/audit.js";
import { appendEvent } from "../../platform/events/outbox.js";
import type { Actor } from "../../shared/actor.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";

/**
 * NFS-e que chega por upload ou pasta (padrão nacional ou ABRASF dos emissores
 * municipais) vira nota para o fiscal e o contábil, como as do Ambiente Nacional.
 *
 * Não duplica: a nota já existente com a mesma chave, ou do mesmo prestador com
 * o mesmo número no mesmo dia, não entra de novo. Quando a cópia do ADN chega
 * depois de uma nota enviada por arquivo, ela vai para nfse_duplicate (XML
 * guardado como evidência) e não soma duas vezes.
 */

export interface BridgeResult {
  inserted: number;
  duplicates: number;
  roles: Record<string, number>;
}

/** Nota igual já registrada (chave, ou prestador + número + dia de emissão). */
export async function sameNote(tx: PoolClient, entityId: string, s: NfseSummary, onlyFiles = false): Promise<string | null> {
  if (s.isEvent) return null;
  const r = await tx.query<{ id: string }>(
    `SELECT id FROM nfse_document
      WHERE entity_id = $1 AND role <> 'EVENTO' AND (NOT $6 OR source <> 'ADN')
        AND ((access_key IS NOT NULL AND access_key = $2)
          OR ($3::text IS NOT NULL AND $4::text IS NOT NULL AND provider_doc = $3 AND ltrim(number, '0') = ltrim($4, '0')
              AND (issued_at AT TIME ZONE 'America/Sao_Paulo')::date = ($5::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date))
      LIMIT 1`,
    [entityId, s.accessKey, s.providerDoc, s.number, s.issuedAt, onlyFiles],
  );
  return r.rows[0]?.id ?? null;
}

async function insertNote(
  tx: PoolClient, entityId: string, s: NfseSummary, role: string, xml: string, sha: Buffer,
  meta: { source: "UPLOAD" | "PASTA"; layout: "NACIONAL" | "ABRASF"; fiscalXmlId: string | null; eventType?: string | null },
): Promise<boolean> {
  const ins = await tx.query(
    `INSERT INTO nfse_document (id, tenant_id, entity_id, nsu, access_key, doc_type, event_type, role, number, issued_at, provider_doc, provider_name,
                                taker_doc, taker_name, service_value, net_value, iss_value, iss_withheld, municipality, xml, sha256, source, layout, fiscal_xml_id)
     VALUES ($1, current_tenant(), $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
     ON CONFLICT DO NOTHING`,
    [newId(), entityId, s.accessKey, meta.layout === "ABRASF" ? "NFSE_MUNICIPAL" : "NFSE", meta.eventType ?? s.eventType, role, s.number, s.issuedAt,
      s.providerDoc, s.providerName, s.takerDoc, s.takerName, s.serviceValue, s.netValue, s.issValue, s.issWithheld, s.municipality, xml, sha,
      meta.source, meta.layout, meta.fiscalXmlId],
  );
  return Boolean(ins.rowCount);
}

/** Leva as NFS-e de um XML recebido para nfse_document (idempotente pelo hash de cada nota). */
export async function bridgeNfseXml(
  tx: PoolClient, entity: { id: string; cnpj: string }, xml: string, source: "UPLOAD" | "PASTA", fiscalXmlId: string | null,
): Promise<BridgeResult> {
  const out: BridgeResult = { inserted: 0, duplicates: 0, roles: {} };
  const add = (role: string) => { out.inserted++; out.roles[role] = (out.roles[role] ?? 0) + 1; };
  if (isAbrasf(xml)) {
    for (const n of splitAbrasf(xml)) {
      const s = summarizeAbrasf(n.xml);
      if (!s) continue;
      const role = nfseRole(s, entity.cnpj);
      if (role === "OUTRA") continue;
      if (await sameNote(tx, entity.id, s)) out.duplicates++;
      else if (await insertNote(tx, entity.id, s, role, n.xml, n.sha256, { source, layout: "ABRASF", fiscalXmlId })) add(role);
      if (n.cancellationXml) {
        const ev: NfseSummary = { ...s, isEvent: true, serviceValue: null, netValue: null, issValue: null, eventType: "101101" };
        const sha = createHash("sha256").update(n.cancellationXml, "utf8").digest();
        if (await insertNote(tx, entity.id, ev, "EVENTO", n.cancellationXml, sha, { source, layout: "ABRASF", fiscalXmlId, eventType: "101101 cancelamento (ABRASF)" })) add("EVENTO");
      }
    }
    return out;
  }
  if (!/<(\w+:)?(NFSe|CompNFSe|evento|Evento|pedRegEvento)[\s>]/.test(xml)) return out;
  let s: NfseSummary;
  try {
    s = summarizeNfse(xml);
  } catch {
    return out;
  }
  const role = nfseRole(s, entity.cnpj);
  if (role === "OUTRA") return out;
  if (!s.isEvent && (await sameNote(tx, entity.id, s))) {
    out.duplicates++;
    return out;
  }
  if (await insertNote(tx, entity.id, s, role, xml, createHash("sha256").update(xml, "utf8").digest(), { source, layout: "NACIONAL", fiscalXmlId })) add(role);
  return out;
}

/** Avisa os agentes (tributos, conferência, Simples, contábil) que entraram NFS-e por arquivo. */
export async function announceNfseIntake(tx: PoolClient, entityId: string, r: BridgeResult, actor: Actor, source: string) {
  if (!r.inserted) return;
  const batch = newId();
  await appendEvent(tx, {
    type: "NFSE_BATCH_RECEIVED", schemaVersion: 1, producer: { kind: "agent", name: "docs", version: "1" },
    idempotencyKey: `nfse-xml:${entityId}:${batch}`, entityId,
    payload: { entity_id: entityId, documents: r.inserted, roles: r.roles, from_nsu: 0, to_nsu: 0 },
  });
  await audit(tx, { actor, action: "documents.nfse_from_xml", resourceType: "nfse_document", resourceId: batch, entityId, data: { ...r, source } });
}

/** XML de NFS-e já guardados (antes desta versão) que ainda não viraram nota. Idempotente. */
export async function bridgeStoredNfse(pool: Pool, tenantId: string, actor: Actor): Promise<Record<string, BridgeResult>> {
  return withTenant(pool, tenantId, async (tx) => {
    const { rows } = await tx.query<{ id: string; entity_id: string; cnpj: string; source: "UPLOAD" | "PASTA"; xml: string }>(
      `SELECT x.id, x.entity_id, e.cnpj, x.source, x.xml FROM fiscal_xml x JOIN entity e ON e.id = x.entity_id
        WHERE x.doc_type = 'NFSE' AND x.source IN ('UPLOAD', 'PASTA')
          AND NOT EXISTS (SELECT 1 FROM nfse_document d WHERE d.fiscal_xml_id = x.id)
        ORDER BY x.received_at`,
    );
    const per: Record<string, BridgeResult> = {};
    for (const x of rows) {
      const r = await bridgeNfseXml(tx, { id: x.entity_id, cnpj: x.cnpj }, x.xml, x.source, x.id);
      const acc = (per[x.entity_id] ??= { inserted: 0, duplicates: 0, roles: {} });
      acc.inserted += r.inserted;
      acc.duplicates += r.duplicates;
      for (const [k, v] of Object.entries(r.roles)) acc.roles[k] = (acc.roles[k] ?? 0) + v;
    }
    for (const [entityId, r] of Object.entries(per)) await announceNfseIntake(tx, entityId, r, actor, "reprocessamento");
    return per;
  });
}
