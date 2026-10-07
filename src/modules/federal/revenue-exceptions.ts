import type { Pool, PoolClient } from "pg";
import { audit } from "../../platform/audit/audit.js";
import { openCase, transitionCase } from "../../platform/cases/case-engine.js";
import { appendEvent, type Producer } from "../../platform/events/outbox.js";
import { openPendingItem, resolvePendingItem } from "../../platform/pending/pending.js";
import type { Actor } from "../../shared/actor.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";
import { REVENUE_TOLERANCE, revenueCrossCheck, type RevenueCheckRow } from "./declared-revenue.js";

/**
 * Agente Revisão — exceções da conferência receita declarada × NFS-e prestadas.
 *
 * Divergência → Case EXCEPTION (empresa + competência) aguardando decisão humana,
 * com hipótese determinística (sem IA): notas canceladas no mês que somam a
 * diferença, NFS-e a maior que o declarado, ou sem explicação automática.
 * Quando a conferência volta a bater (declaração retificada lida, nota corrigida),
 * o Case fecha sozinho. Não calcula tributo nem diz o efeito no DAS.
 */

export const REVIEW_AGENT: Actor = { kind: "AGENT", id: "review" };
const PRODUCER: Producer = { kind: "agent", name: "review", version: "0.1.0" };

export interface InvolvedNote {
  number: string | null;
  accessKey: string | null;
  value: string;
  cancelledOn: string | null;
  event: string | null;
}

export interface Hypothesis {
  code: "CANCELADAS_TOTAL" | "CANCELADAS_PARTE" | "NFSE_A_MAIOR" | "SEM_EXPLICACAO";
  text: string;
  notes: InvolvedNote[];
}

