import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ClientCertificate, DfeDistribution, DistResult } from "../../integrations/sefaz/dist-dfe.js";
import { nsu15 } from "../../integrations/sefaz/dist-dfe.js";
import { summarizeDfe } from "../../integrations/sefaz/nfe-parse.js";
import { audit } from "../../platform/audit/audit.js";
import { appendEvent, type Producer } from "../../platform/events/outbox.js";
import type { Actor } from "../../shared/actor.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";

/**
 * Agente Documentos — busca de NF-e na SEFAZ (distribuição de DF-e).
 *
 * Regra de uso (NT 2014.002), aplicada antes de cada chamada:
 *  - consulta sempre a partir do último NSU recebido (cursor = última consulta);
 *  - enquanto ultNSU < maxNSU, segue no mesmo ciclo (até `maxCalls` chamadas);
 *  - sem documento novo (137) ou ultNSU = maxNSU: próxima só depois de 61 min;
 *  - 656 (consumo indevido) ou qualquer outra resposta: espera 61 min;
 *  - falha de rede: espera 15 min.
 * O XML original de cada documento é guardado com SHA-256 (evidência).
 */

export const WAIT_MINUTES = 61;
export const ERROR_WAIT_MINUTES = 15;
export const DOCS_AGENT: Actor = { kind: "AGENT", id: "docs" };
const PRODUCER: Producer = { kind: "agent", name: "docs", version: "1" };

export interface DfeSyncDeps {
  appPool: Pool;
  dist: DfeDistribution;
  /** Certificado do CNPJ, aberto do cofre só em memória; null se não houver. */
  certificates: (cnpj: string) => ClientCertificate | null;
  now?: () => Date;
  maxCalls?: number;
}

export interface DfeCursor {
  ultNsu: string;
  maxNsu: string | null;
  nextAllowedAt: Date | null;
  lastStatus: string | null;
  lastMessage: string | null;
  lastQueryAt: Date | null;
}

export async function dfeCursor(tx: PoolClient, entityId: string): Promise<DfeCursor> {
  const { rows } = await tx.query<{ requested_nsu: string; ult_nsu: string | null; max_nsu: string | null; next_allowed_at: Date; status_code: string; status_message: string; queried_at: Date }>(
    `SELECT requested_nsu, ult_nsu, max_nsu, next_allowed_at, status_code, status_message, queried_at
       FROM dfe_query WHERE entity_id = $1 ORDER BY queried_at DESC, id DESC LIMIT 1`,
    [entityId],
  );
  const q = rows[0];
  if (!q) return { ultNsu: nsu15(0), maxNsu: null, nextAllowedAt: null, lastStatus: null, lastMessage: null, lastQueryAt: null };
  // O cursor só anda com resposta válida (137/138) ou ajuste manual; o resto mantém o NSU pedido.
  const moved = (q.status_code === "137" || q.status_code === "138" || q.status_code === "AJUSTE") && q.ult_nsu;
  return {
    ultNsu: moved ? q.ult_nsu! : q.requested_nsu,
    maxNsu: q.max_nsu,
    nextAllowedAt: q.next_allowed_at,
    lastStatus: q.status_code,
    lastMessage: q.status_message,
    lastQueryAt: q.queried_at,
  };
}

export interface DfeSyncResult {
  entityId: string;
  calls: number;
  documents: number;
  /** "ok" · "aguardando" (regra de 1 h) · "sem_certificado" · "sem_uf" · "erro" */
  outcome: "ok" | "aguardando" | "sem_certificado" | "sem_uf" | "erro";
  statusCode: string | null;
  statusMessage: string | null;
  nextAllowedAt: Date | null;
}

function nextAllowed(r: DistResult, now: Date): Date {
  const more = r.statusCode === "138" && r.ultNsu && r.maxNsu && BigInt(r.ultNsu) < BigInt(r.maxNsu);
  return more ? now : new Date(now.getTime() + WAIT_MINUTES * 60_000);
}

