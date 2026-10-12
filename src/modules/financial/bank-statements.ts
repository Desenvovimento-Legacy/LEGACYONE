import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { bankName, decodeOfx, OfxError, parseOfx, type OfxStatement } from "../../integrations/bank/ofx.js";
import { parsePdfStatement, parseTabular, readCsvRows, StatementTextError } from "../../integrations/bank/statement-text.js";
import { isXlsx, readXlsxRows, XlsxError } from "../../integrations/bank/xlsx.js";
import { pdfText } from "../ledger/opening-balances.js";
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
 * Recebe o arquivo (OFX, Excel .xlsx, CSV ou PDF do internet banking), guarda
 * o original com SHA-256, identifica a conta (banco, agência, conta — do
 * arquivo ou informada por quem envia), grava cada movimento uma vez só e, se
 * a empresa já tem plano de contas, cria a conta contábil do banco.
 *
 * Uma vez só: OFX pelo FITID; nos outros formatos pela data + valor + ordem no
 * dia. E entre formatos: se a conta já tem N movimentos daquele valor naquele
 * dia (de outro arquivo), os N primeiros do arquivo novo são repetidos — o mesmo
 * mês mandado em PDF e depois em OFX não duplica.
 * PDF só entra com o saldo fechando (ver statement-text.ts).
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

export type StatementFormat = "OFX" | "CSV" | "XLSX" | "PDF";
/** Conta do extrato quando o arquivo não diz: uma conta já cadastrada ou banco/agência/conta. */
export type StatementAccount = { id: string } | { bank: string; branch: string; number: string };

/** Lê o arquivo em qualquer formato aceito (não grava nada). */
export async function readStatementFile(file: { name: string; bytes: Buffer }): Promise<OfxStatement & { format: StatementFormat; proof?: string }> {
  if (file.bytes.length > MAX_STATEMENT_BYTES) throw new StatementError("Extrato acima de 10 MB");
  const head = file.bytes.subarray(0, 8);
  try {
    if (head.subarray(0, 4).toString("latin1") === "%PDF") {
      const text = await pdfText(file.bytes).catch(() => { throw new StatementError("PDF ilegível ou protegido por senha"); });
      if (!text.trim()) throw new StatementError("PDF sem texto (imagem escaneada): envie o OFX ou o Excel do internet banking");
      return parsePdfStatement(text);
    }
    if (head[0] === 0xd0 && head[1] === 0xcf) throw new StatementError("Planilha .xls antiga: salve como .xlsx ou .csv e envie de novo");
    if (isXlsx(file.bytes)) return parseTabular(readXlsxRows(file.bytes), "XLSX");
    const text = decodeOfx(file.bytes);
    if (/<OFX>/i.test(text)) return { ...parseOfx(text), format: "OFX" };
    const utf = file.bytes.toString("utf8");
    return parseTabular(readCsvRows(utf.includes("\uFFFD") ? file.bytes.toString("latin1") : utf), "CSV");
  } catch (err) {
    if (err instanceof OfxError || err instanceof StatementTextError || err instanceof XlsxError) throw new StatementError(err.message);
    throw err;
  }
}