const cents = (v: string | number) => Math.round(Number(v) * 100);
const brl = (v: number) => (v / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

async function cancelledInMonth(tx: PoolClient, entityId: string, competence: string): Promise<InvolvedNote[]> {
  const { rows } = await tx.query<{ number: string | null; access_key: string | null; value: string; cancelled_on: string | null; event: string | null }>(
    `SELECT p.number, p.access_key, p.service_value::text AS value,
            to_char(min(e.issued_at) AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS cancelled_on, min(e.event_type) AS event
       FROM nfse_document p
       JOIN nfse_document e ON e.entity_id = p.entity_id AND e.role = 'EVENTO' AND e.access_key = p.access_key
                           AND (e.event_type ILIKE '%cancel%' OR e.event_type ILIKE '%101101%' OR e.event_type ILIKE '%105102%')
      WHERE p.entity_id = $1 AND p.role = 'PRESTADA' AND p.service_value IS NOT NULL
        AND date_trunc('month', p.issued_at AT TIME ZONE 'America/Sao_Paulo')::date = $2::date
      GROUP BY p.number, p.access_key, p.service_value
      ORDER BY p.number`,
    [entityId, competence],
  );
  return rows.map((r) => ({ number: r.number, accessKey: r.access_key, value: Number(r.value).toFixed(2), cancelledOn: r.cancelled_on, event: r.event }));
}

/** Menor combinação de notas canceladas que soma exatamente a diferença (até 16 notas). */
function subsetMatching(notes: InvolvedNote[], target: number): InvolvedNote[] | null {
  if (notes.length > 16) return null;
  let best: InvolvedNote[] | null = null;
  for (let mask = 1; mask < 1 << notes.length; mask++) {
    let sum = 0;
    const pick: InvolvedNote[] = [];
    for (let i = 0; i < notes.length; i++) {
      if (mask & (1 << i)) {
        sum += cents(notes[i]!.value);
        pick.push(notes[i]!);
      }
    }
    if (Math.abs(sum - target) <= cents(REVENUE_TOLERANCE) && (!best || pick.length < best.length)) best = pick;
  }
  return best;
}

export async function hypothesisFor(tx: PoolClient, entityId: string, row: RevenueCheckRow): Promise<Hypothesis> {
  const diff = cents(row.difference ?? 0); // NFS-e − declarado
  const cancelled = await cancelledInMonth(tx, entityId, row.competence);
  if (diff < 0) {
    const gap = -diff;
    const total = cancelled.reduce((s, n) => s + cents(n.value), 0);
    if (cancelled.length && Math.abs(total - gap) <= cents(REVENUE_TOLERANCE)) {
      return {
        code: "CANCELADAS_TOTAL",
        text: `Declarado ${brl(gap)} acima das NFS-e válidas. As ${cancelled.length} nota(s) cancelada(s) do mês somam exatamente essa diferença: a declaração deve ter incluído notas canceladas.`,
        notes: cancelled,
      };
    }
    const subset = subsetMatching(cancelled, gap);
    if (subset) {
      return {
        code: "CANCELADAS_PARTE",
        text: `Declarado ${brl(gap)} acima das NFS-e válidas. ${subset.length} das notas canceladas no mês somam exatamente essa diferença.`,
        notes: subset,
      };
    }
    return {
      code: "SEM_EXPLICACAO",
      text: `Declarado ${brl(gap)} acima das NFS-e válidas, sem combinação de notas canceladas que explique. Conferir receitas fora de NFS-e ou erro de digitação na declaração.`,
      notes: cancelled,
    };
  }
  return {
    code: "NFSE_A_MAIOR",
    text: `NFS-e válidas ${brl(diff)} acima do declarado. Possível receita não declarada ou nota emitida no mês com competência de outro mês.`,
    notes: cancelled,
  };
}

const pendingType = (competence: string) => `REVENUE_DIVERGENCE_${competence.slice(0, 7).replace("-", "")}`;
const mmYYYY = (competence: string) => `${competence.slice(5, 7)}/${competence.slice(0, 4)}`;

async function moveTo(tx: PoolClient, caseId: string, path: Parameters<typeof transitionCase>[1]["to"][], reason: string, actor: Actor) {
  for (const to of path) {
    const cur = await tx.query<{ status: string }>(`SELECT status FROM "case" WHERE id = $1`, [caseId]);
    if (cur.rows[0]?.status === to) continue;
    await transitionCase(tx, { caseId, to, reason }, actor);
  }
}

export interface ExceptionRefresh {
  opened: number;
  updated: number;
  closed: number;
}

/** Abre, atualiza e fecha as exceções de receita de uma empresa. Idempotente. */
export async function refreshRevenueExceptions(pool: Pool, tenantId: string, entityId: string, actor: Actor = REVIEW_AGENT): Promise<ExceptionRefresh> {
  return withTenant(pool, tenantId, async (tx) => {
    const out: ExceptionRefresh = { opened: 0, updated: 0, closed: 0 };
    const rows = await revenueCrossCheck(tx, entityId);
    const open = await tx.query<{ id: string; competence: string; status: string }>(
      `SELECT id, to_char(competence, 'YYYY-MM-DD') AS competence, status FROM "case"
        WHERE entity_id = $1 AND type = 'EXCEPTION' AND idempotency_key LIKE 'excecao:receita:%'
          AND status NOT IN ('COMPLETED', 'CANCELLED')`,
      [entityId],
    );
    const openByComp = new Map(open.rows.map((r) => [r.competence, r]));

    for (const row of rows) {
      if (row.status === "SEM_DECLARACAO") continue;
      const existing = openByComp.get(row.competence);

      if (row.status === "OK") {
        if (!existing) continue;
        const p = await tx.query<{ id: string }>("SELECT id FROM pending_item WHERE status = 'OPEN' AND entity_id = $1 AND type = $2", [entityId, pendingType(row.competence)]);
        for (const it of p.rows) await resolvePendingItem(tx, { id: it.id, resolution: "Conferência passou a bater" }, actor);
        await moveTo(tx, existing.id, ["IN_PROGRESS", "IN_REVIEW", "COMPLETED"], "Conferência passou a bater (declaração ou NFS-e atualizadas)", actor);
        out.closed++;
        continue;
      }

      // DIVERGENTE
      const h = await hypothesisFor(tx, entityId, row);
      const legacy = row.responsibility === "LEGACY";
      const { case: c, created } = await openCase(
        tx,
        {
          type: "EXCEPTION",
          idempotencyKey: `excecao:receita:${entityId}:${row.competence.slice(0, 7)}`,
          origin: "conferencia-receita",
          requester: actor.id,
          entityId,
          competence: row.competence.slice(0, 7),
          priority: legacy ? 2 : 4,
          ownerAgent: "review",
        },
        actor,
      );
      if (created) {
        out.opened++;
        await moveTo(tx, c.id, ["IN_PROGRESS", "WAITING_HUMAN"], "Divergência entre receita declarada e NFS-e", actor);
      }
      const last = await tx.query<{ declared: string; nfse: string; hypothesis_code: string }>(
        "SELECT declared::text, nfse::text, hypothesis_code FROM revenue_divergence WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1",
        [c.id],
      );
      const prev = last.rows[0];
      const changed = !prev || cents(prev.declared) !== cents(row.declared!) || cents(prev.nfse) !== cents(row.nfsePrestadas) || prev.hypothesis_code !== h.code;
      if (changed) {
        if (prev) out.updated++;
        await tx.query(
          `INSERT INTO revenue_divergence (id, tenant_id, entity_id, case_id, competence, declared, nfse, difference, responsibility, hypothesis_code, hypothesis, notes)
           VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [newId(), entityId, c.id, row.competence, row.declared, row.nfsePrestadas, row.difference, row.responsibility, h.code, h.text, JSON.stringify(h.notes)],
        );
        await appendEvent(tx, {
          type: "REVENUE_DIVERGENCE_DETECTED",
          schemaVersion: 1,
          producer: PRODUCER,
          idempotencyKey: `divergencia:${c.id}:${row.declared}:${row.nfsePrestadas}:${h.code}`,
          entityId,
          caseId: c.id,
          competence: row.competence,
          payload: {
            entity_id: entityId,
            competence: row.competence,
            declared: row.declared!,
            nfse: row.nfsePrestadas,
            difference: row.difference!,
            hypothesis: h.code,
            responsibility: row.responsibility,
          },
        });
      }
      // Pendência só enquanto ninguém decidiu (decisão RETIFICAR deixa o Case aguardando a nova declaração).
      const decided = await tx.query("SELECT 1 FROM exception_decision WHERE case_id = $1", [c.id]);
      if (!decided.rowCount) {
        await openPendingItem(
          tx,
          {
            type: pendingType(row.competence),
            entityId,
            caseId: c.id,
            requiredInformation: `Receita ${mmYYYY(row.competence)}: declarado no PGDAS-D × NFS-e prestadas não confere`,
            responsibleSource: "OFFICE",
            impact: h.text + (legacy ? "" : " Período do escritório anterior."),
          },
          actor,
        );
      }
    }
    return out;
  });
}

/** Decisão humana sobre uma exceção de receita. */
export async function decideRevenueException(
  pool: Pool,
  tenantId: string,
  caseId: string,
  input: { decision: "RETIFICAR" | "MANTER"; note?: string | null },
  actor: Actor,
) {
  if (actor.kind !== "USER") throw new Error("Só uma pessoa decide uma exceção");
  if (input.decision === "MANTER" && (input.note ?? "").trim().length < 5) throw new Error("Para manter a declaração, escreva a justificativa");
  return withTenant(pool, tenantId, async (tx) => {
    const c = await tx.query<{ id: string; entity_id: string; status: string; competence: string }>(
      `SELECT id, entity_id, status, to_char(competence, 'YYYY-MM-DD') AS competence FROM "case" WHERE id = $1 AND type = 'EXCEPTION'`,
      [caseId],
    );
    const row = c.rows[0];
    if (!row) throw new Error("Exceção não encontrada");
    if (row.status === "COMPLETED" || row.status === "CANCELLED") throw new Error("Exceção já encerrada");
    await tx.query("INSERT INTO exception_decision (id, tenant_id, case_id, decision, note, actor_id) VALUES ($1, current_tenant(), $2, $3, $4, $5)", [
      newId(),
      caseId,
      input.decision,
      input.note?.trim() || null,
      actor.id,
    ]);
    const p = await tx.query<{ id: string }>("SELECT id FROM pending_item WHERE status = 'OPEN' AND case_id = $1", [caseId]);
    const resolution = input.decision === "RETIFICAR" ? `Decisão: retificar o PGDAS-D (${actor.id})` : `Decisão: manter a declaração — ${input.note!.trim()} (${actor.id})`;
    for (const it of p.rows) await resolvePendingItem(tx, { id: it.id, resolution }, actor);
    if (input.decision === "RETIFICAR") {
      // Fica aguardando a declaração retificada; fecha sozinho quando a conferência bater.
      await moveTo(tx, caseId, ["IN_PROGRESS", "WAITING_EXTERNAL"], "Escritório vai retificar o PGDAS-D", actor);
    } else {
      await moveTo(tx, caseId, ["IN_PROGRESS", "IN_REVIEW", "COMPLETED"], `Diferença mantida: ${input.note!.trim()}`, actor);
    }
    await appendEvent(tx, {
      type: "EXCEPTION_DECIDED",
      schemaVersion: 1,
      producer: { kind: "user", name: actor.id, version: "1" },
      idempotencyKey: `decisao:${caseId}:${input.decision}:${Date.now()}`,
      entityId: row.entity_id,
      caseId,
      payload: { case_id: caseId, decision: input.decision, note: input.note?.trim() || null, decided_by: actor.id },
    });
    await audit(tx, {
      actor,
      action: "review.exception_decided",
      resourceType: "case",
      resourceId: caseId,
      entityId: row.entity_id,
      competence: row.competence,
      caseId,
      approvedBy: actor.id,
      data: { decision: input.decision, note: input.note?.trim() || null },
    });
    return { decision: input.decision };
  });
}

/** Detalhe das exceções abertas (Fila humana): última fotografia de cada uma. */
export async function openRevenueExceptions(tx: PoolClient) {
  const { rows } = await tx.query<{
    case_id: string; entity_id: string; entity: string; competence: string; status: string; declared: string; nfse: string; difference: string;
    responsibility: string | null; hypothesis_code: string; hypothesis: string; notes: InvolvedNote[]; since: Date; decision: string | null;
  }>(
    `SELECT DISTINCT ON (c.id) c.id AS case_id, c.entity_id, coalesce(e.trade_name, e.legal_name) AS entity, to_char(c.competence, 'YYYY-MM-DD') AS competence,
            c.status, d.declared::text, d.nfse::text, d.difference::text, d.responsibility, d.hypothesis_code, d.hypothesis, d.notes, c.created_at AS since,
            (SELECT x.decision FROM exception_decision x WHERE x.case_id = c.id ORDER BY x.decided_at DESC LIMIT 1) AS decision
       FROM "case" c JOIN entity e ON e.id = c.entity_id JOIN revenue_divergence d ON d.case_id = c.id
      WHERE c.type = 'EXCEPTION' AND c.status NOT IN ('COMPLETED', 'CANCELLED')
      ORDER BY c.id, d.created_at DESC`,
  );
  return rows.sort((a, b) => a.competence.localeCompare(b.competence));
}
