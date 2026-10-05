import type { Pool, PoolClient } from "pg";
import type { Actor } from "../../shared/actor.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";
import { audit } from "../../platform/audit/audit.js";
import { consumeGrant, requestAuthorization } from "../../platform/authorization/authorization.js";
import { appendEvent } from "../../platform/events/outbox.js";
import { storeExternalSnapshot } from "../../platform/evidence/snapshot.js";
import type { IntegraContador } from "../../integrations/integra-contador/types.js";

/**
 * One Search (dados federais): traz do Integra Contador o histórico do Simples
 * (declarações PGDAS-D e DAS) e os pagamentos federais (PagtoWeb).
 *
 * Quem inicia: implantação do cliente ou rotina periódica.
 * Autorização: cada consulta pede ao Authorization Service uma autorização de
 * uso único, que só sai com procuração e-CAC vigente para o serviço.
 * Evidência: a resposta bruta de cada consulta vai para external_snapshot;
 * cada linha gravada aponta para ela.
 * Reexecução é segura: números de declaração, DAS e documento são únicos; a
 * situação "pago" do DAS só ganha nova observação quando muda.
 * Nada aqui calcula tributo: são fatos lidos da Receita.
 */

export const FEDERAL_AGENT: Actor = { kind: "AGENT", id: "one-search" };
const PRODUCER = { kind: "agent", name: "one-search", version: "0.1.0" } as const;

/** Nomes dos serviços no cadastro de procuração do e-CAC. */
const SERVICE_PGDAS = "PGDAS-D - a partir de 01/2018";
const SERVICE_PAYMENTS = "Pagamentos - Comprovante de Arrecadação";
const PAGE_SIZE = 100;

export interface FederalSyncDeps {
  appPool: Pool;
  integra: IntegraContador;
  now?: () => Date;
}

export interface FederalSyncResult {
  entityId: string;
  cnpj: string;
  years: { year: number; declarations: number; das: number; newDeclarations: number; newDas: number }[];
  payments: { from: string; to: string; total: number; created: number; calls: number };
  calls: number;
}

export class FederalAccessDeniedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "FederalAccessDeniedError";
  }
}

function todayBr(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(now);
}

/**
 * Pede a autorização e a consome numa transação própria: a decisão (inclusive
 * DENY) fica auditada mesmo quando a sincronização é interrompida.
 */
async function authorize(
  pool: Pool,
  tenantId: string,
  entityId: string,
  service: string,
  actor: Actor,
  scope: Record<string, unknown>,
): Promise<void> {
  const denied = await withTenant(pool, tenantId, async (tx) => {
    const d = await requestAuthorization(tx, { action: "integra.read", entityId, service, scope }, actor);
    if (d.decision === "DENY") return d.reason;
    await consumeGrant(tx, d.grantId, "integra.read");
    return null;
  });
  if (denied) throw new FederalAccessDeniedError(denied);
}

