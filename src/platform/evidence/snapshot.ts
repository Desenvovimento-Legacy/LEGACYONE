import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { newId } from "../../shared/ids.js";

/** Serialização estável (chaves ordenadas) para o hash não depender da ordem dos campos. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

export function sha256Of(payload: unknown): Buffer {
  return createHash("sha256").update(stableStringify(payload)).digest();
}

/**
 * Guarda a resposta bruta de uma fonte externa como evidência. A mesma resposta
 * (mesmo hash) não é gravada duas vezes: devolve o registro existente.
 */
export async function storeExternalSnapshot(
  tx: PoolClient,
  p: { source: string; requestKey: string; payload: unknown; fetchedAt: Date; entityId?: string | null },
): Promise<{ id: string; sha256: string; created: boolean }> {
  const hash = sha256Of(p.payload);
  const id = newId();
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO external_snapshot (id, tenant_id, entity_id, source, request_key, fetched_at, sha256, payload)
     VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, source, sha256) DO NOTHING
     RETURNING id`,
    [id, p.entityId ?? null, p.source, p.requestKey, p.fetchedAt, hash, JSON.stringify(p.payload)],
  );
  if (ins.rows[0]) return { id: ins.rows[0].id, sha256: hash.toString("hex"), created: true };
  const existing = await tx.query<{ id: string }>(
    "SELECT id FROM external_snapshot WHERE tenant_id = current_tenant() AND source = $1 AND sha256 = $2",
    [p.source, hash],
  );
  return { id: existing.rows[0]!.id, sha256: hash.toString("hex"), created: false };
}
