import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { parsePgdasDeclarationText, pdfText } from "../../integrations/integra-contador/pgdas-pdf.js";
import { audit } from "../../platform/audit/audit.js";
import { consumeGrant, requestAuthorization } from "../../platform/authorization/authorization.js";
import { appendEvent } from "../../platform/events/outbox.js";
import { storeExternalSnapshot } from "../../platform/evidence/snapshot.js";
import { reserveBilledCalls } from "../../platform/metering/metering.js";
import type { Actor } from "../../shared/actor.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";
import { FEDERAL_AGENT, FederalAccessDeniedError, type FederalSyncDeps } from "./federal-sync.js";

/**
 * Receita declarada no PGDAS-D, lida do PDF oficial da última declaração de um
 * PA (1 consulta cobrada; traz o RPA do mês e os 12 meses anteriores).
 * O PDF fica guardado; `reparseDeclaration` relê sem nova consulta.
 */

const SERVICE_PGDAS = "PGDAS-D - a partir de 01/2018";

export interface DeclarationReadResult {
  competence: string;
  declarationNumber: string | null;
  regime: string | null;
  months: number;
  found: boolean;
  calls: number;
}

async function storeParsed(tx: PoolClient, entityId: string, competence: string, number: string | null, pdfId: string, pdf: Buffer) {
  const content = parsePgdasDeclarationText(await pdfText(pdf), competence);
  let months = 0;
  for (const m of content.months) {
    const ins = await tx.query(
      `INSERT INTO pgdas_declared_revenue (id, tenant_id, entity_id, competence, declared_in, declaration_number, pdf_id, source, regime,
                                           market_internal, market_external, total)
       VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (tenant_id, entity_id, competence, pdf_id) DO NOTHING`,
      [newId(), entityId, m.competence, competence, number, pdfId, m.source, content.regime, m.internal, m.external, m.total],
    );
    months += ins.rowCount ?? 0;
  }
  return { content, months };
}

