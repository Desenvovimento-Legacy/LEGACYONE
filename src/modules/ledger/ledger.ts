import type { Pool, PoolClient } from "pg";
import { audit } from "../../platform/audit/audit.js";
import { appendEvent, type Producer } from "../../platform/events/outbox.js";
import type { Actor } from "../../shared/actor.js";
import { Dec } from "../../shared/decimal.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";
import { parentOf, STANDARD_CHART, STANDARD_CHART_ID, type Nature } from "./standard-chart.js";

/**
 * One Ledger — razão de partidas dobradas da IARIS.
 *
 * O banco garante débito = crédito, conta analítica vigente, período aberto e
 * imutabilidade (ver 0026). Aqui: resolver contas pelo código na data, não
 * duplicar (chave de idempotência), estornar e montar o balancete.
 * IA não chama postEntry: quem lança são os motores determinísticos com regra.
 */

const PRODUCER: Producer = { kind: "engine", name: "ledger", version: "0.1.0" };

export class LedgerError extends Error {}

export type Origin = "BANCO" | "FISCAL" | "FOLHA" | "TRIBUTOS" | "MIGRACAO" | "MANUAL";

export interface EntryLine {
  account: string;
  debit?: string;
  credit?: string;
  history?: string;
  costCenter?: string;
  dimensions?: Record<string, string>;
}

export interface EntryInput {
  entityId: string;
  date: string;
  history: string;
  origin: Origin;
  originRef?: string | null;
  rule?: string | null;
  confidence?: string | null;
  evidence?: { kind: string; id: string }[];
  idempotencyKey: string;
  lines: EntryLine[];
}

const comp = (d: string) => `${d.slice(0, 7)}-01`;

// ------------------------------------------------------------------ plano de contas

export async function hasChart(tx: PoolClient, entityId: string): Promise<boolean> {
  const r = await tx.query("SELECT 1 FROM chart_account WHERE entity_id = $1 LIMIT 1", [entityId]);
  return Boolean(r.rowCount);
}

/** Aplica o plano padrão (decisão humana). Não faz nada se a empresa já tem plano. */
export async function applyStandardChart(pool: Pool, tenantId: string, entityId: string, validFrom: string, actor: Actor) {
  if (actor.kind !== "USER") throw new LedgerError("Só uma pessoa define o plano de contas da empresa");
  if (!/^\d{4}-\d{2}-01$/.test(validFrom)) throw new LedgerError("Início do plano: primeiro dia do mês (AAAA-MM-01)");
  return withTenant(pool, tenantId, async (tx) => {
    if (await hasChart(tx, entityId)) return { created: 0, already: true };
    // Plano padrão do escritório (modelo importado); sem modelo, o plano embutido.
    const tpl = await tx.query<{ id: string; name: string; config: unknown }>("SELECT id, name, config FROM chart_template ORDER BY imported_at DESC LIMIT 1");
    const t = tpl.rows[0];
    let chart: string;
    let count: number;
    if (t) {
      const accs = await tx.query<{ code: string; short_code: string | null; name: string; nature: Nature; analytic: boolean; parent_code: string | null }>(
        "SELECT code, short_code, name, nature, analytic, parent_code FROM chart_template_account WHERE template_id = $1 ORDER BY code", [t.id]);
      for (const r of accs.rows) {
        await tx.query(
          `INSERT INTO chart_account (id, tenant_id, entity_id, code, short_code, name, nature, analytic, parent_code, valid_from, source, created_by)
           VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, 'PADRAO_ESCRITORIO', $10)`,
          [newId(), entityId, r.code, r.short_code, r.name, r.nature, r.analytic, r.parent_code, validFrom, actor.id],
        );
      }
      await tx.query(
        "INSERT INTO chart_layout (id, tenant_id, entity_id, template_id, config, valid_from, created_by) VALUES ($1, current_tenant(), $2, $3, $4, $5, $6)",
        [newId(), entityId, t.id, JSON.stringify(t.config), validFrom, actor.id],
      );
      chart = `ESCRITORIO:${t.name}`;
      count = accs.rows.length;
    } else {
      for (const r of STANDARD_CHART) {
        await tx.query(
          `INSERT INTO chart_account (id, tenant_id, entity_id, code, name, nature, analytic, parent_code, valid_from, source, created_by)
           VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, 'PADRAO_LEGACY', $9)`,
          [newId(), entityId, r.code, r.name, r.nature, r.analytic, parentOf(r.code), validFrom, actor.id],
        );
      }
      chart = STANDARD_CHART_ID;
      count = STANDARD_CHART.length;
    }
    await appendEvent(tx, {
      type: "CHART_OF_ACCOUNTS_DEFINED",
      schemaVersion: 1,
      producer: PRODUCER,
      idempotencyKey: `plano:${entityId}:${t?.id ?? STANDARD_CHART_ID}`,
      entityId,
      payload: { entity_id: entityId, chart: chart.slice(0, 120), accounts: count, valid_from: validFrom },
    });
    await audit(tx, {
      actor,
      action: "ledger.chart_defined",
      resourceType: "chart_account",
      resourceId: entityId,
      entityId,
      data: { chart, template_id: t?.id ?? null, accounts: count, valid_from: validFrom },
    });
    return { created: count, already: false };
  });
}

