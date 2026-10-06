import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { LOTE_SIZE, type AdnLote, type NfseDistribution } from "../../integrations/nfse/adn.js";
import { nfseRole, summarizeNfse } from "../../integrations/nfse/nfse-parse.js";
import type { ClientCertificate } from "../../integrations/sefaz/dist-dfe.js";
import { audit } from "../../platform/audit/audit.js";
import { appendEvent, type Producer } from "../../platform/events/outbox.js";
import type { Actor } from "../../shared/actor.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";
import { DOCS_AGENT } from "./dfe-sync.js";

/**
 * Agente Documentos — NFS-e do Sistema Nacional (ADN).
 *  - segue o maior NSU recebido, lote a lote (até 50 por lote), com pausa entre chamadas;
 *  - lote incompleto ou "nenhum documento": próxima busca em 60 min;
 *  - 429: espera o tempo pedido pelo ADN; falha: 15 min.
 */

export const NFSE_IDLE_MINUTES = 60;
export const NFSE_ERROR_MINUTES = 15;
export const NFSE_PAUSE_MS = 2000;
const PRODUCER: Producer = { kind: "agent", name: "docs", version: "1" };

export interface NfseSyncDeps {
  appPool: Pool;
  adn: NfseDistribution;
  certificates: (cnpj: string) => ClientCertificate | null;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  maxCalls?: number;
}

export interface NfseCursor {
  nsu: number;
  nextAllowedAt: Date | null;
  lastStatus: string | null;
  lastMessage: string | null;
  lastQueryAt: Date | null;
}

export async function nfseCursor(tx: PoolClient, entityId: string): Promise<NfseCursor> {
  const d = await tx.query<{ n: string | null }>("SELECT max(nsu)::text AS n FROM nfse_document WHERE entity_id = $1", [entityId]);
  const q = await tx.query<{ max_nsu: string | null; next_allowed_at: Date; status: string; message: string | null; queried_at: Date }>(
    "SELECT max_nsu::text, next_allowed_at, status, message, queried_at FROM nfse_query WHERE entity_id = $1 ORDER BY queried_at DESC, id DESC LIMIT 1",
    [entityId],
  );
  const last = q.rows[0];
  const nsu = Math.max(Number(d.rows[0]?.n ?? 0), Number(last?.max_nsu ?? 0));
  return { nsu, nextAllowedAt: last?.next_allowed_at ?? null, lastStatus: last?.status ?? null, lastMessage: last?.message ?? null, lastQueryAt: last?.queried_at ?? null };
}

export interface NfseSyncResult {
  entityId: string;
  calls: number;
  documents: number;
  outcome: "ok" | "aguardando" | "sem_certificado" | "erro";
  status: string | null;
  message: string | null;
  nextAllowedAt: Date | null;
}

