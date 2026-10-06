import type { Pool, PoolClient } from "pg";
import type { Actor } from "../../shared/actor.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";
import { audit } from "../../platform/audit/audit.js";
import { consumeGrant, requestAuthorization } from "../../platform/authorization/authorization.js";
import { appendEvent } from "../../platform/events/outbox.js";
import { storeExternalSnapshot } from "../../platform/evidence/snapshot.js";
import { reserveBilledCalls, type MeteringPolicy } from "../../platform/metering/metering.js";
import type { IntegraContador, IntegraContadorResult, PgdasYearIndex } from "../../integrations/integra-contador/types.js";

/**
 * Agente de busca (search) (dados federais): traz do Integra Contador as declarações PGDAS-D,
 * os DAS e os pagamentos federais (PagtoWeb).
 *
 * Dois modos:
 *  - carga histórica (implantação do cliente, uma vez): `syncFederalHistory`;
 *  - busca da competência (rotina mensal, disparada pelo botão Buscar):
 *    `syncCompetence`, exatamente 2 consultas cobradas por empresa.
 * Nada consulta o SERPRO sozinho: abrir tela ou relatório só lê o banco.
 *
 * Cada consulta: autorização de uso único (procuração e-CAC vigente para o
 * serviço) → reserva no medidor (teto diário do escritório) → chamada →
 * evidência bruta em external_snapshot → linhas que apontam para ela.
 * Reexecução não duplica. Nada aqui calcula tributo: são fatos lidos da Receita.
 */

export const FEDERAL_AGENT: Actor = { kind: "AGENT", id: "search" };
const PRODUCER = { kind: "agent", name: "search", version: "0.1.0" } as const;

/** Nomes dos serviços no cadastro de procuração do e-CAC. */
const SERVICE_PGDAS = "PGDAS-D - a partir de 01/2018";
const SERVICE_PAYMENTS = "Pagamentos - Comprovante de Arrecadação";
const PAGE_SIZE = 100;

export interface FederalSyncDeps {
  appPool: Pool;
  integra: IntegraContador;
  /** Teto de consultas cobradas por dia no escritório. */
  metering: MeteringPolicy;
  now?: () => Date;
}

export interface PgdasSyncCount {
  year: number;
  competence: string | null;
  declarations: number;
  das: number;
  newDeclarations: number;
  newDas: number;
}

export interface PaymentsSyncCount {
  from: string;
  to: string;
  total: number;
  created: number;
  calls: number;
}

