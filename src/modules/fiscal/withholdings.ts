import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { NFSE_TAX_PARSER, readNfseTaxes } from "../../integrations/nfse/nfse-taxes.js";
import { audit } from "../../platform/audit/audit.js";
import { appendEvent, type Producer } from "../../platform/events/outbox.js";
import type { Actor } from "../../shared/actor.js";
import { Dec } from "../../shared/decimal.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";
import { loadCalendar, type DueAdjust } from "../regulatory/calendar.js";

/**
 * Agente Fiscal — retenções nas NFS-e.
 *
 * 1. Lê os tributos de cada NFS-e (prestada e tomada) e grava em nfse_tax.
 * 2. Nas tomadas, soma por competência (mês de emissão) o IRRF e o
 *    PIS/COFINS/CSLL retidos pela empresa e procura o recolhimento nos
 *    pagamentos federais (itens do DARF com o código de receita da retenção).
 *
 * Situações (IRRF e CSRF, separados):
 *   PRAZO_A_APROVAR             retido; a regra de prazo ainda não foi aprovada
 *   A_VENCER                    retido; prazo ainda não chegou
 *   ABAIXO_DO_MINIMO            retido abaixo de R$ 10,00 (acumula para o mês seguinte)
 *   PAGAMENTO_NAO_IDENTIFICADO  prazo passou e o recolhimento ainda não aparece
 *   PAGO / PAGO_EM_ATRASO       recolhido o mesmo valor retido nas notas
 *   PAGO_DIVERGENTE             recolhido valor diferente do retido nas notas
 *   PAGO_SEM_NOTA               recolhimento sem retenção nas NFS-e recebidas
 *
 * ISS e contribuição previdenciária retidos aparecem para conferência; o
 * recolhimento municipal ainda não tem fonte. Só lê o banco: nenhuma consulta externa.
 */

const PRODUCER: Producer = { kind: "agent", name: "fiscal", version: "0.1.0" };
export const FISCAL_AGENT: Actor = { kind: "AGENT", id: "fiscal" };

/** Códigos de receita do DARF que recolhem as retenções sobre serviços tomados de PJ. */
export const WITHHOLDING_CODES: Record<"IRRF" | "CSRF", Record<string, string>> = {
  IRRF: {
    "1708": "IRRF — serviços prestados por pessoa jurídica",
    "8045": "IRRF — comissões e corretagens",
    "3280": "IRRF — serviços de cooperativas de trabalho",
  },
  CSRF: {
    "5952": "PIS/COFINS/CSLL retidos (código agregado)",
    "5979": "PIS retido",
    "5960": "COFINS retida",
    "5987": "CSLL retida",
  },
};

export type WithholdingTax = "IRRF" | "CSRF";
export type WithholdingStatus =
  | "PRAZO_A_APROVAR" | "A_VENCER" | "ABAIXO_DO_MINIMO" | "PAGAMENTO_NAO_IDENTIFICADO"
  | "PAGO" | "PAGO_EM_ATRASO" | "PAGO_DIVERGENTE" | "PAGO_SEM_NOTA";

// ------------------------------------------------------------------ leitura das notas

export interface TaxReadResult {
  entityId: string;
  read: number;
  divergent: number;
  skipped: number;
}