export async function importBankStatement(
  pool: Pool,
  tenantId: string,
  entityId: string,
  file: { name: string; bytes: Buffer },
  actor: Actor,
  opts: { account?: StatementAccount } = {},
): Promise<StatementResult> {
  const st = await readStatementFile(file);
  const sha = createHash("sha256").update(file.bytes).digest();

  return withTenant(pool, tenantId, async (tx) => {
    const first = st.transactions.map((t) => t.postedOn).sort()[0] ?? st.periodStart ?? new Date().toISOString().slice(0, 10);
    let acc: { id: string; label: string; ledgerCode: string | null };
    if (opts.account && "id" in opts.account) {
      const r = await tx.query<{ bank_code: string; branch: string; number: string }>("SELECT bank_code, branch, number FROM bank_account WHERE id = $1 AND entity_id = $2", [opts.account.id, entityId]);
      const b = r.rows[0];
      if (!b) throw new StatementError("Conta bancária não encontrada nesta empresa");
      acc = await ensureBankAccount(tx, entityId, b.bank_code, b.branch, b.number, first, actor);
    } else {
      const given = opts.account && "bank" in opts.account ? opts.account : null;
      const bankRaw = digits(given?.bank ?? null) || digits(st.bankCode);
      const number = (given?.number ?? st.account ?? "").replace(/\s/g, "");
      if (!bankRaw || !number) {
        throw new StatementError(st.format === "OFX" ? "OFX sem identificação da conta" : "O arquivo não traz banco e conta: escolha a conta (ou informe banco, agência e conta) e envie de novo");
      }
      acc = await ensureBankAccount(tx, entityId, bankRaw.padStart(3, "0").slice(-3), digits(given?.branch ?? null) || digits(st.branch), number, first, actor);
    }
    const base = {
      bankAccountId: acc.id, account: acc.label, periodStart: st.periodStart, periodEnd: st.periodEnd, balance: st.balance, ledgerAccount: acc.ledgerCode,
    };
    const dup = await tx.query("SELECT 1 FROM bank_statement_file WHERE entity_id = $1 AND sha256 = $2", [entityId, sha]);
    if (dup.rowCount) return { ...base, status: "REPETIDO", transactions: 0, duplicated: st.transactions.length };

    const fileId = newId();
    await tx.query(
      `INSERT INTO bank_statement_file (id, tenant_id, entity_id, bank_account_id, format, file_name, content, sha256, period_start, period_end,
                                        balance, balance_date, transactions, received_by)
       VALUES ($1, current_tenant(), $2, $3, $13, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [fileId, entityId, acc.id, file.name.slice(0, 200), file.bytes, sha, st.periodStart, st.periodEnd, st.balance, st.balanceDate, st.transactions.length, actor.id, st.format],
    );
    const seen = new Map<string, number>();
    const sameDay = new Map<string, number>();
    const existing = new Map<string, number>();
    for (const r of (await tx.query<{ k: string; n: number }>(
      "SELECT posted_on::text || '|' || amount::text AS k, count(*)::int AS n FROM bank_transaction WHERE bank_account_id = $1 AND posted_on BETWEEN $2 AND $3 GROUP BY 1",
      [acc.id, first, st.transactions.map((t) => t.postedOn).sort().pop() ?? first],
    )).rows) existing.set(r.k, r.n);
    let inserted = 0;
    for (const t of st.transactions) {
      // mesmo dia e valor já gravados por outro arquivo (outro formato): repetido
      const dv = `${t.postedOn}|${t.amount}`;
      const nth = (sameDay.get(dv) ?? 0) + 1;
      sameDay.set(dv, nth);
      if (st.format !== "OFX" && nth <= (existing.get(dv) ?? 0)) continue;
      let key: string;
      if (t.fitId) key = `fit:${t.fitId}:${t.postedOn}:${t.amount}`;
      else if (st.format !== "OFX") key = `v:${dv}|${nth}`;
      else {
        const k = `${t.postedOn}|${t.amount}|${(t.memo ?? "").toUpperCase()}`;
        const n = (seen.get(k) ?? 0) + 1;
        seen.set(k, n);
        key = `h:${createHash("sha256").update(`${k}|${n}`).digest("hex").slice(0, 32)}`;
      }
      if (st.format === "OFX" && nth <= (existing.get(dv) ?? 0)) {
        // OFX depois de PDF/planilha do mesmo período: o FITID é novo, mas o movimento já está gravado
        const prior = await tx.query("SELECT 1 FROM bank_transaction WHERE bank_account_id = $1 AND posted_on = $2 AND amount = $3 AND dedupe_key NOT LIKE 'fit:%' LIMIT 1", [acc.id, t.postedOn, t.amount]);
        if (prior.rowCount) continue;
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
      data: { account: acc.label, format: st.format, proof: "proof" in st ? st.proof : null, transactions: inserted, duplicated, period: [st.periodStart, st.periodEnd], sha256: sha.toString("hex") },
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
