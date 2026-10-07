import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { appendEvent } from "../../platform/events/outbox.js";
import { Dec } from "../../shared/decimal.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";
import { loadCalendar, type DueAdjust } from "../regulatory/calendar.js";

/**
 * Agente Guias — DAS do Simples por competência, do prazo ao pagamento.
 *
 *   A_DECLARAR                   prazo ainda não chegou e não há declaração
 *   DECLARACAO_NAO_IDENTIFICADA  prazo passou e a declaração ainda não aparece
 *   SEM_DEBITO                   declarado com receita zero (não há DAS)
 *   DECLARADO_SEM_DAS            declarado, DAS ainda não emitido, prazo futuro
 *   A_VENCER                     DAS emitido, prazo futuro
 *   PAGAMENTO_NAO_IDENTIFICADO   prazo passou e o pagamento ainda não aparece
 *   PAGO / PAGO_EM_ATRASO        pagamento identificado (PagtoWeb ou PGDAS-D)
 *
 * Só lê o que já está no banco (nenhuma consulta externa). A situação vale até
 * a última consulta à Receita; por isso nunca se afirma inadimplência.
 */

export type GuideStatus =
  | "A_DECLARAR" | "DECLARACAO_NAO_IDENTIFICADA" | "SEM_DEBITO" | "DECLARADO_SEM_DAS"
  | "A_VENCER" | "PAGAMENTO_NAO_IDENTIFICADO" | "PAGO" | "PAGO_EM_ATRASO";

export interface GuideRow {
  competence: string;
  status: GuideStatus;
  due: string | null;
  dueNominal: string | null;
  dueReason: string | null;
  responsibility: "ANTERIOR" | "LEGACY" | null;
  declaration: { number: string; operation: string; transmittedAt: string | null } | null;
  das: { number: string; issuedAt: string | null; paid: boolean | null }[];
  payment: { documents: string[]; collectedOn: string | null; total: string; principal: string | null; source: "PAGTOWEB" | "PGDAS" } | null;
  calculated: { total: string | null; status: string } | null;
}

