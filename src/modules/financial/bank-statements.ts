import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { bankName, decodeOfx, OfxError, parseOfx } from "../../integrations/bank/ofx.js";
import { audit } from "../../platform/audit/audit.js";
import { appendEvent, type Producer } from "../../platform/events/outbox.js";
import type { Actor } from "../../shared/actor.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";
import { chartConfig, roleAccount } from "../ledger/chart-config.js";
import { addAccount, hasChart } from "../ledger/ledger.js";

/**
 * Agente Financeiro — extrato bancário.
 *
 * Recebe o arquivo (OFX), guarda o original com SHA-256, identifica a conta
 * (banco, agência, conta), grava cada movimento uma vez só (FITID + data +
 * valor; sem FITID, data + valor + histórico + ordem no dia) e, se a empresa
 * já tem plano de contas, cria a conta contábil do banco (1.1.1.02.NN).
 */

const PRODUCER: Producer = { kind: "agent", name: "financial", version: "0.1.0" };
export const MAX_STATEMENT_BYTES = 10 * 1024 * 1024;

export class StatementError extends Error {}

export interface StatementResult {
  status: "IMPORTADO" | "REPETIDO";
  bankAccountId: string;
  account: string;
  transactions: number;
  duplicated: number;
  periodStart: string | null;
  periodEnd: string | null;
  balance: string | null;
  ledgerAccount: string | null;
}

const digits = (s: string | null) => (s ?? "").replace(/\D/g, "");

async function ensureBankAccount(tx: PoolClient, entityId: string, bank: string, branch: string, number: string, validFrom: string, actor: Actor) {
  const label = `${bankName(bank)}${branch ? ` ag ${branch}` : ""} cc ${number}`;
  await tx.query(
    `INSERT INTO bank_account (id, tenant_id, entity_id, bank_code, branch, number, label)
     VALUES ($1, current_tenant(), $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, entity_id, bank_code, branch, number) DO NOTHING`,
    [newId(), entityId, bank, branch, number, label],
  );
  const r = await tx.query<{ id: string; label: string; ledger_account_id: string | null }>(
    "SELECT id, label, ledger_account_id FROM bank_account WHERE entity_id = $1 AND bank_code = $2 AND branch = $3 AND number = $4",
    [entityId, bank, branch, number],
  );
  const acc = r.rows[0]!;
  let ledgerCode: string | null = null;
  if (acc.ledger_account_id) {
    const c = await tx.query<{ code: string }>("SELECT code FROM chart_account WHERE id = $1", [acc.ledger_account_id]);
    ledgerCode = c.rows[0]?.code ?? null;
  } else if (await hasChart(tx, entityId)) {
    const from = await tx.query<{ d: string }>("SELECT min(valid_from)::text AS d FROM chart_account WHERE entity_id = $1", [entityId]);
    const start = [from.rows[0]!.d, `${validFrom.slice(0, 7)}-01`].sort()[0]!;
    const parent = roleAccount(await chartConfig(tx, entityId), "BANCOS");
    const a = await addAccount(tx, { entityId, parent, name: acc.label, validFrom: start, source: "BANCO" }, actor);
    await tx.query("UPDATE bank_account SET ledger_account_id = $1 WHERE id = $2", [a.id, acc.id]);
    ledgerCode = a.code;
  }
  return { id: acc.id, label: acc.label, ledgerCode };
}