/** Lê os tributos das NFS-e ainda não lidas pela versão atual do leitor. */
export async function readEntityNfseTaxes(pool: Pool, tenantId: string, entityId: string, actor: Actor = FISCAL_AGENT): Promise<TaxReadResult> {
  return withTenant(pool, tenantId, async (tx) => {
    let read = 0;
    let divergent = 0;
    let skipped = 0;
    const comps = new Set<string>();
    let federal = Dec.ZERO;
    // ids sem leitura possível nesta passada (não é NFS-e ou sem data): evitam laço infinito
    const skippedIds: string[] = [];
    for (;;) {
      const { rows } = await tx.query<{ id: string; role: "PRESTADA" | "TOMADA"; comp: string | null; xml: string }>(
        `SELECT d.id, d.role, to_char(date_trunc('month', d.issued_at AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD') AS comp, d.xml
           FROM nfse_document d
          WHERE d.entity_id = $1 AND d.role IN ('PRESTADA', 'TOMADA')
            AND NOT EXISTS (SELECT 1 FROM nfse_tax t WHERE t.nfse_id = d.id AND t.parser = $2)
            AND d.id <> ALL ($3::uuid[])
          ORDER BY d.nsu LIMIT 200`,
        [entityId, NFSE_TAX_PARSER, skippedIds],
      );
      if (!rows.length) break;
      for (const d of rows) {
        const t = readNfseTaxes(d.xml);
        const comp = d.comp ?? (t?.serviceDate ? `${t.serviceDate.slice(0, 7)}-01` : null);
        if (!t || !comp) {
          skipped++;
          skippedIds.push(d.id);
          continue;
        }
        await tx.query(
          `INSERT INTO nfse_tax (id, tenant_id, entity_id, nfse_id, parser, role, competence, service_date, provider_simples, provider_special_regime,
                                 national_code, nbs_code, incidence_city, incidence_city_name, service_value, unconditional_discount, deductions,
                                 iss_base, iss_rate, iss_value, iss_withheld_type, iss_withheld, irrf, cp, csll_field, pis_due, cofins_due,
                                 pis_cofins_code, csrf, federal_withheld, total_withheld_read, total_withheld_calc, net_value, ibs, cbs, read_check, notes)
           VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
                   $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36)
           ON CONFLICT (tenant_id, nfse_id, parser) DO NOTHING`,
          [newId(), entityId, d.id, t.parser, d.role, comp, t.serviceDate, t.providerSimples, t.providerSpecialRegime, t.nationalCode, t.nbsCode,
            t.incidenceCity, t.incidenceCityName, t.serviceValue, t.unconditionalDiscount, t.deductions, t.issBase, t.issRate, t.issValue,
            t.issWithheldType, t.issWithheld, t.irrf, t.cp, t.csllField, t.pisDue, t.cofinsDue, t.pisCofinsCode, t.csrf, t.federalWithheld,
            t.totalWithheldRead, t.totalWithheldCalc, t.netValue, t.ibs, t.cbs, t.check, JSON.stringify(t.notes)],
        );
        read++;
        comps.add(comp);
        if (t.check === "DIVERGENTE") divergent++;
        if (d.role === "TOMADA") federal = federal.add(t.federalWithheld);
      }
    }
    if (read) {
      const competences = [...comps].sort();
      const key = createHash("sha256").update(`${entityId}:${NFSE_TAX_PARSER}:${read}:${competences.join(",")}:${Date.now()}`).digest("hex").slice(0, 24);
      await appendEvent(tx, {
        type: "NFSE_TAXES_READ",
        schemaVersion: 1,
        producer: PRODUCER,
        idempotencyKey: `nfse-trib:${entityId}:${key}`,
        entityId,
        payload: { entity_id: entityId, documents: read, divergent, competences, federal_withheld_taken: federal.toFixed(2), parser: NFSE_TAX_PARSER },
      });
      await audit(tx, {
        actor,
        action: "fiscal.nfse_taxes_read",
        resourceType: "nfse_tax",
        resourceId: entityId,
        entityId,
        data: { documents: read, divergent, skipped, parser: NFSE_TAX_PARSER, competences },
      });
    }
    return { entityId, read, divergent, skipped };
  });
}

// ------------------------------------------------------------------ situação por competência

export interface WithholdingRow {
  competence: string;
  tax: WithholdingTax;
  status: WithholdingStatus;
  withheld: string;
  paid: string | null;
  difference: string | null;
  due: string | null;
  dueReason: string | null;
  notes: number;
  payment: { documents: string[]; collectedOn: string | null; codes: string[] } | null;
  responsibility: "ANTERIOR" | "LEGACY" | null;
}

export interface TakenMonth {
  competence: string;
  notes: number;
  withRetention: number;
  services: string;
  irrf: string;
  csrf: string;
  cp: string;
  iss: string;
  issByCity: { city: string; value: string; notes: number }[];
  divergent: number;
  fromSimplesProvider: number;
}

export interface TakenNote {
  competence: string;
  number: string | null;
  issuedAt: string | null;
  provider: string | null;
  providerDoc: string | null;
  providerSimples: string | null;
  service: string | null;
  irrf: string;
  csrf: string;
  cp: string;
  iss: string;
  totalRead: string | null;
  check: string;
  notes: string[];
}

interface DueSpec { day: number; adjust?: DueAdjust; min: string }