async function storeLote(tx: PoolClient, entityId: string, cnpj: string, requested: number, l: AdnLote, next: Date, now: Date, actor: Actor) {
  let inserted = 0;
  const roles: Record<string, number> = {};
  for (const d of l.docs) {
    const s = summarizeNfse(d.xml);
    const role = nfseRole(s, cnpj);
    const ins = await tx.query(
      `INSERT INTO nfse_document (id, tenant_id, entity_id, nsu, access_key, doc_type, event_type, role, number, issued_at, provider_doc, provider_name,
                                  taker_doc, taker_name, service_value, net_value, iss_value, iss_withheld, municipality, generated_at, xml, sha256)
       VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       ON CONFLICT (tenant_id, entity_id, nsu) DO NOTHING`,
      [newId(), entityId, d.nsu, d.accessKey ?? s.accessKey, d.docType, d.eventType ?? s.eventType, role, s.number, s.issuedAt, s.providerDoc,
        s.providerName, s.takerDoc, s.takerName, s.serviceValue, s.netValue, s.issValue, s.issWithheld, s.municipality, d.generatedAt, d.xml,
        createHash("sha256").update(d.xml, "utf8").digest()],
    );
    if (ins.rowCount) {
      inserted++;
      roles[role] = (roles[role] ?? 0) + 1;
    }
  }
  const max = l.docs.reduce((m, d) => Math.max(m, d.nsu), requested);
  const qid = newId();
  await tx.query(
    `INSERT INTO nfse_query (id, tenant_id, entity_id, requested_nsu, http_status, status, max_nsu, documents, next_allowed_at, actor_kind, actor_id, queried_at)
     VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [qid, entityId, requested, l.httpStatus, l.status, max, inserted, next, actor.kind, actor.id, now],
  );
  if (inserted) {
    await appendEvent(tx, {
      type: "NFSE_BATCH_RECEIVED",
      schemaVersion: 1,
      producer: PRODUCER,
      idempotencyKey: `nfse:${entityId}:${requested}:${max}`,
      entityId,
      payload: { entity_id: entityId, documents: inserted, roles, from_nsu: requested, to_nsu: max },
    });
  }
  await audit(tx, {
    actor,
    action: "documents.nfse_query",
    resourceType: "nfse_query",
    resourceId: qid,
    entityId,
    data: { requested_nsu: requested, http: l.httpStatus, status: l.status, max_nsu: max, documents: inserted },
  });
  return { inserted, max };
}

export async function syncEntityNfse(deps: NfseSyncDeps, tenantId: string, entityId: string, actor: Actor = DOCS_AGENT): Promise<NfseSyncResult> {
  const clock = () => (deps.now ? deps.now() : new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { cnpj, cursor } = await withTenant(deps.appPool, tenantId, async (tx) => {
    const e = await tx.query<{ cnpj: string }>("SELECT cnpj FROM entity WHERE id = $1", [entityId]);
    return { cnpj: e.rows[0]?.cnpj ?? null, cursor: await nfseCursor(tx, entityId) };
  });
  const base = { entityId, calls: 0, documents: 0, status: cursor.lastStatus, message: cursor.lastMessage };
  if (cursor.nextAllowedAt && cursor.nextAllowedAt > clock()) return { ...base, outcome: "aguardando", nextAllowedAt: cursor.nextAllowedAt };
  const certificate = cnpj ? deps.certificates(cnpj) : null;
  if (!cnpj || !certificate) return { ...base, outcome: "sem_certificado", nextAllowedAt: null };

  let nsu = cursor.nsu;
  let calls = 0;
  let documents = 0;
  let status: string | null = null;
  let next: Date | null = null;
  while (calls < (deps.maxCalls ?? 200)) {
    if (calls > 0) await sleep(NFSE_PAUSE_MS);
    const now = clock();
    let l: AdnLote;
    try {
      l = await deps.adn.lote({ cnpj, nsu, certificate });
    } catch (err) {
      const msg = (err as Error).message.slice(0, 300);
      const wait = new Date(now.getTime() + NFSE_ERROR_MINUTES * 60_000);
      await withTenant(deps.appPool, tenantId, (tx) =>
        tx.query(
          `INSERT INTO nfse_query (id, tenant_id, entity_id, requested_nsu, http_status, status, message, next_allowed_at, actor_kind, actor_id, queried_at)
           VALUES ($1, current_tenant(), $2, $3, $4, 'ERRO', $5, $6, $7, $8, $9)`,
          [newId(), entityId, nsu, (err as { httpStatus?: number }).httpStatus ?? null, msg, wait, actor.kind, actor.id, now],
        ),
      );
      return { entityId, calls: calls + 1, documents, outcome: "erro", status: "ERRO", message: msg, nextAllowedAt: wait };
    }
    calls++;
    status = l.status;
    const full = l.docs.length >= LOTE_SIZE || (l.status === "DOCUMENTOS_LOCALIZADOS" && l.docs.length > 0);
    const maxInLote = l.docs.reduce((m, d) => Math.max(m, d.nsu), nsu);
    const more = full && maxInLote > nsu;
    next =
      l.status === "LIMITE"
        ? new Date(now.getTime() + (l.retryAfter ?? 30) * 1000)
        : more
          ? now
          : new Date(now.getTime() + NFSE_IDLE_MINUTES * 60_000);
    const requested = nsu;
    const r = await withTenant(deps.appPool, tenantId, (tx) => storeLote(tx, entityId, cnpj, requested, l, next!, now, actor));
    documents += r.inserted;
    nsu = r.max;
    if (!more) break;
  }
  return { entityId, calls, documents, outcome: "ok", status, message: null, nextAllowedAt: next };
}

export async function syncAllNfse(deps: NfseSyncDeps, tenantId: string, actor: Actor = DOCS_AGENT): Promise<NfseSyncResult[]> {
  const ids = await withTenant(deps.appPool, tenantId, (tx) =>
    tx.query<{ id: string }>(
      `SELECT e.id FROM entity e
        WHERE EXISTS (SELECT 1 FROM digital_certificate d WHERE d.entity_id = e.id AND d.status = 'ACTIVE' AND d.valid_to > now())
        ORDER BY e.legal_name`,
    ),
  );
  const out: NfseSyncResult[] = [];
  for (const { id } of ids.rows) out.push(await syncEntityNfse(deps, tenantId, id, actor));
  return out;
}

export async function nfseStatus(tx: PoolClient) {
  const ents = await tx.query<{ id: string; prest: number; toma: number; total: number }>(
    `SELECT e.id,
            (SELECT count(*)::int FROM nfse_document n WHERE n.entity_id = e.id AND n.role = 'PRESTADA') AS prest,
            (SELECT count(*)::int FROM nfse_document n WHERE n.entity_id = e.id AND n.role = 'TOMADA') AS toma,
            (SELECT count(*)::int FROM nfse_document n WHERE n.entity_id = e.id) AS total
       FROM entity e WHERE e.cnpj IS NOT NULL`,
  );
  const out: Record<string, unknown> = {};
  for (const e of ents.rows) {
    const c = await nfseCursor(tx, e.id);
    out[e.id] = {
      prestadas: e.prest,
      tomadas: e.toma,
      documents: e.total,
      nsu: c.nsu,
      lastStatus: c.lastStatus,
      lastMessage: c.lastMessage,
      lastQueryAt: c.lastQueryAt ? c.lastQueryAt.toISOString() : null,
      nextAllowedAt: c.nextAllowedAt ? c.nextAllowedAt.toISOString() : null,
    };
  }
  return out;
}

export async function nfseList(tx: PoolClient, entityId: string | null, limit = 300) {
  const { rows } = await tx.query<{
    entity: string; nsu: string; role: string; number: string | null; issued_at: Date | null; provider_name: string | null; provider_doc: string | null;
    taker_name: string | null; taker_doc: string | null; service_value: string | null; iss_withheld: boolean | null; event_type: string | null; access_key: string | null;
  }>(
    `SELECT coalesce(e.trade_name, e.legal_name) AS entity, n.nsu::text, n.role, n.number, n.issued_at, n.provider_name, n.provider_doc,
            n.taker_name, n.taker_doc, n.service_value::text, n.iss_withheld, n.event_type, n.access_key
       FROM nfse_document n JOIN entity e ON e.id = n.entity_id
      WHERE ($1::uuid IS NULL OR n.entity_id = $1)
      ORDER BY coalesce(n.issued_at, n.received_at) DESC, n.nsu DESC LIMIT $2`,
    [entityId, limit],
  );
  return rows.map((r) => ({ ...r, issued_at: r.issued_at ? r.issued_at.toISOString() : null }));
}