async function store(tx: PoolClient, entityId: string, requested: string, r: DistResult, now: Date, actor: Actor): Promise<number> {
  let inserted = 0;
  const kinds: Record<string, number> = {};
  for (const d of r.docs) {
    const s = summarizeDfe(d.schema, d.xml);
    const ins = await tx.query(
      `INSERT INTO dfe_document (id, tenant_id, entity_id, nsu, kind, schema_name, access_key, issuer_doc, issuer_name, recipient_doc,
                                 issued_at, nf_type, total, situation, event_type, event_desc, xml, sha256)
       VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (tenant_id, entity_id, nsu) DO NOTHING`,
      [newId(), entityId, d.nsu, s.kind, d.schema, s.accessKey, s.issuerDoc, s.issuerName, s.recipientDoc, s.issuedAt, s.nfType,
        s.total, s.situation, s.eventType, s.eventDesc, d.xml, createHash("sha256").update(d.xml, "utf8").digest()],
    );
    if (ins.rowCount) {
      inserted++;
      kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
    }
  }
  const next = nextAllowed(r, now);
  const queryId = newId();
  await tx.query(
    `INSERT INTO dfe_query (id, tenant_id, entity_id, requested_nsu, status_code, status_message, ult_nsu, max_nsu, documents,
                            next_allowed_at, actor_kind, actor_id, queried_at)
     VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [queryId, entityId, requested, r.statusCode, r.statusMessage.slice(0, 500), r.ultNsu, r.maxNsu, inserted, next, actor.kind, actor.id, now],
  );
  if (inserted) {
    await appendEvent(tx, {
      type: "DFE_BATCH_RECEIVED",
      schemaVersion: 1,
      producer: PRODUCER,
      idempotencyKey: `dfe:${entityId}:${requested}:${r.ultNsu ?? ""}`,
      entityId,
      payload: { entity_id: entityId, documents: inserted, kinds, ult_nsu: r.ultNsu, max_nsu: r.maxNsu },
    });
  }
  await audit(tx, {
    actor,
    action: "documents.dfe_query",
    resourceType: "dfe_query",
    resourceId: queryId,
    entityId,
    data: { requested_nsu: requested, status: r.statusCode, message: r.statusMessage, ult_nsu: r.ultNsu, max_nsu: r.maxNsu, documents: inserted },
  });
  return inserted;
}

/** Busca as NF-e de uma empresa até zerar a fila da SEFAZ ou bater a regra de espera. */
export async function syncEntityDfe(deps: DfeSyncDeps, tenantId: string, entityId: string, actor: Actor = DOCS_AGENT): Promise<DfeSyncResult> {
  const clock = () => (deps.now ? deps.now() : new Date());
  const ent = await withTenant(deps.appPool, tenantId, async (tx) => {
    const e = await tx.query<{ cnpj: string; uf: string | null }>(
      `SELECT e.cnpj, (SELECT s.uf FROM establishment s WHERE s.entity_id = e.id AND s.kind = 'MATRIZ' LIMIT 1) AS uf
         FROM entity e WHERE e.id = $1`,
      [entityId],
    );
    return { row: e.rows[0], cursor: await dfeCursor(tx, entityId) };
  });
  const base = { entityId, calls: 0, documents: 0, statusCode: ent.cursor.lastStatus, statusMessage: ent.cursor.lastMessage };
  if (!ent.row?.cnpj || !ent.row.uf) return { ...base, outcome: "sem_uf", nextAllowedAt: null };
  if (ent.cursor.nextAllowedAt && ent.cursor.nextAllowedAt > clock()) return { ...base, outcome: "aguardando", nextAllowedAt: ent.cursor.nextAllowedAt };
  const certificate = deps.certificates(ent.row.cnpj);
  if (!certificate) return { ...base, outcome: "sem_certificado", nextAllowedAt: null };

  let ultNsu = ent.cursor.ultNsu;
  let calls = 0;
  let documents = 0;
  let last: DistResult | null = null;
  let nextAt: Date | null = null;
  while (calls < (deps.maxCalls ?? 20)) {
    const now = clock();
    let r: DistResult;
    try {
      r = await deps.dist.distNsu({ cnpj: ent.row.cnpj, uf: ent.row.uf, ultNsu, certificate });
    } catch (err) {
      const msg = (err as Error).message.slice(0, 300);
      const wait = new Date(now.getTime() + ERROR_WAIT_MINUTES * 60_000);
      await withTenant(deps.appPool, tenantId, (tx) =>
        tx.query(
          `INSERT INTO dfe_query (id, tenant_id, entity_id, requested_nsu, status_code, status_message, next_allowed_at, actor_kind, actor_id, queried_at)
           VALUES ($1, current_tenant(), $2, $3, 'ERRO', $4, $5, $6, $7, $8)`,
          [newId(), entityId, ultNsu, msg, wait, actor.kind, actor.id, now],
        ),
      );
      return { entityId, calls: calls + 1, documents, outcome: "erro", statusCode: "ERRO", statusMessage: msg, nextAllowedAt: wait };
    }
    calls++;
    const requested = ultNsu;
    documents += await withTenant(deps.appPool, tenantId, (tx) => store(tx, entityId, requested, r, now, actor));
    last = r;
    nextAt = nextAllowed(r, now);
    if ((r.statusCode === "137" || r.statusCode === "138") && r.ultNsu) ultNsu = r.ultNsu;
    if (nextAt > now) break;
  }
  return { entityId, calls, documents, outcome: "ok", statusCode: last?.statusCode ?? null, statusMessage: last?.statusMessage ?? null, nextAllowedAt: nextAt };
}

/**
 * 656 por sequência ("Deve ser utilizado o ultNSU"): outro sistema já consulta
 * este CNPJ com NSU mais adiantado. A busca automática para (insistir renova o
 * bloqueio de 1 h e atrapalha o outro sistema) até uma pessoa informar o NSU
 * inicial ou pedir nova tentativa.
 */
export function blockedBySequence(c: Pick<DfeCursor, "lastStatus" | "lastMessage">): boolean {
  return c.lastStatus === "656" && /ultNSU/i.test(c.lastMessage ?? "");
}

/** Ajuste humano do ponto de partida (NSU do outro sistema). Não consulta a SEFAZ. */
export async function setStartingNsu(pool: Pool, tenantId: string, entityId: string, nsu: string, actor: Actor, now = new Date()) {
  if (actor.kind !== "USER") throw new Error("Só uma pessoa ajusta o NSU inicial");
  if (!/^\d{1,15}$/.test(nsu.trim())) throw new Error("NSU deve ter só números (até 15 dígitos)");
  const value = nsu15(nsu.trim());
  return withTenant(pool, tenantId, async (tx) => {
    const c = await dfeCursor(tx, entityId);
    // Mantém a espera em curso: o ajuste não libera consulta antes da hora.
    const next = c.nextAllowedAt && c.nextAllowedAt > now ? c.nextAllowedAt : now;
    const id = newId();
    await tx.query(
      `INSERT INTO dfe_query (id, tenant_id, entity_id, requested_nsu, status_code, status_message, ult_nsu, max_nsu, next_allowed_at, actor_kind, actor_id, queried_at)
       VALUES ($1, current_tenant(), $2, $3, 'AJUSTE', $4, $3, $5, $6, $7, $8, $9)`,
      [id, entityId, value, `NSU inicial informado por ${actor.id} (antes ${c.ultNsu})`, c.maxNsu, next, actor.kind, actor.id, now],
    );
    await audit(tx, { actor, action: "documents.dfe_nsu_set", resourceType: "dfe_query", resourceId: id, entityId, data: { from: c.ultNsu, to: value } });
    return { ultNsu: value, nextAllowedAt: next };
  });
}

/** Todas as empresas com certificado; respeita a espera de cada uma e para em 656 de sequência. */
export async function syncAllDfe(deps: DfeSyncDeps, tenantId: string, actor: Actor = DOCS_AGENT): Promise<DfeSyncResult[]> {
  const ids = await withTenant(deps.appPool, tenantId, (tx) =>
    tx.query<{ id: string }>(
      `SELECT e.id FROM entity e
        WHERE EXISTS (SELECT 1 FROM digital_certificate d WHERE d.entity_id = e.id AND d.status = 'ACTIVE' AND d.valid_to > now())
        ORDER BY e.legal_name`,
    ),
  );
  const out: DfeSyncResult[] = [];
  for (const { id } of ids.rows) {
    const c = await withTenant(deps.appPool, tenantId, (tx) => dfeCursor(tx, id));
    if (blockedBySequence(c)) continue;
    out.push(await syncEntityDfe(deps, tenantId, id, actor));
  }
  return out;
}