export interface FederalSyncResult {
  entityId: string;
  cnpj: string;
  years: PgdasSyncCount[];
  payments: PaymentsSyncCount;
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

function lastDayOfMonth(isoFirstDay: string): string {
  const [y, m] = isoFirstDay.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function addMonths(isoFirstDay: string, n: number): string {
  const [y, m] = isoFirstDay.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 10);
}

interface Ctx {
  deps: FederalSyncDeps;
  tenantId: string;
  entityId: string;
  cnpj: string;
  caseId: string | null;
  actor: Actor;
}

/** Autorização de uso único; o DENY fica auditado mesmo se a busca parar. */
async function authorizeOnly(c: Ctx, service: string, scope: Record<string, unknown>) {
  const denied = await withTenant(c.deps.appPool, c.tenantId, async (tx) => {
    const d = await requestAuthorization(tx, { action: "integra.read", entityId: c.entityId, service, scope }, c.actor);
    if (d.decision === "DENY") return d.reason;
    await consumeGrant(tx, d.grantId, "integra.read");
    return null;
  });
  if (denied) throw new FederalAccessDeniedError(denied);
}

/** Reserva no medidor: ou todas as chamadas cabem no teto do dia, ou nenhuma sai. */
async function reserve(c: Ctx, calls: { system: string; service: string; scope: Record<string, unknown> }[]) {
  await reserveBilledCalls(
    c.deps.appPool,
    c.tenantId,
    c.deps.metering,
    calls.map((x) => ({ entityId: c.entityId, system: x.system, service: x.service, requestRef: x.scope })),
    c.actor,
    (c.deps.now ?? (() => new Date()))(),
  );
}

/** Autoriza e reserva uma chamada. Só depois disso a consulta pode sair. */
async function authorizeAndReserve(
  c: Ctx,
  system: "PGDASD" | "PAGTOWEB",
  service: string,
  scope: Record<string, unknown>,
) {
  await authorizeOnly(c, system === "PGDASD" ? SERVICE_PGDAS : SERVICE_PAYMENTS, scope);
  await reserve(c, [{ system, service, scope }]);
}

async function loadEntity(deps: FederalSyncDeps, tenantId: string, entityId: string) {
  return withTenant(deps.appPool, tenantId, async (tx) => {
    const { rows } = await tx.query<{ cnpj: string; activity_started_at: string | null }>(
      "SELECT cnpj, activity_started_at FROM entity WHERE id = $1",
      [entityId],
    );
    if (!rows[0]?.cnpj) throw new Error("Entidade sem CNPJ ou inexistente neste escritório");
    return rows[0];
  });
}

/** Grava o índice do PGDAS-D (ano ou competência) com evidência. */
async function storePgdas(
  c: Ctx,
  r: IntegraContadorResult<PgdasYearIndex>,
  requestKey: string,
  label: { year: number; competence: string | null },
): Promise<PgdasSyncCount> {
  return withTenant(c.deps.appPool, c.tenantId, async (tx) => {
    const snap = await storeExternalSnapshot(tx, {
      source: r.source,
      requestKey,
      payload: r.raw,
      fetchedAt: r.fetchedAt,
      entityId: c.entityId,
    });
    let newDeclarations = 0;
    for (const d of r.value.declarations) {
      const ins = await tx.query(
        `INSERT INTO pgdas_declaration (id, tenant_id, entity_id, competence, declaration_number, operation,
                                        transmitted_at, malha, source, snapshot_id)
         VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (tenant_id, declaration_number) DO NOTHING`,
        [newId(), c.entityId, d.competence, d.number, d.operation, d.transmittedAt, d.malha, r.source, snap.id],
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
        [newId(), c.entityId, d.competence, d.number, d.operation, d.issuedAt, r.source, snap.id],
      );
      newDas += ins.rowCount ?? 0;
      if (d.paid === null) continue;
      const das =
        ins.rows[0]?.id ?? (await tx.query<{ id: string }>("SELECT id FROM pgdas_das WHERE das_number = $1", [d.number])).rows[0]!.id;
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
    const count: PgdasSyncCount = {
      year: label.year,
      competence: label.competence,
      declarations: r.value.declarations.length,
      das: r.value.das.length,
      newDeclarations,
      newDas,
    };
    if (newDeclarations || newDas || snap.created) {
      await appendEvent(tx, {
        type: "PGDAS_INDEX_SYNCED",
        schemaVersion: 1,
        producer: PRODUCER,
        idempotencyKey: `entity:${c.entityId}:${requestKey}:${snap.sha256}`,
        entityId: c.entityId,
        caseId: c.caseId,
        correlationId: c.caseId ?? c.entityId,
        evidenceRefs: [snap.id],
        payload: {
          entity_id: c.entityId,
          year: label.year,
          competence: label.competence,
          declarations: count.declarations,
          das: count.das,
          new_declarations: newDeclarations,
          new_das: newDas,
          source: r.source,
        },
      });
    }
    await audit(tx, {
      actor: c.actor,
      action: "federal.pgdas_synced",
      resourceType: "entity",
      resourceId: c.entityId,
      entityId: c.entityId,
      competence: label.competence,
      caseId: c.caseId,
      evidenceRefs: [snap.id],
      data: { ...count },
    });
    return count;
  });
}

/** Pagamentos por data de arrecadação no intervalo, paginado (1 consulta por página). */
async function syncPayments(c: Ctx, from: string, to: string, firstPageReserved = false): Promise<PaymentsSyncCount> {
  const out: PaymentsSyncCount = { from, to, total: 0, created: 0, calls: 0 };
  for (let first = 0; ; first += PAGE_SIZE) {
    if (!(first === 0 && firstPageReserved)) await authorizeAndReserve(c, "PAGTOWEB", "PAGAMENTOS71", { from, to, first });
    const r = await c.deps.integra.listPayments(c.cnpj, { from, to, first, size: PAGE_SIZE });
    out.calls++;
    const page = r.value.payments;
    await withTenant(c.deps.appPool, c.tenantId, async (tx) => {
      const requestKey = `pagtoweb:pagamentos:${c.cnpj}:${from}:${to}:${first}`;
      const snap = await storeExternalSnapshot(tx, {
        source: r.source,
        requestKey,
        payload: r.raw,
        fetchedAt: r.fetchedAt,
        entityId: c.entityId,
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
            c.entityId,
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
      out.total += page.length;
      out.created += created;
      if (created || snap.created) {
        await appendEvent(tx, {
          type: "FEDERAL_PAYMENTS_SYNCED",
          schemaVersion: 1,
          producer: PRODUCER,
          idempotencyKey: `entity:${c.entityId}:${requestKey}:${snap.sha256}`,
          entityId: c.entityId,
          caseId: c.caseId,
          correlationId: c.caseId ?? c.entityId,
          evidenceRefs: [snap.id],
          payload: { entity_id: c.entityId, from, to, payments: page.length, new_payments: created, source: r.source },
        });
      }
      await audit(tx, {
        actor: c.actor,
        action: "federal.payments_synced",
        resourceType: "entity",
        resourceId: c.entityId,
        entityId: c.entityId,
        caseId: c.caseId,
        evidenceRefs: [snap.id],
        data: { from, to, first, payments: page.length, created },
      });
    });
    if (page.length < PAGE_SIZE) break;
  }
  return out;
}

/** Anos cobertos pela carga histórica: 5 anos, sem começar antes do início de atividade. */
export function historyYears(activityStartedAt: string | null, today: string, fromYear?: number): number[] {
  const currentYear = Number(today.slice(0, 4));
  const startedYear = activityStartedAt ? Number(activityStartedAt.slice(0, 4)) : 0;
  const first = Math.max(fromYear ?? currentYear - 5, startedYear);
  return Array.from({ length: currentYear - first + 1 }, (_, i) => first + i);
}

/** Consultas cobradas mínimas da carga histórica (páginas extras de pagamentos somam 1 cada). */
export async function estimateHistoryCalls(
  deps: Pick<FederalSyncDeps, "appPool" | "now">,
  tenantId: string,
  entityId: string,
  fromYear?: number,
): Promise<{ years: number[]; calls: number }> {
  const e = await loadEntity(deps as FederalSyncDeps, tenantId, entityId);
  const years = historyYears(e.activity_started_at, todayBr((deps.now ?? (() => new Date()))()), fromYear);
  return { years, calls: years.length * 2 };
}

/** Carga histórica (implantação). Use uma vez por cliente. */
export async function syncFederalHistory(
  deps: FederalSyncDeps,
  tenantId: string,
  input: { entityId: string; fromYear?: number; caseId?: string | null },
  actor: Actor = FEDERAL_AGENT,
): Promise<FederalSyncResult> {
  const today = todayBr((deps.now ?? (() => new Date()))());
  const e = await loadEntity(deps, tenantId, input.entityId);
  const c: Ctx = { deps, tenantId, entityId: input.entityId, cnpj: e.cnpj, caseId: input.caseId ?? null, actor };
  const years = historyYears(e.activity_started_at, today, input.fromYear);
  const result: FederalSyncResult = {
    entityId: input.entityId,
    cnpj: e.cnpj,
    years: [],
    payments: { from: `${years[0]}-01-01`, to: today, total: 0, created: 0, calls: 0 },
    calls: 0,
  };
  for (const year of years) {
    await authorizeAndReserve(c, "PGDASD", "CONSDECLARACAO13", { year });
    const r = await deps.integra.listPgdasDeclarations(e.cnpj, year);
    result.calls++;
    result.years.push(await storePgdas(c, r, `pgdasd:declaracoes:${e.cnpj}:${year}`, { year, competence: null }));
  }
  for (const year of years) {
    const p = await syncPayments(c, `${year}-01-01`, year === Number(today.slice(0, 4)) ? today : `${year}-12-31`);
    result.calls += p.calls;
    result.payments.total += p.total;
    result.payments.created += p.created;
    result.payments.calls += p.calls;
  }
  return result;
}

/** Compatibilidade com o nome anterior. */
export const syncFederalData = syncFederalHistory;

export interface CompetenceSyncResult {
  entityId: string;
  cnpj: string;
  competence: string;
  pgdas: PgdasSyncCount;
  payments: PaymentsSyncCount;
  calls: number;
}

/** Consultas cobradas da busca de uma competência. */
export const COMPETENCE_CALLS = 2;

/**
 * Busca da competência (botão Buscar): PGDAS-D do período de apuração e
 * pagamentos arrecadados do mês da competência até o fim do mês seguinte
 * (onde caem o DAS e o DARF da DCTFWeb no prazo), limitado a hoje.
 * Exatamente 2 consultas cobradas, salvo página extra de pagamentos (>100).
 */
export async function syncCompetence(
  deps: FederalSyncDeps,
  tenantId: string,
  input: { entityId: string; competence: string; caseId?: string | null },
  actor: Actor = FEDERAL_AGENT,
): Promise<CompetenceSyncResult> {
  if (!/^\d{4}-\d{2}-01$/.test(input.competence)) throw new Error("Competência deve ser AAAA-MM-01");
  const today = todayBr((deps.now ?? (() => new Date()))());
  if (input.competence > today) throw new Error("Competência futura não pode ser buscada");
  const e = await loadEntity(deps, tenantId, input.entityId);
  const c: Ctx = { deps, tenantId, entityId: input.entityId, cnpj: e.cnpj, caseId: input.caseId ?? null, actor };
  const period = input.competence.slice(0, 7).replace("-", "");

  const to = lastDayOfMonth(addMonths(input.competence, 1));
  const until = to < today ? to : today;

  // As 2 consultas são autorizadas e reservadas juntas: se não couberem no teto, nenhuma sai.
  await authorizeOnly(c, SERVICE_PGDAS, { period });
  await authorizeOnly(c, SERVICE_PAYMENTS, { from: input.competence, to: until, first: 0 });
  await reserve(c, [
    { system: "PGDASD", service: "CONSDECLARACAO13", scope: { period } },
    { system: "PAGTOWEB", service: "PAGAMENTOS71", scope: { from: input.competence, to: until, first: 0 } },
  ]);
  const r = await deps.integra.listPgdasPeriod(e.cnpj, period);
  const pgdas = await storePgdas(c, r, `pgdasd:declaracoes:${e.cnpj}:pa:${period}`, {
    year: Number(period.slice(0, 4)),
    competence: input.competence,
  });

  const payments = await syncPayments(c, input.competence, until, true);
  return { entityId: input.entityId, cnpj: e.cnpj, competence: input.competence, pgdas, payments, calls: 1 + payments.calls };
}

/** Última busca registrada por competência (para a tela avisar "já buscado em ..."). */
export async function lastCompetenceFetch(tx: PoolClient, entityId: string, competence: string): Promise<Date | null> {
  const { rows } = await tx.query<{ at: Date | null }>(
    `SELECT max(occurred_at) AS at FROM audit_log
      WHERE action = 'federal.pgdas_synced' AND entity_id = $1
        AND (competence = $2 OR (competence IS NULL AND data->>'year' = to_char($2::date, 'YYYY')))`,
    [entityId, competence],
  );
  return rows[0]?.at ?? null;
}

/** Número do DAS no PGDAS-D tem 17 posições com zero à esquerda; no PagtoWeb, sem o zero. */
const DAS_MATCH = "ltrim(s.das_number, '0') = ltrim(p.document_number, '0')";

/**
 * Resumo por competência: declaração, DAS emitido e pagamento desse DAS no
 * PagtoWeb (casado pelo número do documento, não por valor ou data).
 */
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

export async function competenceSummary(
  tx: PoolClient,
  entityId: string,
  from: string,
  now: Date = new Date(),
): Promise<CompetenceSummary[]> {
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
    `WITH known AS (
       SELECT competence FROM pgdas_declaration WHERE entity_id = $1
       UNION SELECT competence FROM pgdas_das WHERE entity_id = $1
     ),
     -- Todas as competências desde o primeiro dado conhecido até a última encerrada:
     -- mês sem declaração aparece (pendente ou em falta), não some do resumo.
     comps AS (
       SELECT gs::date AS competence
         FROM generate_series(
                greatest($2::date, (SELECT min(competence) FROM known)),
                greatest((SELECT max(competence) FROM known),
                         (date_trunc('month', ($3::timestamptz AT TIME ZONE 'America/Sao_Paulo')) - interval '1 month')::date),
                interval '1 month') gs
        WHERE EXISTS (SELECT 1 FROM known)
     ),
     paid AS (
       SELECT s.competence, p.amount_total, p.collected_on
         FROM pgdas_das s JOIN federal_payment p ON p.entity_id = s.entity_id AND ${DAS_MATCH}
        WHERE s.entity_id = $1
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
            (SELECT count(*)::int FROM paid WHERE paid.competence = c.competence) AS das_payments,
            (SELECT sum(amount_total)::text FROM paid WHERE paid.competence = c.competence) AS das_paid_amount,
            (SELECT max(collected_on)::text FROM paid WHERE paid.competence = c.competence) AS das_paid_on
       FROM comps c
      ORDER BY c.competence`,
    [entityId, from, now],
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

/** Pagamentos em DAS que não correspondem a nenhum DAS do PGDAS-D (ex.: parcelamento, cobrança). */
export async function dasPaymentsOutsidePgdas(tx: PoolClient, entityId: string, from: string) {
  const { rows } = await tx.query<{
    document_number: string;
    competence: string | null;
    collected_on: string;
    amount_total: string;
    amount_fine: string | null;
    amount_interest: string | null;
  }>(
    `SELECT p.document_number, p.competence::text, p.collected_on::text, p.amount_total::text,
            p.amount_fine::text, p.amount_interest::text
       FROM federal_payment p
      WHERE p.entity_id = $1 AND p.collected_on >= $2
        AND (p.document_type_code = '9' OR p.document_type ILIKE '%SIMPLES NACIONAL%')
        AND NOT EXISTS (SELECT 1 FROM pgdas_das s WHERE s.entity_id = p.entity_id AND ${DAS_MATCH})
      ORDER BY p.collected_on`,
    [entityId, from],
  );
  return rows;
}
