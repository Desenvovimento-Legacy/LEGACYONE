import type { Pool, PoolClient } from "pg";
import { NFSE_TAX_PARSER } from "../../integrations/nfse/nfse-taxes.js";
import { audit } from "../../platform/audit/audit.js";
import { openCase, transitionCase } from "../../platform/cases/case-engine.js";
import { appendEvent, type Producer } from "../../platform/events/outbox.js";
import type { Actor } from "../../shared/actor.js";
import { Dec } from "../../shared/decimal.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { pendingMovements } from "./auto-posting.js";
import { chartConfig } from "./chart-config.js";
import { LedgerError, lockedCompetences, setPeriodLock, trialBalance } from "./ledger.js";

/**
 * Fechamento contábil da competência (Case ACCOUNTING_CLOSING).
 *
 * Conferências determinísticas (revisão independente do que os motores
 * lançaram). As bloqueantes impedem o fechamento; os alertas aparecem mas não
 * travam. Fechar = Case concluído + competência bloqueada no razão (nada mais
 * entra nela; correção só reabrindo, por pessoa, com motivo).
 */

const PRODUCER: Producer = { kind: "engine", name: "ledger", version: "0.1.0" };

export type CheckStatus = "OK" | "PENDENTE" | "ALERTA" | "NAO_SE_APLICA";
export interface ClosingCheck {
  key: string;
  label: string;
  status: CheckStatus;
  blocking: boolean;
  detail: string;
  items?: string[];
}