export async function syncFederalData(
  deps: FederalSyncDeps,
  tenantId: string,
  input: { entityId: string; fromYear?: number; caseId?: string | null },
  actor: Actor = FEDERAL_AGENT,
): Promise<FederalSyncResult> {
  const now = deps.now ?? (() => new Date());
  const today = todayBr(now());
  const currentYear = Number(today.slice(0, 4));

  const entity = await withTenant(deps.appPool, tenantId, async (tx) => {
    const { rows } = await tx.query<{ cnpj: string; activity_started_at: string | null }>(
      "SELECT cnpj, activity_started_at FROM entity WHERE id = $1",
      [input.entityId],
    );
    if (!rows[0]?.cnpj) throw new Error("Entidade sem CNPJ ou inexistente neste escritório");
    return rows[0];
  });
  const cnpj = entity.cnpj;
  // Padrão: 5 anos (prazo decadencial), sem começar antes do início de atividade.
  const startedYear = entity.activity_started_at ? Number(entity.activity_started_at.slice(0, 4)) : 0;
  const fromYear = Math.max(input.fromYear ?? currentYear - 5, startedYear);
  const result: FederalSyncResult = {
    entityId: input.entityId,
    cnpj,
    years: [],
    payments: { from: `${fromYear}-01-01`, to: today, total: 0, created: 0, calls: 0 },
    calls: 0,
  };
  const correlationId = input.caseId ?? input.entityId;

  // ---------------------------------------------------------------- PGDAS-D
  for (let year = fromYear; year <= currentYear; year++) {
    await authorize(deps.appPool, tenantId, input.entityId, SERVICE_PGDAS, actor, { year });
    const r = await deps.integra.listPgdasDeclarations(cnpj, year);
    result.calls++;
    const y = await withTenant(deps.appPool, tenantId, async (tx) => {
      const snap = await storeExternalSnapshot(tx, {
        source: r.source,
        requestKey: `pgdasd:declaracoes:${cnpj}:${year}`,
        payload: r.raw,
        fetchedAt: r.fetchedAt,
        entityId: input.entityId,
      });
      let newDeclarations = 0;
      for (const d of r.value.declarations) {
        const ins = await tx.query(
          `INSERT INTO pgdas_declaration (id, tenant_id, entity_id, competence, declaration_number, operation,
                                          transmitted_at, malha, source, snapshot_id)
           VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (tenant_id, declaration_number) DO NOTHING`,
          [newId(), input.entityId, d.competence, d.number, d.operation, d.transmittedAt, d.malha, r.source, snap.id],
        );
        newDeclarations += ins.rowCount ?? 0;
      }
      let newDas = 0;
      for (const d of r.value.das) {
        const ins = await tx.query<{ id: string }>(
          `INSERT INTO pgdas_das (id, tenant_id, entity_id, competence, das_number, operation, issued_at, source, snapshot_id)
           VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (tenant_id, das_number) DO NOTHING
           RETURNING id`,
          [newId(), input.entityId, d.competence, d.number, d.operation, d.issuedAt, r.source, snap.id],
        );
        newDas += ins.rowCount ?? 0;
        if (d.paid === null) continue;
        const das = ins.rows[0]?.id ?? (await tx.query<{ id: string }>("SELECT id FROM pgdas_das WHERE das_number = $1", [d.number])).rows[0]!.id;
        const last = await tx.query<{ paid: boolean }>(
          "SELECT paid FROM pgdas_das_status WHERE das_id = $1 ORDER BY observed_at DESC, created_at DESC LIMIT 1",
          [das],
        );
        if (last.rows[0]?.paid !== d.paid) {
          await tx.query(
            `INSERT INTO pgdas_das_status (id, tenant_id, das_id, paid, observed_at, snapshot_id)
             VALUES ($1, current_tenant(), $2, $3, $4, $5)`,
            [newId(), das, d.paid, r.fetchedAt, snap.id],
          );
        }
      }
      if (newDeclarations || newDas || snap.created) {
        await appendEvent(tx, {
          type: "PGDAS_INDEX_SYNCED",
          schemaVersion: 1,
          producer: PRODUCER,
          idempotencyKey: `entity:${input.entityId}:pgdas:${year}:${snap.sha256}`,
          entityId: input.entityId,
          caseId: input.caseId ?? null,
          correlationId,
          evidenceRefs: [snap.id],
          payload: {
            entity_id: input.entityId,
            year,
            declarations: r.value.declarations.length,
            das: r.value.das.length,
            new_declarations: newDeclarations,
            new_das: newDas,
            source: r.source,
          },
        });
      }
      await audit(tx, {
        actor,
        action: "federal.pgdas_synced",
        resourceType: "entity",
        resourceId: input.entityId,
        entityId: input.entityId,
        caseId: input.caseId ?? null,
        evidenceRefs: [snap.id],
        data: { year, declarations: r.value.declarations.length, das: r.value.das.length, newDeclarations, newDas },
      });
      return { year, declarations: r.value.declarations.length, das: r.value.das.length, newDeclarations, newDas };
    });
    result.years.push(y);
  }

  // ---------------------------------------------------------------- Pagamentos (um ano por consulta)
  for (let year = fromYear; year <= currentYear; year++) {
    const from = `${year}-01-01`;
    const to = year === currentYear ? today : `${year}-12-31`;
    for (let first = 0; ; first += PAGE_SIZE) {
      await authorize(deps.appPool, tenantId, input.entityId, SERVICE_PAYMENTS, actor, { from, to, first });
      const r = await deps.integra.listPayments(cnpj, { from, to, first, size: PAGE_SIZE });
      result.calls++;
      result.payments.calls++;
      const page = r.value.payments;
      await withTenant(deps.appPool, tenantId, async (tx) => {
        const snap = await storeExternalSnapshot(tx, {
          source: r.source,
          requestKey: `pagtoweb:pagamentos:${cnpj}:${from}:${to}:${first}`,
          payload: r.raw,
          fetchedAt: r.fetchedAt,
          entityId: input.entityId,
        });
        let created = 0;
        for (const p of page) {
          const ins = await tx.query(
            `INSERT INTO federal_payment (id, tenant_id, entity_id, document_number, document_type_code, document_type,
                                          competence, collected_on, due_on, revenue_code, revenue_description,
                                          amount_total, amount_principal, amount_fine, amount_interest, breakdown,
                                          source, snapshot_id)
             VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
             ON CONFLICT (tenant_id, entity_id, document_number) DO NOTHING`,
            [
              newId(),
              input.entityId,
              p.documentNumber,
              p.documentTypeCode,
              p.documentType,
              p.competence,
              p.collectedOn,
              p.dueOn,
              p.revenueCode,
              p.revenueDescription,
              p.total,
              p.principal,
              p.fine,
              p.interest,
              JSON.stringify(p.breakdown),
              r.source,
              snap.id,
            ],
          );
          created += ins.rowCount ?? 0;
        }
        result.payments.total += page.length;
        result.payments.created += created;
        if (created || snap.created) {
          await appendEvent(tx, {
            type: "FEDERAL_PAYMENTS_SYNCED",
            schemaVersion: 1,
            producer: PRODUCER,
            idempotencyKey: `entity:${input.entityId}:pagtoweb:${from}:${to}:${first}:${snap.sha256}`,
            entityId: input.entityId,
            caseId: input.caseId ?? null,
            correlationId,
            evidenceRefs: [snap.id],
            payload: { entity_id: input.entityId, from, to, payments: page.length, new_payments: created, source: r.source },
          });
        }
        await audit(tx, {
          actor,
          action: "federal.payments_synced",
          resourceType: "entity",
          resourceId: input.entityId,
          entityId: input.entityId,
          caseId: input.caseId ?? null,
          evidenceRefs: [snap.id],
          data: { from, to, first, payments: page.length, created },
        });
      });
      if (page.length < PAGE_SIZE) break;
    }
  }
  return result;
}