/** Busca a última declaração do PA (consulta cobrada: autoriza, reserva no teto e só então chama). */
export async function fetchLastDeclaration(
  deps: FederalSyncDeps,
  tenantId: string,
  input: { entityId: string; competence: string },
  actor: Actor = FEDERAL_AGENT,
): Promise<DeclarationReadResult> {
  if (!/^\d{4}-\d{2}-01$/.test(input.competence)) throw new Error("Competência deve ser AAAA-MM-01");
  const period = input.competence.slice(0, 7).replace("-", "");
  const cnpj = await withTenant(deps.appPool, tenantId, async (tx) => {
    const r = await tx.query<{ cnpj: string }>("SELECT cnpj FROM entity WHERE id = $1", [input.entityId]);
    if (!r.rows[0]?.cnpj) throw new Error("Empresa sem CNPJ");
    const d = await requestAuthorization(tx, { action: "integra.read", entityId: input.entityId, service: SERVICE_PGDAS, scope: { period } }, actor);
    if (d.decision === "DENY") return { denied: d.reason, cnpj: r.rows[0].cnpj };
    await consumeGrant(tx, d.grantId, "integra.read");
    return { denied: null, cnpj: r.rows[0].cnpj };
  });
  if (cnpj.denied) throw new FederalAccessDeniedError(cnpj.denied);
  await reserveBilledCalls(
    deps.appPool,
    tenantId,
    deps.metering,
    [{ entityId: input.entityId, system: "PGDASD", service: "CONSULTIMADECREC14", requestRef: { period } }],
    actor,
    (deps.now ?? (() => new Date()))(),
  );
  const r = await deps.integra.lastPgdasDeclaration(cnpj.cnpj, period);
  return withTenant(deps.appPool, tenantId, async (tx) => {
    const snap = await storeExternalSnapshot(tx, {
      source: r.source,
      requestKey: `pgdasd:ultima-declaracao:${cnpj.cnpj}:pa:${period}`,
      payload: r.raw,
      fetchedAt: r.fetchedAt,
      entityId: input.entityId,
    });
    let months = 0;
    let regime: string | null = null;
    const store = async (kind: "DECLARACAO" | "RECIBO", pdf: Buffer | null) => {
      if (!pdf) return null;
      const sha = createHash("sha256").update(pdf).digest();
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO pgdas_declaration_pdf (id, tenant_id, entity_id, competence, declaration_number, kind, pdf, sha256, snapshot_id)
         VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, entity_id, sha256) DO NOTHING RETURNING id`,
        [newId(), input.entityId, input.competence, r.value.declarationNumber, kind, pdf, sha, snap.id],
      );
      return ins.rows[0]?.id ?? (await tx.query<{ id: string }>("SELECT id FROM pgdas_declaration_pdf WHERE sha256 = $1", [sha])).rows[0]!.id;
    };
    const pdfId = await store("DECLARACAO", r.value.declarationPdf);
    await store("RECIBO", r.value.receiptPdf);
    if (pdfId && r.value.declarationPdf) {
      const p = await storeParsed(tx, input.entityId, input.competence, r.value.declarationNumber, pdfId, r.value.declarationPdf);
      months = p.months;
      regime = p.content.regime;
    }
    await appendEvent(tx, {
      type: "PGDAS_DECLARATION_READ",
      schemaVersion: 1,
      producer: { kind: "agent", name: "search", version: "0.1.0" },
      idempotencyKey: `pgdas-declaracao:${input.entityId}:${period}:${snap.sha256}`,
      entityId: input.entityId,
      competence: input.competence,
      payload: { entity_id: input.entityId, competence: input.competence, declaration_number: r.value.declarationNumber, months, regime, found: Boolean(pdfId) },
    });
    await audit(tx, {
      actor,
      action: "federal.pgdas_declaration_read",
      resourceType: "pgdas_declaration_pdf",
      resourceId: pdfId,
      entityId: input.entityId,
      competence: input.competence,
      data: { declaration_number: r.value.declarationNumber, months, regime, snapshot_id: snap.id },
      evidenceRefs: [snap.id],
    });
    return { competence: input.competence, declarationNumber: r.value.declarationNumber, regime, months, found: Boolean(pdfId), calls: 1 };
  });
}

/** Relê os PDFs já guardados (ajuste do leitor sem nova consulta cobrada). */
export async function reparseDeclarations(tx: PoolClient, entityId: string) {
  const { rows } = await tx.query<{ id: string; competence: string; declaration_number: string | null; pdf: Buffer }>(
    "SELECT id, competence::text, declaration_number, pdf FROM pgdas_declaration_pdf WHERE entity_id = $1 AND kind = 'DECLARACAO'",
    [entityId],
  );
  let months = 0;
  for (const r of rows) months += (await storeParsed(tx, entityId, r.competence, r.declaration_number, r.id, r.pdf)).months;
  return { pdfs: rows.length, months };
}

export interface RevenueCheckRow {
  competence: string;
  declared: string | null;
  declaredIn: string | null;
  regime: string | null;
  nfsePrestadas: string;
  nfseCount: number;
  cancelled: number;
  difference: string | null;
  status: "OK" | "DIVERGENTE" | "SEM_DECLARACAO";
  /** ANTERIOR = antes da responsabilidade da Legacy (escritório anterior). */
  responsibility: "ANTERIOR" | "LEGACY" | null;
}

export const REVENUE_TOLERANCE = 1.0;

/**
 * Conferência da implantação: receita declarada × NFS-e prestadas (pela data
 * de emissão, horário de Brasília), sem as canceladas. Só leitura do banco.
 */
export async function revenueCrossCheck(tx: PoolClient, entityId: string): Promise<RevenueCheckRow[]> {
  const { rows } = await tx.query<{
    competence: string; declared: string | null; declared_in: string | null; regime: string | null;
    nfse: string; n: number; cancelled: number; start: string | null;
  }>(
    `WITH declared AS (
       SELECT DISTINCT ON (competence) competence, total, declared_in, regime
         FROM pgdas_declared_revenue WHERE entity_id = $1
        ORDER BY competence, declared_in DESC, created_at DESC
     ), cancelled AS (
       SELECT DISTINCT access_key FROM nfse_document
        WHERE entity_id = $1 AND role = 'EVENTO' AND access_key IS NOT NULL AND (event_type ILIKE '%101101%' OR event_type ILIKE '%105102%' OR event_type ILIKE '%cancel%')
     ), nfse AS (
       SELECT date_trunc('month', issued_at AT TIME ZONE 'America/Sao_Paulo')::date AS competence,
              sum(service_value) FILTER (WHERE access_key NOT IN (SELECT access_key FROM cancelled) OR access_key IS NULL) AS total,
              count(*) FILTER (WHERE access_key NOT IN (SELECT access_key FROM cancelled) OR access_key IS NULL)::int AS n,
              count(*) FILTER (WHERE access_key IN (SELECT access_key FROM cancelled))::int AS cancelled
         FROM nfse_document WHERE entity_id = $1 AND role = 'PRESTADA' AND issued_at IS NOT NULL
        GROUP BY 1
     )
     SELECT coalesce(d.competence, n.competence)::text AS competence, d.total::text AS declared, d.declared_in::text, d.regime,
            coalesce(n.total, 0)::text AS nfse, coalesce(n.n, 0) AS n, coalesce(n.cancelled, 0) AS cancelled,
            (SELECT min(valid_from)::text FROM contracted_service_history h WHERE h.entity_id = $1) AS start
       FROM declared d FULL JOIN nfse n ON n.competence = d.competence
      WHERE d.competence IS NOT NULL OR n.competence >= (SELECT min(competence) FROM declared)
      ORDER BY 1`,
    [entityId],
  );
  return rows.map((r) => {
    const diff = r.declared === null ? null : (Math.round(Number(r.nfse) * 100) - Math.round(Number(r.declared) * 100)) / 100;
    return {
      competence: r.competence,
      declared: r.declared,
      declaredIn: r.declared_in,
      regime: r.regime,
      nfsePrestadas: Number(r.nfse).toFixed(2),
      nfseCount: r.n,
      cancelled: r.cancelled,
      difference: diff === null ? null : diff.toFixed(2),
      status: r.declared === null ? "SEM_DECLARACAO" : Math.abs(diff!) <= REVENUE_TOLERANCE ? "OK" : "DIVERGENTE",
      responsibility: r.start ? (r.competence < r.start ? "ANTERIOR" : "LEGACY") : null,
    };
  });
}