const pad17 = (s: string) => s.replace(/\D/g, "").padStart(17, "0");
const ym = (d: string) => d.slice(0, 7);
function addMonths(comp: string, n: number): string {
  const d = new Date(`${comp.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10).replace(/-\d{2}$/, "-01");
}

async function pgdasDue(tx: PoolClient): Promise<{ day: number; adjust?: DueAdjust } | null> {
  const r = await tx.query<{ due: { kind: string; day: number; adjust?: DueAdjust } | null }>(
    `SELECT r.due FROM obligation_rule r
      WHERE r.code = 'PGDAS_D' AND EXISTS (SELECT 1 FROM obligation_rule_approval a WHERE a.rule_id = r.id)
      ORDER BY r.version DESC LIMIT 1`,
  );
  const due = r.rows[0]?.due;
  return due && due.kind === "next_month_day" ? { day: due.day, adjust: due.adjust } : null;
}

/** Situação das guias da empresa nos últimos 12 meses fechados e no mês a declarar. */
export async function guidesOverview(tx: PoolClient, entityId: string, today: string): Promise<{ rows: GuideRow[]; dataUntil: string | null }> {
  const cal = await loadCalendar(tx);
  const dueSpec = await pgdasDue(tx);
  const meta = await tx.query<{ opening: string | null; start: string | null; data_until: string | null }>(
    `SELECT (SELECT date_trunc('month', min(opened_at))::date::text FROM establishment WHERE entity_id = $1 AND kind = 'MATRIZ') AS opening,
            (SELECT min(valid_from)::text FROM contracted_service_history WHERE entity_id = $1) AS start,
            (SELECT max(observed_at)::text FROM pgdas_das_status s JOIN pgdas_das d ON d.id = s.das_id WHERE d.entity_id = $1) AS data_until`,
    [entityId],
  );
  const { opening, start, data_until } = meta.rows[0]!;

  const decls = await tx.query<{ competence: string; declaration_number: string; operation: string; transmitted_at: string | null }>(
    `SELECT DISTINCT ON (competence) competence::text, declaration_number, operation, transmitted_at::text
       FROM pgdas_declaration WHERE entity_id = $1 ORDER BY competence, declaration_number DESC`,
    [entityId],
  );
  const das = await tx.query<{ competence: string; das_number: string; issued_at: string | null; paid: boolean | null }>(
    `SELECT d.competence::text, d.das_number, d.issued_at::text,
            (SELECT s.paid FROM pgdas_das_status s WHERE s.das_id = d.id ORDER BY s.observed_at DESC LIMIT 1) AS paid
       FROM pgdas_das d WHERE d.entity_id = $1 ORDER BY d.competence, d.issued_at`,
    [entityId],
  );
  const pays = await tx.query<{ document_number: string; competence: string | null; collected_on: string; amount_total: string; breakdown: { competence?: string; principal?: string }[] }>(
    `SELECT document_number, competence::text, collected_on::text, amount_total::text, breakdown
       FROM federal_payment WHERE entity_id = $1 AND revenue_code = '3333'`,
    [entityId],
  );
  const declaredRevenue = await tx.query<{ competence: string; total: string }>(
    `SELECT DISTINCT ON (competence) competence::text, total::text FROM pgdas_declared_revenue
      WHERE entity_id = $1 ORDER BY competence, declared_in DESC, created_at DESC`,
    [entityId],
  );
  const calcs = await tx.query<{ competence: string; total: string | null; status: string }>(
    `SELECT DISTINCT ON (competence) competence::text, total::text, status FROM simples_calculation
      WHERE entity_id = $1 ORDER BY competence, created_at DESC`,
    [entityId],
  );

  const declBy = new Map(decls.rows.map((r) => [r.competence, r]));
  const revBy = new Map(declaredRevenue.rows.map((r) => [r.competence, r.total]));
  const calcBy = new Map(calcs.rows.map((r) => [r.competence, r]));

  // Últimos 12 meses fechados + o mês anterior ao atual (a declarar), desde o início de atividade.
  const current = `${today.slice(0, 7)}-01`;
  const first = [addMonths(current, -13), opening ?? "0000-01-01"].sort().pop()!;
  const comps: string[] = [];
  for (let c = first; c < current; c = addMonths(c, 1)) comps.push(c);

  const rows: GuideRow[] = comps.map((c) => {
    const decl = declBy.get(c) ?? null;
    const dases = das.rows.filter((d) => d.competence === c);
    const numbers = new Set(dases.map((d) => pad17(d.das_number)));
    const byDoc = pays.rows.filter((p) => numbers.has(pad17(p.document_number)));
    const byItem = pays.rows.filter((p) => !numbers.has(pad17(p.document_number)) && p.competence === c && (p.breakdown ?? []).some((b) => b.competence === c));
    const principalOf = (ps: typeof pays.rows) => {
      let s = Dec.ZERO;
      for (const p of ps) for (const b of p.breakdown ?? []) if (b.competence === c && b.principal) s = s.add(b.principal);
      return s;
    };
    let payment: GuideRow["payment"] = null;
    const paidList = byDoc.length ? byDoc : byItem;
    if (paidList.length) {
      payment = {
        documents: paidList.map((p) => pad17(p.document_number)),
        collectedOn: paidList.map((p) => p.collected_on).sort()[0] ?? null,
        total: paidList.reduce((a, p) => a.add(p.amount_total), Dec.ZERO).toFixed(2),
        principal: principalOf(paidList).toFixed(2),
        source: "PAGTOWEB",
      };
    } else if (dases.some((d) => d.paid)) {
      payment = { documents: dases.filter((d) => d.paid).map((d) => d.das_number), collectedOn: null, total: "0.00", principal: null, source: "PGDAS" };
    }

    let due: string | null = null, dueNominal: string | null = null, dueReason: string | null = null;
    if (dueSpec) {
      dueNominal = `${addMonths(c, 1).slice(0, 8)}${String(dueSpec.day).padStart(2, "0")}`;
      const a = cal.adjust(dueNominal, dueSpec.adjust);
      due = a.due;
      dueReason = a.reason;
    }
    const passed = due !== null && today > due;
    const zero = decl && revBy.has(c) && Dec.of(revBy.get(c)!).isZero();

    let status: GuideStatus;
    if (payment) status = payment.collectedOn && due && payment.collectedOn > due ? "PAGO_EM_ATRASO" : "PAGO";
    else if (zero) status = "SEM_DEBITO";
    else if (!decl && !dases.length) status = passed ? "DECLARACAO_NAO_IDENTIFICADA" : "A_DECLARAR";
    else if (passed) status = "PAGAMENTO_NAO_IDENTIFICADO";
    else status = dases.length ? "A_VENCER" : "DECLARADO_SEM_DAS";

    const calc = calcBy.get(c);
    return {
      competence: c,
      status,
      due,
      dueNominal,
      dueReason,
      responsibility: start ? (c < `${start.slice(0, 7)}-01` ? "ANTERIOR" : "LEGACY") : null,
      declaration: decl ? { number: decl.declaration_number, operation: decl.operation, transmittedAt: decl.transmitted_at } : null,
      das: dases.map((d) => ({ number: d.das_number, issuedAt: d.issued_at, paid: d.paid })),
      payment,
      calculated: calc ? { total: calc.total, status: calc.status } : null,
    };
  });
  return { rows: rows.reverse(), dataUntil: data_until };
}

/** Grava a situação de cada guia quando ela muda e emite GUIDE_STATUS_CHANGED. */
export async function refreshGuides(pool: Pool, tenantId: string, entityId: string, today: string = new Date().toISOString().slice(0, 10)) {
  return withTenant(pool, tenantId, async (tx) => {
    const { rows } = await guidesOverview(tx, entityId, today);
    let changed = 0;
    for (const g of rows) {
      const last = await tx.query<{ id: string; status: string; due_on: string | null; details: { documents?: string[] } }>(
        `SELECT id, status, due_on::text, details FROM tax_guide_observation
          WHERE entity_id = $1 AND competence = $2 AND guide = 'DAS_SIMPLES' ORDER BY created_at DESC LIMIT 1`,
        [entityId, g.competence],
      );
      const docs = g.payment?.documents ?? [];
      const prev = last.rows[0];
      if (prev && prev.status === g.status && prev.due_on === g.due && JSON.stringify(prev.details.documents ?? []) === JSON.stringify(docs)) continue;
      const details = {
        documents: docs,
        collectedOn: g.payment?.collectedOn ?? null,
        paymentSource: g.payment?.source ?? null,
        declaration: g.declaration?.number ?? null,
        das: g.das.map((d) => d.number),
        dueReason: g.dueReason,
        responsibility: g.responsibility,
      };
      const fingerprint = createHash("sha256").update(JSON.stringify({ s: g.status, d: g.due, details, p: prev?.id ?? null })).digest("hex");
      const ins = await tx.query(
        `INSERT INTO tax_guide_observation (id, tenant_id, entity_id, competence, guide, status, due_on, details, fingerprint)
         VALUES ($1, current_tenant(), $2, $3, 'DAS_SIMPLES', $4, $5, $6, $7)
         ON CONFLICT (tenant_id, entity_id, competence, guide, fingerprint) DO NOTHING`,
        [newId(), entityId, g.competence, g.status, g.due, JSON.stringify(details), fingerprint],
      );
      if (!ins.rowCount) continue;
      changed++;
      await appendEvent(tx, {
        type: "GUIDE_STATUS_CHANGED",
        schemaVersion: 1,
        producer: { kind: "agent", name: "guides", version: "0.1.0" },
        idempotencyKey: `guia:das:${entityId}:${ym(g.competence)}:${fingerprint}`,
        entityId,
        competence: g.competence,
        payload: {
          entity_id: entityId,
          competence: g.competence,
          guide: "DAS_SIMPLES",
          from: prev?.status ?? null,
          to: g.status,
          due: g.due,
          documents: docs,
        },
      });
    }
    return { guides: rows.length, changed };
  });
}

/** Guias que pedem atenção humana (só competências sob responsabilidade do escritório). */
export async function guidesNeedingAttention(tx: PoolClient) {
  const { rows } = await tx.query<{ entity_id: string; entity: string; competence: string; status: string; due_on: string | null; created_at: Date }>(
    `SELECT o.entity_id, coalesce(e.trade_name, e.legal_name) AS entity, o.competence::text, o.status, o.due_on::text, o.created_at
       FROM (SELECT DISTINCT ON (entity_id, competence) * FROM tax_guide_observation
              WHERE guide = 'DAS_SIMPLES' ORDER BY entity_id, competence, created_at DESC) o
       JOIN entity e ON e.id = o.entity_id
      WHERE o.status IN ('PAGAMENTO_NAO_IDENTIFICADO', 'DECLARACAO_NAO_IDENTIFICADA')
        AND coalesce(o.details->>'responsibility', 'LEGACY') = 'LEGACY'
      ORDER BY o.competence`,
  );
  return rows;
}