async function withholdingDue(tx: PoolClient): Promise<DueSpec | null> {
  const r = await tx.query<{ due: { kind: string; day: number; adjust?: DueAdjust; min_payment?: string } | null }>(
    `SELECT r.due FROM obligation_rule r
      WHERE r.code = 'RETENCOES_FEDERAIS' AND EXISTS (SELECT 1 FROM obligation_rule_approval a WHERE a.rule_id = r.id)
      ORDER BY r.version DESC LIMIT 1`,
  );
  const d = r.rows[0]?.due;
  return d && d.kind === "next_month_day" ? { day: d.day, adjust: d.adjust, min: d.min_payment ?? "0.00" } : null;
}

const nextMonth = (comp: string) => {
  const d = new Date(`${comp.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 7);
};

const CANCELLED = `SELECT DISTINCT access_key FROM nfse_document
                    WHERE entity_id = $1 AND role = 'EVENTO' AND access_key IS NOT NULL
                      AND (event_type ILIKE '%101101%' OR event_type ILIKE '%105102%' OR event_type ILIKE '%cancel%')`;

/** Retenções das NFS-e tomadas e o recolhimento identificado, por competência. */
export async function withholdingsOverview(tx: PoolClient, entityId: string, today: string) {
  const cal = await loadCalendar(tx);
  const dueSpec = await withholdingDue(tx);
  const meta = await tx.query<{ start: string | null; data_until: string | null }>(
    `SELECT (SELECT min(valid_from)::text FROM contracted_service_history WHERE entity_id = $1) AS start,
            (SELECT max(collected_on)::text FROM federal_payment WHERE entity_id = $1) AS data_until`,
    [entityId],
  );
  const { start, data_until } = meta.rows[0]!;

  const months = await tx.query<{
    competence: string; notes: number; with_ret: number; services: string; irrf: string; csrf: string; cp: string; iss: string;
    divergent: number; simples_ret: number;
  }>(
    `WITH cancelled AS (${CANCELLED})
     SELECT t.competence::text, count(*)::int AS notes,
            count(*) FILTER (WHERE t.total_withheld_calc > 0)::int AS with_ret,
            coalesce(sum(t.service_value), 0)::text AS services, sum(t.irrf)::text AS irrf, sum(t.csrf)::text AS csrf,
            sum(t.cp)::text AS cp, sum(t.iss_withheld)::text AS iss,
            count(*) FILTER (WHERE t.read_check = 'DIVERGENTE')::int AS divergent,
            count(*) FILTER (WHERE t.provider_simples = '3' AND (t.irrf > 0 OR t.csrf > 0))::int AS simples_ret
       FROM nfse_tax t JOIN nfse_document d ON d.id = t.nfse_id
      WHERE t.entity_id = $1 AND t.role = 'TOMADA' AND t.parser = $2
        AND (d.access_key IS NULL OR d.access_key NOT IN (SELECT access_key FROM cancelled))
      GROUP BY 1 ORDER BY 1 DESC`,
    [entityId, NFSE_TAX_PARSER],
  );
  const cities = await tx.query<{ competence: string; city: string; value: string; notes: number }>(
    `WITH cancelled AS (${CANCELLED})
     SELECT t.competence::text, coalesce(t.incidence_city_name, t.incidence_city, '—') AS city, sum(t.iss_withheld)::text AS value, count(*)::int AS notes
       FROM nfse_tax t JOIN nfse_document d ON d.id = t.nfse_id
      WHERE t.entity_id = $1 AND t.role = 'TOMADA' AND t.parser = $2 AND t.iss_withheld > 0
        AND (d.access_key IS NULL OR d.access_key NOT IN (SELECT access_key FROM cancelled))
      GROUP BY 1, 2 ORDER BY 1, 2`,
    [entityId, NFSE_TAX_PARSER],
  );
  const codes = [...Object.keys(WITHHOLDING_CODES.IRRF), ...Object.keys(WITHHOLDING_CODES.CSRF)];
  const pays = await tx.query<{ document_number: string; collected_on: string; competence: string; code: string; principal: string }>(
    `SELECT p.document_number, p.collected_on::text, b->>'competence' AS competence, b->>'revenueCode' AS code, coalesce(b->>'principal', '0') AS principal
       FROM federal_payment p, jsonb_array_elements(p.breakdown) b
      WHERE p.entity_id = $1 AND b->>'revenueCode' = ANY ($2::text[]) AND b->>'competence' IS NOT NULL`,
    [entityId, codes],
  );

  const taken: TakenMonth[] = months.rows.map((m) => ({
    competence: m.competence,
    notes: m.notes,
    withRetention: m.with_ret,
    services: Dec.of(m.services).toFixed(2),
    irrf: Dec.of(m.irrf ?? "0").toFixed(2),
    csrf: Dec.of(m.csrf ?? "0").toFixed(2),
    cp: Dec.of(m.cp ?? "0").toFixed(2),
    iss: Dec.of(m.iss ?? "0").toFixed(2),
    issByCity: cities.rows.filter((c) => c.competence === m.competence).map((c) => ({ city: c.city, value: Dec.of(c.value).toFixed(2), notes: c.notes })),
    divergent: m.divergent,
    fromSimplesProvider: m.simples_ret,
  }));

  const byComp = new Map(taken.map((t) => [t.competence, t]));
  const payComps = new Set(pays.rows.map((p) => `${p.competence.slice(0, 7)}-01`));
  const allComps = [...new Set([...byComp.keys(), ...payComps])].sort().reverse();
  const current = `${today.slice(0, 7)}-01`;

  const rows: WithholdingRow[] = [];
  for (const c of allComps) {
    if (c >= current) continue; // mês em curso: ainda recebendo notas
    const m = byComp.get(c);
    let due: string | null = null;
    let dueReason: string | null = null;
    if (dueSpec) {
      const a = cal.adjust(`${nextMonth(c)}-${String(dueSpec.day).padStart(2, "0")}`, dueSpec.adjust);
      due = a.due;
      dueReason = a.reason;
    }
    for (const tax of ["IRRF", "CSRF"] as const) {
      const withheld = Dec.of(m ? (tax === "IRRF" ? m.irrf : m.csrf) : "0");
      const items = pays.rows.filter((p) => p.competence.slice(0, 7) === c.slice(0, 7) && p.code in WITHHOLDING_CODES[tax]);
      if (withheld.isZero() && !items.length) continue;
      const paid = items.reduce((s, p) => s.add(p.principal), Dec.ZERO);
      const collectedOn = items.map((p) => p.collected_on).sort().pop() ?? null;
      let status: WithholdingStatus;
      if (items.length) {
        if (withheld.isZero()) status = "PAGO_SEM_NOTA";
        else if (paid.cmp(withheld) !== 0) status = "PAGO_DIVERGENTE";
        else status = due && collectedOn && collectedOn > due ? "PAGO_EM_ATRASO" : "PAGO";
      } else if (!dueSpec) status = "PRAZO_A_APROVAR";
      else if (withheld.cmp(dueSpec.min) < 0) status = "ABAIXO_DO_MINIMO";
      else if (due && today <= due) status = "A_VENCER";
      else status = "PAGAMENTO_NAO_IDENTIFICADO";
      rows.push({
        competence: c,
        tax,
        status,
        withheld: withheld.toFixed(2),
        paid: items.length ? paid.toFixed(2) : null,
        difference: items.length && !withheld.isZero() ? paid.sub(withheld).toFixed(2) : null,
        due,
        dueReason,
        notes: m?.withRetention ?? 0,
        payment: items.length
          ? { documents: [...new Set(items.map((p) => p.document_number))], collectedOn, codes: [...new Set(items.map((p) => p.code))] }
          : null,
        responsibility: start ? (c < `${start.slice(0, 7)}-01` ? "ANTERIOR" : "LEGACY") : null,
      });
    }
  }
  return { rows, taken, dataUntil: data_until, dueApproved: Boolean(dueSpec) };
}

/** Notas tomadas com retenção (para conferir), da competência pedida. */
export async function takenNotes(tx: PoolClient, entityId: string, competence: string): Promise<TakenNote[]> {
  const { rows } = await tx.query(
    `WITH cancelled AS (${CANCELLED})
     SELECT t.competence::text, d.number, d.issued_at, d.provider_name, d.provider_doc, t.provider_simples, t.service_value::text,
            t.irrf::text, t.csrf::text, t.cp::text, t.iss_withheld::text, t.total_withheld_read::text, t.read_check, t.notes
       FROM nfse_tax t JOIN nfse_document d ON d.id = t.nfse_id
      WHERE t.entity_id = $1 AND t.role = 'TOMADA' AND t.parser = $2 AND t.competence = $3
        AND (t.total_withheld_calc > 0 OR t.read_check <> 'OK')
        AND (d.access_key IS NULL OR d.access_key NOT IN (SELECT access_key FROM cancelled))
      ORDER BY d.issued_at`,
    [entityId, NFSE_TAX_PARSER, competence],
  );
  return rows.map((r) => ({
    competence: r.competence,
    number: r.number,
    issuedAt: r.issued_at ? (r.issued_at as Date).toISOString() : null,
    provider: r.provider_name,
    providerDoc: r.provider_doc,
    providerSimples: r.provider_simples,
    service: r.service_value,
    irrf: r.irrf,
    csrf: r.csrf,
    cp: r.cp,
    iss: r.iss_withheld,
    totalRead: r.total_withheld_read,
    check: r.read_check,
    notes: r.notes,
  }));
}

/** Grava a situação de cada retenção quando ela muda e emite WITHHOLDING_STATUS_CHANGED. */
export async function refreshWithholdings(pool: Pool, tenantId: string, entityId: string, today: string) {
  return withTenant(pool, tenantId, async (tx) => {
    const { rows } = await withholdingsOverview(tx, entityId, today);
    let changed = 0;
    for (const w of rows) {
      const last = await tx.query<{ id: string; status: string; withheld: string; paid: string | null; due_on: string | null }>(
        `SELECT id, status, withheld::text, paid::text, due_on::text FROM withholding_observation
          WHERE entity_id = $1 AND competence = $2 AND tax = $3 ORDER BY created_at DESC LIMIT 1`,
        [entityId, w.competence, w.tax],
      );
      const prev = last.rows[0];
      const same = prev && prev.status === w.status && Dec.of(prev.withheld).cmp(w.withheld) === 0 && prev.due_on === w.due
        && (prev.paid === null ? w.paid === null : w.paid !== null && Dec.of(prev.paid).cmp(w.paid) === 0);
      if (same) continue;
      const details = { notes: w.notes, payment: w.payment, difference: w.difference, dueReason: w.dueReason, responsibility: w.responsibility };
      const fingerprint = createHash("sha256").update(JSON.stringify({ s: w.status, w: w.withheld, p: w.paid, d: w.due, details, prev: prev?.id ?? null })).digest("hex");
      const ins = await tx.query(
        `INSERT INTO withholding_observation (id, tenant_id, entity_id, competence, tax, status, withheld, paid, due_on, details, fingerprint)
         VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id, entity_id, competence, tax, fingerprint) DO NOTHING`,
        [newId(), entityId, w.competence, w.tax, w.status, w.withheld, w.paid, w.due, JSON.stringify(details), fingerprint],
      );
      if (!ins.rowCount) continue;
      changed++;
      await appendEvent(tx, {
        type: "WITHHOLDING_STATUS_CHANGED",
        schemaVersion: 1,
        producer: PRODUCER,
        idempotencyKey: `retencao:${entityId}:${w.competence.slice(0, 7)}:${w.tax}:${fingerprint}`,
        entityId,
        competence: w.competence,
        payload: {
          entity_id: entityId,
          competence: w.competence,
          tax: w.tax,
          from: prev?.status ?? null,
          to: w.status,
          withheld: w.withheld,
          paid: w.paid,
          due: w.due,
        },
      });
    }
    return { withholdings: rows.length, changed };
  });
}

/** Retenções que pedem atenção humana (só competências sob responsabilidade do escritório). */
export async function withholdingsNeedingAttention(tx: PoolClient) {
  const { rows } = await tx.query<{
    entity_id: string; entity: string; competence: string; tax: WithholdingTax; status: WithholdingStatus;
    withheld: string; paid: string | null; due_on: string | null; created_at: Date;
  }>(
    `SELECT o.entity_id, coalesce(e.trade_name, e.legal_name) AS entity, o.competence::text, o.tax, o.status,
            o.withheld::text, o.paid::text, o.due_on::text, o.created_at
       FROM (SELECT DISTINCT ON (entity_id, competence, tax) * FROM withholding_observation
              ORDER BY entity_id, competence, tax, created_at DESC) o
       JOIN entity e ON e.id = o.entity_id
      WHERE o.status IN ('PAGAMENTO_NAO_IDENTIFICADO', 'PAGO_DIVERGENTE')
        AND coalesce(o.details->>'responsibility', 'LEGACY') = 'LEGACY'
      ORDER BY o.competence, o.tax`,
  );
  return rows;
}
