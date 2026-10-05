import type { PoolClient } from "pg";

/**
 * Leitura (sem consulta externa) do que já foi trazido da Receita para uma
 * competência. É o que a tela mostra ao abrir: nunca dispara consulta.
 */

export interface CompetenceDetail {
  competence: string;
  /** Prazo do PGDAS-D: dia 20 do mês seguinte. */
  pgdasDeadline: string;
  lastFetchedAt: string | null;
  declarations: { number: string; operation: string; transmittedAt: string | null; malha: string | null }[];
  das: {
    number: string;
    operation: string;
    issuedAt: string | null;
    paidFlag: boolean | null;
    payment: { collectedOn: string; total: string } | null;
  }[];
  /** Outros pagamentos arrecadados no mês da competência e no seguinte (DARF, parcelas...). */
  otherPayments: {
    documentNumber: string;
    documentType: string | null;
    revenueCode: string | null;
    competence: string | null;
    collectedOn: string;
    total: string;
    fineAndInterest: string | null;
    composition: string[];
  }[];
}

export function pgdasDeadline(competence: string): string {
  const y = Number(competence.slice(0, 4));
  const m = Number(competence.slice(5, 7));
  return m === 12 ? `${y + 1}-01-20` : `${y}-${String(m + 1).padStart(2, "0")}-20`;
}

export async function competenceDetail(tx: PoolClient, entityId: string, competence: string): Promise<CompetenceDetail> {
  const last = await tx.query<{ at: Date | null }>(
    `SELECT max(occurred_at) AS at FROM audit_log
      WHERE action = 'federal.pgdas_synced' AND entity_id = $1
        AND (competence = $2 OR (competence IS NULL AND data->>'year' = to_char($2::date, 'YYYY')))`,
    [entityId, competence],
  );
  const decl = await tx.query<{ number: string; operation: string; transmitted_at: Date | null; malha: string | null }>(
    `SELECT declaration_number AS number, operation, transmitted_at, malha
       FROM pgdas_declaration WHERE entity_id = $1 AND competence = $2 ORDER BY transmitted_at NULLS LAST`,
    [entityId, competence],
  );
  const das = await tx.query<{
    number: string;
    operation: string;
    issued_at: Date | null;
    paid: boolean | null;
    collected_on: string | null;
    total: string | null;
  }>(
    `SELECT s.das_number AS number, s.operation, s.issued_at,
            (SELECT paid FROM pgdas_das_status x WHERE x.das_id = s.id ORDER BY observed_at DESC, created_at DESC LIMIT 1) AS paid,
            p.collected_on::text, p.amount_total::text AS total
       FROM pgdas_das s
       LEFT JOIN federal_payment p ON p.entity_id = s.entity_id AND ltrim(p.document_number, '0') = ltrim(s.das_number, '0')
      WHERE s.entity_id = $1 AND s.competence = $2
      ORDER BY s.issued_at NULLS LAST`,
    [entityId, competence],
  );
  const other = await tx.query<{
    document_number: string;
    document_type: string | null;
    revenue_code: string | null;
    competence: string | null;
    collected_on: string;
    total: string;
    acr: string | null;
    breakdown: { revenueCode: string | null; revenueDescription: string | null; total: string | null }[];
  }>(
    `SELECT p.document_number, p.document_type, p.revenue_code, p.competence::text, p.collected_on::text,
            p.amount_total::text AS total,
            nullif(coalesce(p.amount_fine, 0) + coalesce(p.amount_interest, 0), 0)::text AS acr,
            p.breakdown
       FROM federal_payment p
      WHERE p.entity_id = $1
        AND p.collected_on >= $2::date AND p.collected_on < ($2::date + interval '2 months')
        AND NOT EXISTS (SELECT 1 FROM pgdas_das s
                         WHERE s.entity_id = p.entity_id AND ltrim(s.das_number, '0') = ltrim(p.document_number, '0'))
      ORDER BY p.collected_on, p.document_number`,
    [entityId, competence],
  );
  return {
    competence,
    pgdasDeadline: pgdasDeadline(competence),
    lastFetchedAt: last.rows[0]?.at ? last.rows[0].at.toISOString() : null,
    declarations: decl.rows.map((d) => ({
      number: d.number,
      operation: d.operation,
      transmittedAt: d.transmitted_at ? d.transmitted_at.toISOString() : null,
      malha: d.malha,
    })),
    das: das.rows.map((d) => ({
      number: d.number,
      operation: d.operation,
      issuedAt: d.issued_at ? d.issued_at.toISOString() : null,
      paidFlag: d.paid,
      payment: d.collected_on && d.total ? { collectedOn: d.collected_on, total: d.total } : null,
    })),
    otherPayments: other.rows.map((o) => ({
      documentNumber: o.document_number,
      documentType: o.document_type,
      revenueCode: o.revenue_code,
      competence: o.competence,
      collectedOn: o.collected_on,
      total: o.total,
      fineAndInterest: o.acr,
      composition: (o.breakdown ?? [])
        .filter((b) => b.revenueCode)
        .map((b) => `${b.revenueCode}${b.revenueDescription ? ` ${b.revenueDescription}` : ""}`),
    })),
  };
}