interface AccountRow { id: string; code: string; name: string; nature: Nature; analytic: boolean }

async function accountsOn(tx: PoolClient, entityId: string, date: string): Promise<Map<string, AccountRow>> {
  const { rows } = await tx.query<AccountRow>(
    `SELECT id, code, name, nature, analytic FROM chart_account
      WHERE entity_id = $1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to >= $2)`,
    [entityId, date],
  );
  return new Map(rows.map((r) => [r.code, r]));
}

/** Próximo código livre debaixo de uma sintética (ex.: 1.1.1.02 → 1.1.1.02.03). */
export async function nextChildCode(tx: PoolClient, entityId: string, parent: string): Promise<string> {
  const r = await tx.query<{ code: string }>("SELECT code FROM chart_account WHERE entity_id = $1 AND parent_code = $2", [entityId, parent]);
  const tails = r.rows.map((x) => x.code.slice(parent.length + 1));
  const n = tails.map(Number).filter(Number.isFinite);
  // mesma largura das irmãs (ex.: 1.1.1.02.000009 no plano do Domínio); sem irmãs: 6 dígitos se o plano usa 5 níveis
  let width = tails.length ? Math.max(...tails.map((t) => t.length)) : 2;
  if (!tails.length) {
    const w = await tx.query<{ w: number | null }>(
      `SELECT max(length(split_part(code, '.', $2::int + 1)))::int AS w FROM chart_account WHERE entity_id = $1 AND array_length(string_to_array(code, '.'), 1) = $2::int + 1`,
      [entityId, parent.split(".").length],
    );
    width = w.rows[0]?.w ?? 2;
  }
  return `${parent}.${String((n.length ? Math.max(...n) : 0) + 1).padStart(width, "0")}`;
}

export async function addAccount(
  tx: PoolClient,
  input: { entityId: string; parent: string; name: string; validFrom: string; source: "BANCO" | "MANUAL" | "MIGRACAO" },
  actor: Actor,
): Promise<{ id: string; code: string }> {
  const parent = await tx.query<{ nature: Nature; analytic: boolean }>(
    "SELECT nature, analytic FROM chart_account WHERE entity_id = $1 AND code = $2 AND valid_to IS NULL",
    [input.entityId, input.parent],
  );
  const p = parent.rows[0];
  if (!p) throw new LedgerError(`Conta ${input.parent} não existe no plano da empresa`);
  if (p.analytic) throw new LedgerError(`Conta ${input.parent} é analítica: não recebe subconta`);
  const code = await nextChildCode(tx, input.entityId, input.parent);
  const id = newId();
  await tx.query(
    `INSERT INTO chart_account (id, tenant_id, entity_id, code, name, nature, analytic, parent_code, valid_from, source, created_by)
     VALUES ($1, current_tenant(), $2, $3, $4, $5, true, $6, $7, $8, $9)`,
    [id, input.entityId, code, input.name, p.nature, input.parent, input.validFrom, input.source, actor.id],
  );
  await audit(tx, { actor, action: "ledger.account_added", resourceType: "chart_account", resourceId: id, entityId: input.entityId, data: { code, name: input.name } });
  return { id, code };
}

// ------------------------------------------------------------------ lançamentos

export interface PostResult { id: string; created: boolean }