const mm = (comp: string) => `${comp.slice(5, 7)}/${comp.slice(0, 4)}`;
const monthEnd = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
const brl = (v: string | Dec) => Number(Dec.of(v).toFixed(2)).toLocaleString("pt-BR", { minimumFractionDigits: 2 });
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  while (`${y}-${String(m).padStart(2, "0")}` <= to.slice(0, 7)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

async function chartStart(tx: PoolClient, entityId: string): Promise<string | null> {
  const r = await tx.query<{ d: string | null }>("SELECT min(valid_from)::text AS d FROM chart_account WHERE entity_id = $1 AND source <> 'BANCO'", [entityId]);
  return r.rows[0]?.d ?? null;
}

export interface ClosingStatus {
  month: string;
  start: string | null;
  locked: boolean;
  lockedAt: string | null;
  lockedBy: string | null;
  checks: ClosingCheck[];
  canClose: boolean;
  totals: { debit: string; credit: string; result: string } | null;
}

/** Situação do fechamento de uma competência (AAAA-MM). Não grava nada. */
export async function closingStatus(pool: Pool, tenantId: string, entityId: string, month: string): Promise<ClosingStatus> {
  const from = `${month}-01`;
  const to = monthEnd(month);
  const pendingBank = (await pendingMovements(pool, tenantId, entityId)).filter((p) => p.posted_on >= from && p.posted_on <= to);
  return withTenant(pool, tenantId, async (tx) => {
    const start = await chartStart(tx, entityId);
    const cfg = await chartConfig(tx, entityId);
    const lock = await tx.query<{ status: string; created_at: Date; actor_id: string }>(
      "SELECT status, created_at, actor_id FROM ledger_period_lock WHERE entity_id = $1 AND competence = $2 ORDER BY created_at DESC LIMIT 1",
      [entityId, from],
    );
    const locked = lock.rows[0]?.status === "BLOQUEADO";
    const base = { month, start, locked, lockedAt: locked ? lock.rows[0]!.created_at.toISOString() : null, lockedBy: locked ? lock.rows[0]!.actor_id : null };
    const checks: ClosingCheck[] = [];
    if (!start || from < `${start.slice(0, 7)}-01`) {
      checks.push({ key: "inicio", label: "Início da contabilidade", status: "NAO_SE_APLICA", blocking: true,
        detail: start ? `A contabilidade na IARIS começa em ${mm(start)}` : "A empresa ainda não tem plano de contas" });
      return { ...base, checks, canClose: false, totals: null };
    }

    // 1. Competências anteriores fechadas (fechamento em ordem)
    const lockedSet = await lockedCompetences(tx, entityId);
    const before = monthsBetween(start, from).filter((m) => m < month && !lockedSet.has(`${m}-01`));
    checks.push({ key: "anteriores", label: "Competências anteriores fechadas", status: before.length ? "PENDENTE" : "OK", blocking: true,
      detail: before.length ? `Feche antes: ${before.map((m) => mm(m)).join(", ")}` : "Em ordem" });

    // 2. Partidas dobradas
    const tb = await trialBalance(tx, entityId, from, to);
    checks.push({ key: "partidas", label: "Débitos = créditos", status: tb.totals.balanced ? "OK" : "PENDENTE", blocking: true,
      detail: `Débitos ${brl(tb.totals.debit)} · Créditos ${brl(tb.totals.credit)}` });

    // 3 e 4. Notas do mês contabilizadas
    const notes = await tx.query<{ role: string; n: number; total: string; withheld: number; unread: number }>(
      `WITH cancelled AS (
         SELECT DISTINCT access_key FROM nfse_document
          WHERE entity_id = $1 AND role = 'EVENTO' AND access_key IS NOT NULL
            AND (event_type ILIKE '%101101%' OR event_type ILIKE '%105102%' OR event_type ILIKE '%cancel%'))
       SELECT d.role, count(*)::int AS n, coalesce(sum(d.service_value), 0)::text AS total,
              count(*) FILTER (WHERE t.total_withheld_calc > 0)::int AS withheld, count(*) FILTER (WHERE t.id IS NULL)::int AS unread
         FROM nfse_document d LEFT JOIN nfse_tax t ON t.nfse_id = d.id AND t.parser = $4
        WHERE d.entity_id = $1 AND d.role IN ('PRESTADA', 'TOMADA') AND d.service_value > 0
          AND (d.issued_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2 AND $3
          AND NOT (d.access_key IS NOT NULL AND d.access_key IN (SELECT access_key FROM cancelled))
          AND NOT EXISTS (SELECT 1 FROM journal_entry e WHERE e.idempotency_key IN ('nfse:' || d.id::text, 'nfse-tomada:' || d.id::text))
        GROUP BY d.role`,
      [entityId, from, to, NFSE_TAX_PARSER],
    );
    const out = (role: string) => notes.rows.find((r) => r.role === role);
    const pr = out("PRESTADA");
    checks.push({ key: "nfse_prestadas", label: "NFS-e emitidas contabilizadas", status: pr ? "PENDENTE" : "OK", blocking: true,
      detail: pr
        ? `${pr.n} nota(s) sem lançamento (${brl(pr.total)})${pr.withheld ? `; ${pr.withheld} com retenção do tomador: aprove a regra de receita com retenção` : ""}`
        : "Todas lançadas" });
    const tk = out("TOMADA");
    checks.push({ key: "nfse_tomadas", label: "NFS-e tomadas contabilizadas", status: tk ? "PENDENTE" : "OK", blocking: true,
      detail: tk ? `${tk.n} nota(s) sem lançamento (${brl(tk.total)}): defina a conta do fornecedor ou aprove a tabela${tk.unread ? `; ${tk.unread} ainda sem leitura dos tributos` : ""}` : "Todas lançadas" });

    // 5. Simples Nacional provisionado
    const simples = await tx.query(
      "SELECT 1 FROM tax_regime_history WHERE entity_id = $1 AND regime = 'SIMPLES_NACIONAL' AND valid_from <= $3 AND (valid_to IS NULL OR valid_to >= $2)",
      [entityId, from, to],
    );
    if (simples.rowCount) {
      const rbPrefixes = cfg.dre.find((g) => g.key === "rb")?.include ?? [];
      const revenue = tb.rows.filter((r) => r.analytic && rbPrefixes.some((p) => r.code.startsWith(`${p}.`))).reduce((s, r) => s.add(r.credit).sub(r.debit), Dec.ZERO);
      const prov = await tx.query(
        `SELECT 1 FROM journal_entry e WHERE e.entity_id = $1 AND e.idempotency_key LIKE $2
            AND NOT EXISTS (SELECT 1 FROM journal_entry x WHERE x.reverses_id = e.id)`,
        [entityId, `simples:${month}:%`],
      );
      const need = revenue.gt("0");
      checks.push({ key: "simples", label: "Simples Nacional provisionado", status: !need || prov.rowCount ? "OK" : "PENDENTE", blocking: true,
        detail: !need ? "Sem receita no mês" : prov.rowCount ? "Provisão lançada pela declaração ou pelo cálculo conferido" : "Sem provisão: falta a declaração do PGDAS-D ou o cálculo conferido com o DAS" });
    } else {
      checks.push({ key: "simples", label: "Simples Nacional provisionado", status: "NAO_SE_APLICA", blocking: false, detail: "Empresa fora do Simples no mês" });
    }

    // 6. Extratos de todas as contas cobrindo o mês
    const banks = await tx.query<{ id: string; label: string; code: string | null; first: string | null; last: string | null; mov: string; ledger: string | null }>(
      `SELECT b.id, b.label, c.code,
              (SELECT min(f.period_start)::text FROM bank_statement_file f WHERE f.bank_account_id = b.id) AS first,
              (SELECT max(f.period_end)::text FROM bank_statement_file f WHERE f.bank_account_id = b.id) AS last,
              (SELECT coalesce(sum(t.amount), 0)::text FROM bank_transaction t WHERE t.bank_account_id = b.id AND t.posted_on BETWEEN $2 AND $3) AS mov,
              (SELECT coalesce(sum(l.debit - l.credit), 0)::text FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
                WHERE l.account_id = b.ledger_account_id AND e.entry_date BETWEEN $2 AND $3) AS ledger
         FROM bank_account b LEFT JOIN chart_account c ON c.id = b.ledger_account_id
        WHERE b.entity_id = $1 ORDER BY b.label`,
      [entityId, from, to],
    );
    if (!banks.rows.length) {
      checks.push({ key: "extrato", label: "Extratos bancários do mês", status: "PENDENTE", blocking: true, detail: "Nenhum extrato recebido: envie o OFX de cada conta" });
    } else {
      const missing = banks.rows.filter((b) => !b.first || !b.last || b.first > from || b.last < to);
      checks.push({ key: "extrato", label: "Extratos bancários do mês", status: missing.length ? "PENDENTE" : "OK", blocking: true,
        detail: missing.length ? `Extrato não cobre o mês inteiro em ${missing.length} conta(s)` : `${banks.rows.length} conta(s) com extrato do mês inteiro`,
        items: missing.map((b) => `${b.label}: ${b.first ? `extrato de ${b.first.split("-").reverse().join("/")} a ${b.last!.split("-").reverse().join("/")}` : "sem extrato"}`) });
    }

    // 7. Movimentos do mês classificados
    checks.push({ key: "movimentos", label: "Movimentos bancários lançados", status: pendingBank.length ? "PENDENTE" : "OK", blocking: true,
      detail: pendingBank.length ? `${pendingBank.length} movimento(s) esperando classificação` : "Todos lançados",
      items: pendingBank.slice(0, 10).map((p) => `${p.posted_on.split("-").reverse().join("/")} ${brl(p.amount)} ${[p.memo, p.payee].filter(Boolean).join(" · ")}`) });

    // 8. Banco × razão: movimento do mês no extrato = movimento da conta contábil
    if (banks.rows.length) {
      const diff = banks.rows.filter((b) => Dec.of(b.mov).cmp(b.ledger ?? "0") !== 0);
      checks.push({ key: "banco_razao", label: "Extrato × razão do banco", status: diff.length ? "PENDENTE" : "OK", blocking: true,
        detail: diff.length ? `${diff.length} conta(s) com diferença no mês` : "Movimento do mês igual ao extrato em todas as contas",
        items: diff.map((b) => `${b.label} (${b.code ?? "sem conta"}): extrato ${brl(b.mov)} × razão ${brl(b.ledger ?? "0")}`) });
    }

    // 9. Saldos contra a natureza (alerta, não bloqueia)
    const dedPrefixes = cfg.dre.find((g) => g.key === "ded")?.include ?? [];
    const contra = (code: string, name: string) =>
      name.startsWith("(-)") || code.startsWith("5") || dedPrefixes.some((p) => code.startsWith(`${p}.`)) || code === "2.3.1.02" || code === "2.3.1.03";
    const inverted = tb.rows.filter((r) => {
      if (!r.analytic || contra(r.code, r.name)) return false;
      const bal = Dec.of(r.closing);
      if (bal.isZero()) return false;
      const debitNature = r.code.startsWith("1.") || r.code.startsWith("4.");
      return debitNature ? bal.cmp("0") < 0 : bal.cmp("0") > 0;
    });
    checks.push({ key: "natureza", label: "Saldos de acordo com a natureza", status: inverted.length ? "ALERTA" : "OK", blocking: false,
      detail: inverted.length ? `${inverted.length} conta(s) com saldo invertido (ex.: banco credor, fornecedor devedor)` : "Nenhum saldo invertido",
      items: inverted.slice(0, 15).map((r) => `${r.code} ${r.name}: ${brl(Dec.of(r.closing).cmp("0") < 0 ? Dec.of(r.closing).mul("-1") : r.closing)} ${Dec.of(r.closing).cmp("0") < 0 ? "C" : "D"}`) });

    const result = tb.rows.filter((r) => r.analytic && (r.code.startsWith("3.") || r.code.startsWith("4.") || r.code.startsWith("5.")))
      .reduce((s, r) => s.add(r.credit).sub(r.debit), Dec.ZERO);
    const canClose = !locked && checks.every((c) => !c.blocking || c.status === "OK" || c.status === "NAO_SE_APLICA");
    return { ...base, checks, canClose, totals: { debit: tb.totals.debit, credit: tb.totals.credit, result: result.toFixed(2) } };
  });
}

/** Fecha a competência: Case ACCOUNTING_CLOSING concluído e período bloqueado. Só pessoa. */
export async function closeMonth(pool: Pool, tenantId: string, entityId: string, month: string, actor: Actor) {
  if (actor.kind !== "USER") throw new LedgerError("Fechar competência é decisão de uma pessoa");
  const st = await closingStatus(pool, tenantId, entityId, month);
  if (st.locked) throw new LedgerError(`Competência ${mm(month)} já está fechada`);
  if (!st.canClose) {
    const why = st.checks.filter((c) => c.blocking && c.status !== "OK" && c.status !== "NAO_SE_APLICA").map((c) => `${c.label}: ${c.detail}`);
    throw new LedgerError(`Não dá para fechar ${mm(month)}. ${why.join(" | ")}`);
  }
  const competence = `${month}-01`;
  return withTenant(pool, tenantId, async (tx) => {
    const n = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM ledger_period_lock WHERE entity_id = $1 AND competence = $2", [entityId, competence]);
    const { case: c } = await openCase(tx, {
      type: "ACCOUNTING_CLOSING", entityId, competence: month, origin: "tela", requester: actor.id,
      idempotencyKey: `fechamento:${entityId}:${month}:${n.rows[0]?.n ?? 0}`,
    }, actor);
    await transitionCase(tx, { caseId: c.id, to: "IN_PROGRESS", reason: "fechamento iniciado" }, actor);
    await transitionCase(tx, { caseId: c.id, to: "IN_REVIEW", reason: "conferências do fechamento sem pendência" }, actor);
    await setPeriodLock(tx, entityId, competence, "BLOQUEADO", `fechamento ${mm(month)}`, actor);
    await transitionCase(tx, { caseId: c.id, to: "COMPLETED", reason: `competência ${mm(month)} fechada` }, actor);
    const checks = st.checks.map((x) => ({ key: x.key, status: x.status }));
    await appendEvent(tx, {
      type: "ACCOUNTING_CLOSING_COMPLETED", schemaVersion: 1, producer: PRODUCER, idempotencyKey: `fechamento:${c.id}`, entityId, competence,
      payload: { entity_id: entityId, competence, case_id: c.id, debit: st.totals!.debit, credit: st.totals!.credit, result: st.totals!.result, checks },
    });
    await audit(tx, { actor, action: "ledger.month_closed", resourceType: "case", resourceId: c.id, entityId, competence, caseId: c.id,
      data: { checks: st.checks, totals: st.totals } });
    return { caseId: c.id, month };
  });
}

/** Reabre a competência (só a mais recente fechada). Só pessoa, com motivo. */
export async function reopenMonth(pool: Pool, tenantId: string, entityId: string, month: string, reason: string, actor: Actor) {
  if (actor.kind !== "USER") throw new LedgerError("Só uma pessoa reabre competência");
  if (reason.trim().length < 5) throw new LedgerError("Escreva o motivo da reabertura");
  const competence = `${month}-01`;
  return withTenant(pool, tenantId, async (tx) => {
    const locked = await lockedCompetences(tx, entityId);
    if (!locked.has(competence)) throw new LedgerError(`Competência ${mm(month)} não está fechada`);
    const later = [...locked].filter((c) => c > competence).sort();
    if (later.length) throw new LedgerError(`Reabra antes: ${later.map((c) => mm(c)).join(", ")}`);
    await setPeriodLock(tx, entityId, competence, "REABERTO", reason.trim(), actor);
    await appendEvent(tx, {
      type: "ACCOUNTING_PERIOD_REOPENED", schemaVersion: 1, producer: PRODUCER, idempotencyKey: `reabertura:${entityId}:${month}:${Date.now()}`, entityId, competence,
      payload: { entity_id: entityId, competence, reason: reason.trim(), by: actor.id },
    });
    return { month };
  });
}