/** Resumo por competência: declaração, DAS e pagamento do DAS encontrado no PagtoWeb. */
export interface CompetenceSummary {
  competence: string;
  declarations: number;
  rectifications: number;
  lastTransmittedAt: string | null;
  malha: string | null;
  das: number;
  dasPaidFlag: boolean | null;
  dasPayments: number;
  dasPaidAmount: string | null;
  dasPaidOn: string | null;
}

export async function competenceSummary(tx: PoolClient, entityId: string, from: string): Promise<CompetenceSummary[]> {
  const { rows } = await tx.query<{
    competence: string;
    declarations: number;
    rectifications: number;
    last_transmitted_at: Date | null;
    malha: string | null;
    das: number;
    das_paid_flag: boolean | null;
    das_payments: number;
    das_paid_amount: string | null;
    das_paid_on: string | null;
  }>(
    `WITH comps AS (
       SELECT competence FROM pgdas_declaration WHERE entity_id = $1 AND competence >= $2
       UNION SELECT competence FROM pgdas_das WHERE entity_id = $1 AND competence >= $2
       UNION SELECT competence FROM federal_payment
              WHERE entity_id = $1 AND competence >= $2 AND (document_type_code = '9' OR document_type ILIKE '%SIMPLES NACIONAL%')
     )
     SELECT c.competence::text,
            (SELECT count(*)::int FROM pgdas_declaration d WHERE d.entity_id = $1 AND d.competence = c.competence) AS declarations,
            (SELECT count(*)::int FROM pgdas_declaration d WHERE d.entity_id = $1 AND d.competence = c.competence
                AND d.operation = 'RETIFICADORA') AS rectifications,
            (SELECT max(transmitted_at) FROM pgdas_declaration d WHERE d.entity_id = $1 AND d.competence = c.competence)
              AS last_transmitted_at,
            (SELECT d.malha FROM pgdas_declaration d WHERE d.entity_id = $1 AND d.competence = c.competence
              ORDER BY d.transmitted_at DESC NULLS LAST LIMIT 1) AS malha,
            (SELECT count(*)::int FROM pgdas_das s WHERE s.entity_id = $1 AND s.competence = c.competence) AS das,
            (SELECT bool_or(st.paid) FROM pgdas_das s
               JOIN LATERAL (SELECT paid FROM pgdas_das_status x WHERE x.das_id = s.id
                             ORDER BY observed_at DESC, created_at DESC LIMIT 1) st ON true
              WHERE s.entity_id = $1 AND s.competence = c.competence) AS das_paid_flag,
            (SELECT count(*)::int FROM federal_payment p WHERE p.entity_id = $1 AND p.competence = c.competence
                AND (p.document_type_code = '9' OR p.document_type ILIKE '%SIMPLES NACIONAL%')) AS das_payments,
            (SELECT sum(amount_total)::text FROM federal_payment p WHERE p.entity_id = $1 AND p.competence = c.competence
                AND (p.document_type_code = '9' OR p.document_type ILIKE '%SIMPLES NACIONAL%')) AS das_paid_amount,
            (SELECT max(collected_on)::text FROM federal_payment p WHERE p.entity_id = $1 AND p.competence = c.competence
                AND (p.document_type_code = '9' OR p.document_type ILIKE '%SIMPLES NACIONAL%')) AS das_paid_on
       FROM comps c
      ORDER BY c.competence`,
    [entityId, from],
  );
  return rows.map((r) => ({
    competence: r.competence,
    declarations: r.declarations,
    rectifications: r.rectifications,
    lastTransmittedAt: r.last_transmitted_at ? r.last_transmitted_at.toISOString() : null,
    malha: r.malha,
    das: r.das,
    dasPaidFlag: r.das_paid_flag,
    dasPayments: r.das_payments,
    dasPaidAmount: r.das_paid_amount,
    dasPaidOn: r.das_paid_on,
  }));
}