export async function importBankStatement(
  pool: Pool,
  tenantId: string,
  entityId: string,
  file: { name: string; bytes: Buffer },
  actor: Actor,
): Promise<StatementResult> {
  if (file.bytes.length > MAX_STATEMENT_BYTES) throw new StatementError("Extrato acima de 10 MB");
  const text = decodeOfx(file.bytes);
  if (!/<OFX>/i.test(text)) throw new StatementError("Formato ainda não aceito: envie o extrato em OFX (PDF, Excel e CSV vêm a seguir)");
  let st;
  try {
    st = parseOfx(text);
  } catch (err) {
    if (err instanceof OfxError) throw new StatementError(err.message);
    throw err;
  }
  const bank = digits(st.bankCode).padStart(3, "0").slice(-3) || "000";
  const branch = digits(st.branch);
  const number = st.account.replace(/\s/g, "");
  const sha = createHash("sha256").update(file.bytes).digest();

  return withTenant(pool, tenantId, async (tx) => {
    const first = st.transactions.map((t) => t.postedOn).sort()[0] ?? st.periodStart ?? new Date().toISOString().slice(0, 10);
    const acc = await ensureBankAccount(tx, entityId, bank, branch, number, first, actor);
    const base = {
      bankAccountId: acc.id, account: acc.label, periodStart: st.periodStart, periodEnd: st.periodEnd, balance: st.balance, ledgerAccount: acc.ledgerCode,
    };
    const dup = await tx.query("SELECT 1 FROM bank_statement_file WHERE entity_id = $1 AND sha256 = $2", [entityId, sha]);
    if (dup.rowCount) return { ...base, status: "REPETIDO", transactions: 0, duplicated: st.transactions.length };

    const fileId = newId();
    await tx.query(
      `INSERT INTO bank_statement_file (id, tenant_id, entity_id, bank_account_id, format, file_name, content, sha256, period_start, period_end,
                                        balance, balance_date, transactions, received_by)
       VALUES ($1, current_tenant(), $2, $3, 'OFX', $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [fileId, entityId, acc.id, file.name.slice(0, 200), file.bytes, sha, st.periodStart, st.periodEnd, st.balance, st.balanceDate, st.transactions.length, actor.id],
    );
    const seen = new Map<string, number>();
    let inserted = 0;
    for (const t of st.transactions) {
      let key: string;
      if (t.fitId) key = `fit:${t.fitId}:${t.postedOn}:${t.amount}`;
      else {
        const k = `${t.postedOn}|${t.amount}|${(t.memo ?? "").toUpperCase()}`;
        const n = (seen.get(k) ?? 0) + 1;
        seen.set(k, n);
        key = `h:${createHash("sha256").update(`${k}|${n}`).digest("hex").slice(0, 32)}`;
      }
      const ins = await tx.query(
        `INSERT INTO bank_transaction (id, tenant_id, entity_id, bank_account_id, file_id, posted_on, amount, trn_type, fit_id, check_number, memo, payee, dedupe_key)
         VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (tenant_id, bank_account_id, dedupe_key) DO NOTHING`,
        [newId(), entityId, acc.id, fileId, t.postedOn, t.amount, t.type, t.fitId, t.checkNumber, t.memo, t.payee, key],
      );
      inserted += ins.rowCount ?? 0;
    }
    const duplicated = st.transactions.length - inserted;
    if (inserted) {
      await appendEvent(tx, {
        type: "BANK_STATEMENT_RECEIVED",
        schemaVersion: 1,
        producer: PRODUCER,
        idempotencyKey: `extrato:${fileId}`,
        entityId,
        payload: {
          entity_id: entityId, bank_account_id: acc.id, account: acc.label, transactions: inserted, duplicated,
          period_start: st.periodStart, period_end: st.periodEnd, balance: st.balance,
        },
      });
    }
    await audit(tx, {
      actor,
      action: "financial.statement_imported",
      resourceType: "bank_statement_file",
      resourceId: fileId,
      entityId,
      data: { account: acc.label, transactions: inserted, duplicated, period: [st.periodStart, st.periodEnd], sha256: sha.toString("hex") },
      evidenceRefs: [`bank_statement_file:${fileId}`],
    });
    return { ...base, status: "IMPORTADO", transactions: inserted, duplicated };
  });
}

/** Contas e movimentos (para a tela). */
export async function bankOverview(tx: PoolClient, entityId: string) {
  const accounts = await tx.query(
    `SELECT b.id, b.label, b.bank_code, b.branch, b.number, c.code AS ledger_code,
            (SELECT count(*)::int FROM bank_transaction t WHERE t.bank_account_id = b.id) AS transactions,
            (SELECT min(posted_on)::text FROM bank_transaction t WHERE t.bank_account_id = b.id) AS first_on,
            (SELECT max(posted_on)::text FROM bank_transaction t WHERE t.bank_account_id = b.id) AS last_on,
            (SELECT f.balance::text FROM bank_statement_file f WHERE f.bank_account_id = b.id ORDER BY f.balance_date DESC NULLS LAST, f.received_at DESC LIMIT 1) AS balance,
            (SELECT f.balance_date::text FROM bank_statement_file f WHERE f.bank_account_id = b.id ORDER BY f.balance_date DESC NULLS LAST, f.received_at DESC LIMIT 1) AS balance_date
       FROM bank_account b LEFT JOIN chart_account c ON c.id = b.ledger_account_id
      WHERE b.entity_id = $1 ORDER BY b.label`,
    [entityId],
  );
  return { accounts: accounts.rows };
}