/** opts.event = false: quem chama emite um evento de lote (ex.: contabilização automática). */
export async function postEntry(tx: PoolClient, input: EntryInput, actor: Actor, opts: { event?: boolean } = {}): Promise<PostResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new LedgerError("Data do lançamento inválida");
  if (input.lines.length < 2) throw new LedgerError("Lançamento precisa de débito e crédito");
  let d = Dec.ZERO;
  let c = Dec.ZERO;
  for (const l of input.lines) {
    const dv = l.debit ? Dec.of(l.debit) : Dec.ZERO;
    const cv = l.credit ? Dec.of(l.credit) : Dec.ZERO;
    if (dv.gt("0") === cv.gt("0") || dv.cmp("0") < 0 || cv.cmp("0") < 0) throw new LedgerError(`Linha da conta ${l.account}: informe só débito ou só crédito, positivo`);
    if (dv.round(2).cmp(dv) !== 0 || cv.round(2).cmp(cv) !== 0) throw new LedgerError(`Linha da conta ${l.account}: valor com mais de 2 casas`);
    d = d.add(dv);
    c = c.add(cv);
  }
  if (d.cmp(c) !== 0) throw new LedgerError(`Débitos (${d.toFixed(2)}) diferentes dos créditos (${c.toFixed(2)})`);

  const existing = await tx.query<{ id: string }>("SELECT id FROM journal_entry WHERE idempotency_key = $1", [input.idempotencyKey]);
  if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
  await assertOpen(tx, input.entityId, comp(input.date));

  const accounts = await accountsOn(tx, input.entityId, input.date);
  const resolved = input.lines.map((l) => {
    const a = accounts.get(l.account);
    if (!a) throw new LedgerError(`Conta ${l.account} não existe (ou não vigente) no plano da empresa em ${input.date}`);
    if (!a.analytic) throw new LedgerError(`Conta ${l.account} é sintética`);
    return { ...l, accountId: a.id };
  });

  const id = newId();
  await tx.query(
    `INSERT INTO journal_entry (id, tenant_id, entity_id, competence, entry_date, history, origin, origin_ref, rule_ref, actor_kind, actor_id,
                                confidence, evidence, idempotency_key)
     VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [id, input.entityId, comp(input.date), input.date, input.history, input.origin, input.originRef ?? null, input.rule ?? null, actor.kind, actor.id,
      input.confidence ?? null, JSON.stringify(input.evidence ?? []), input.idempotencyKey],
  );
  let seq = 0;
  for (const l of resolved) {
    await tx.query(
      `INSERT INTO journal_line (id, tenant_id, entity_id, entry_id, seq, account_id, debit, credit, history, cost_center, dimensions)
       VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [newId(), input.entityId, id, ++seq, l.accountId, l.debit ?? "0", l.credit ?? "0", l.history ?? null, l.costCenter ?? null, JSON.stringify(l.dimensions ?? {})],
    );
  }
  if (opts.event !== false) await appendEvent(tx, {
    type: "ACCOUNTING_POSTING_CREATED",
    schemaVersion: 1,
    producer: PRODUCER,
    idempotencyKey: `lancamento:${id}`,
    entityId: input.entityId,
    competence: comp(input.date),
    payload: {
      entity_id: input.entityId, entry_id: id, date: input.date, origin: input.origin, total: d.toFixed(2),
      accounts: input.lines.map((l) => l.account), rule: input.rule ?? null,
    },
  });
  await audit(tx, {
    actor,
    action: "ledger.entry_posted",
    resourceType: "journal_entry",
    resourceId: id,
    entityId: input.entityId,
    competence: comp(input.date),
    ruleRef: input.rule ?? undefined,
    data: { origin: input.origin, origin_ref: input.originRef ?? null, total: d.toFixed(2), lines: input.lines, evidence: input.evidence ?? [] },
  });
  return { id, created: true };
}

/** Estorno: lançamento inverso, ligado ao original. Data padrão: a do original. */
export async function reverseEntry(tx: PoolClient, entryId: string, reason: string, actor: Actor, date?: string): Promise<PostResult> {
  const e = await tx.query<{ entity_id: string; entry_date: string; history: string }>(
    "SELECT entity_id, entry_date::text, history FROM journal_entry WHERE id = $1",
    [entryId],
  );
  const orig = e.rows[0];
  if (!orig) throw new LedgerError("Lançamento não encontrado");
  const done = await tx.query<{ id: string }>("SELECT id FROM journal_entry WHERE reverses_id = $1", [entryId]);
  if (done.rows[0]) return { id: done.rows[0].id, created: false };
  if (!reason.trim()) throw new LedgerError("Informe o motivo do estorno");
  const lines = await tx.query<{ account_id: string; debit: string; credit: string; history: string | null; cost_center: string | null; dimensions: Record<string, string> }>(
    "SELECT account_id, debit::text, credit::text, history, cost_center, dimensions FROM journal_line WHERE entry_id = $1 ORDER BY seq",
    [entryId],
  );
  const when = date ?? orig.entry_date;
  await assertOpen(tx, orig.entity_id, comp(when));
  const id = newId();
  await tx.query(
    `INSERT INTO journal_entry (id, tenant_id, entity_id, competence, entry_date, history, origin, origin_ref, actor_kind, actor_id, evidence, reverses_id, idempotency_key)
     VALUES ($1, current_tenant(), $2, $3, $4, $5, 'ESTORNO', $6, $7, $8, $9, $10, $11)`,
    [id, orig.entity_id, comp(when), when, `Estorno: ${orig.history} — ${reason}`, entryId, actor.kind, actor.id,
      JSON.stringify([{ kind: "journal_entry", id: entryId }]), entryId, `estorno:${entryId}`],
  );
  let seq = 0;
  for (const l of lines.rows) {
    await tx.query(
      `INSERT INTO journal_line (id, tenant_id, entity_id, entry_id, seq, account_id, debit, credit, history, cost_center, dimensions)
       VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [newId(), orig.entity_id, id, ++seq, l.account_id, l.credit, l.debit, l.history, l.cost_center, JSON.stringify(l.dimensions)],
    );
  }
  await appendEvent(tx, {
    type: "ACCOUNTING_POSTING_REVERSED",
    schemaVersion: 1,
    producer: PRODUCER,
    idempotencyKey: `estorno:${entryId}`,
    entityId: orig.entity_id,
    competence: comp(when),
    payload: { entity_id: orig.entity_id, entry_id: entryId, reversal_id: id, date: when, reason },
  });
  await audit(tx, { actor, action: "ledger.entry_reversed", resourceType: "journal_entry", resourceId: id, entityId: orig.entity_id, data: { reverses: entryId, reason } });
  return { id, created: true };
}

/** Competência fechada: lançamento novo ou estorno nela só depois de reabrir. */
export class PeriodClosedError extends LedgerError {}

/** Competências (AAAA-MM-01) fechadas da empresa (último registro = BLOQUEADO). */
export async function lockedCompetences(tx: PoolClient, entityId: string): Promise<Set<string>> {
  const { rows } = await tx.query<{ competence: string }>(
    `SELECT competence::text FROM (
       SELECT DISTINCT ON (competence) competence, status FROM ledger_period_lock WHERE entity_id = $1 ORDER BY competence, created_at DESC) x
      WHERE status = 'BLOQUEADO'`,
    [entityId],
  );
  return new Set(rows.map((r) => r.competence));
}

async function assertOpen(tx: PoolClient, entityId: string, competence: string) {
  const r = await tx.query<{ status: string }>(
    "SELECT status FROM ledger_period_lock WHERE entity_id = $1 AND competence = $2 ORDER BY created_at DESC LIMIT 1",
    [entityId, competence],
  );
  if (r.rows[0]?.status === "BLOQUEADO") {
    throw new PeriodClosedError(`Competência ${competence.slice(5, 7)}/${competence.slice(0, 4)} fechada: reabra antes de lançar`);
  }
}

/**
 * Contas novas do plano padrão (versão nova da proposta) entram no plano da
 * empresa que já usa o padrão, com a mesma vigência. Nada é alterado nem apagado.
 */
export async function ensureStandardAccounts(tx: PoolClient, entityId: string, actor: Actor): Promise<string[]> {
  const cur = await tx.query<{ code: string; valid_from: string }>(
    "SELECT code, valid_from::text FROM chart_account WHERE entity_id = $1 AND source = 'PADRAO_LEGACY'",
    [entityId],
  );
  if (!cur.rows.length) return [];
  const have = new Set(cur.rows.map((r) => r.code));
  const from = cur.rows.map((r) => r.valid_from).sort()[0]!;
  const added: string[] = [];
  for (const r of STANDARD_CHART) {
    if (have.has(r.code)) continue;
    await tx.query(
      `INSERT INTO chart_account (id, tenant_id, entity_id, code, name, nature, analytic, parent_code, valid_from, source, created_by)
       VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, 'PADRAO_LEGACY', $9)`,
      [newId(), entityId, r.code, r.name, r.nature, r.analytic, parentOf(r.code), from, actor.id],
    );
    added.push(r.code);
  }
  if (added.length) {
    await audit(tx, { actor, action: "ledger.chart_extended", resourceType: "chart_account", resourceId: entityId, entityId, data: { chart: STANDARD_CHART_ID, added } });
  }
  return added;
}

/** Bloqueia ou reabre a competência (reabrir: só pessoa). */
export async function setPeriodLock(tx: PoolClient, entityId: string, competence: string, status: "BLOQUEADO" | "REABERTO", reason: string, actor: Actor) {
  if (status === "REABERTO" && actor.kind !== "USER") throw new LedgerError("Só uma pessoa reabre período");
  await tx.query(
    "INSERT INTO ledger_period_lock (id, tenant_id, entity_id, competence, status, reason, actor_id) VALUES ($1, current_tenant(), $2, $3, $4, $5, $6)",
    [newId(), entityId, competence, status, reason, actor.id],
  );
  await audit(tx, { actor, action: status === "BLOQUEADO" ? "ledger.period_locked" : "ledger.period_reopened", resourceType: "ledger_period_lock", resourceId: entityId, entityId, competence, data: { reason } });
}

// ------------------------------------------------------------------ balancete

export interface TrialRow {
  code: string;
  name: string;
  nature: Nature;
  analytic: boolean;
  level: number;
  opening: string;
  debit: string;
  credit: string;
  closing: string;
}

/** Saldos com sinal devedor positivo (crédito negativo). Sintéticas somam as filhas. */
export async function trialBalance(tx: PoolClient, entityId: string, from: string, to: string) {
  const accounts = await tx.query<{ id: string; code: string; name: string; nature: Nature; analytic: boolean }>(
    `SELECT DISTINCT ON (code) id, code, name, nature, analytic FROM chart_account
      WHERE entity_id = $1 AND valid_from <= $3 AND (valid_to IS NULL OR valid_to >= $2)
      ORDER BY code, valid_from DESC`,
    [entityId, from, to],
  );
  const mov = await tx.query<{ code: string; opening: string; debit: string; credit: string }>(
    `SELECT a.code,
            coalesce(sum(l.debit - l.credit) FILTER (WHERE e.entry_date < $2), 0)::text AS opening,
            coalesce(sum(l.debit) FILTER (WHERE e.entry_date BETWEEN $2 AND $3), 0)::text AS debit,
            coalesce(sum(l.credit) FILTER (WHERE e.entry_date BETWEEN $2 AND $3), 0)::text AS credit
       FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN chart_account a ON a.id = l.account_id
      WHERE l.entity_id = $1 AND e.entry_date <= $3
      GROUP BY a.code`,
    [entityId, from, to],
  );
  const byCode = new Map(mov.rows.map((m) => [m.code, m]));
  const rows: TrialRow[] = [];
  let totD = Dec.ZERO;
  let totC = Dec.ZERO;
  for (const a of accounts.rows) {
    let o = Dec.ZERO, dd = Dec.ZERO, cc = Dec.ZERO;
    for (const [code, m] of byCode) {
      if (code === a.code || code.startsWith(`${a.code}.`)) {
        o = o.add(m.opening);
        dd = dd.add(m.debit);
        cc = cc.add(m.credit);
      }
    }
    if (a.analytic) {
      totD = totD.add(dd);
      totC = totC.add(cc);
    }
    if (o.isZero() && dd.isZero() && cc.isZero()) continue;
    rows.push({
      code: a.code, name: a.name, nature: a.nature, analytic: a.analytic, level: a.code.split(".").length,
      opening: o.toFixed(2), debit: dd.toFixed(2), credit: cc.toFixed(2), closing: o.add(dd).sub(cc).toFixed(2),
    });
  }
  return { from, to, rows, totals: { debit: totD.toFixed(2), credit: totC.toFixed(2), balanced: totD.cmp(totC) === 0 } };
}
