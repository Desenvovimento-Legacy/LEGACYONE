import { describe, expect, it } from "vitest";
import { ofxAmount, ofxDate, parseOfx } from "../src/integrations/bank/ofx.js";
import { bankOverview, importBankStatement, StatementError } from "../src/modules/financial/bank-statements.js";
import { applyStandardChart, LedgerError, postEntry, reverseEntry, setPeriodLock, trialBalance } from "../src/modules/ledger/ledger.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const LUAN: Actor = { kind: "USER", id: "luan@legacy.test" };
const ENGINE: Actor = { kind: "AGENT", id: "ledger" };

// OFX 1.02 (SGML) no jeito dos bancos brasileiros: sem fechar tags, latin1, vírgula, fuso.
const ofxSgml = (extra = "") => Buffer.from(
  `OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102\r\nSECURITY:NONE\r\nENCODING:USASCII\r\nCHARSET:1252\r\n\r\n` +
  `<OFX>\r\n<BANKMSGSRSV1>\r\n<STMTTRNRS>\r\n<STMTRS>\r\n<CURDEF>BRL\r\n<BANKACCTFROM>\r\n<BANKID>0341\r\n<BRANCHID>6157\r\n<ACCTID>74251-8\r\n<ACCTTYPE>CHECKING\r\n</BANKACCTFROM>\r\n` +
  `<BANKTRANLIST>\r\n<DTSTART>20260901000000[-3:BRT]\r\n<DTEND>20260930000000[-3:BRT]\r\n` +
  `<STMTTRN>\r\n<TRNTYPE>CREDIT\r\n<DTPOSTED>20260905120000[-3:BRT]\r\n<TRNAMT>15.000,00\r\n<FITID>A001\r\n<MEMO>PIX RECEBIDO CLIENTE ALFA\r\n</STMTTRN>\r\n` +
  `<STMTTRN>\r\n<TRNTYPE>DEBIT\r\n<DTPOSTED>20260910\r\n<TRNAMT>-12450.00\r\n<FITID>A002\r\n<MEMO>PAGTO CONTA ENERGIA ELÉTRICA\r\n</STMTTRN>\r\n` +
  `<STMTTRN>\r\n<TRNTYPE>DEBIT\r\n<DTPOSTED>20260930\r\n<TRNAMT>-35,90\r\n<MEMO>TARIFA PACOTE SERVIÇOS\r\n</STMTTRN>\r\n` +
  `<STMTTRN>\r\n<TRNTYPE>DEBIT\r\n<DTPOSTED>20260930\r\n<TRNAMT>-35,90\r\n<MEMO>TARIFA PACOTE SERVIÇOS\r\n</STMTTRN>\r\n` +
  extra +
  `</BANKTRANLIST>\r\n<LEDGERBAL>\r\n<BALAMT>2478,20\r\n<DTASOF>20260930\r\n</LEDGERBAL>\r\n</STMTRS>\r\n</STMTTRNRS>\r\n</BANKMSGSRSV1>\r\n</OFX>\r\n`,
  "latin1",
);

const ofxXml = `<?xml version="1.0" encoding="UTF-8"?><?OFX OFXHEADER="200" VERSION="211"?><OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL</CURDEF>
<BANKACCTFROM><BANKID>756</BANKID><ACCTID>12345-6</ACCTID></BANKACCTFROM><BANKTRANLIST><DTSTART>20260801</DTSTART><DTEND>20260831</DTEND>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260820100000</DTPOSTED><TRNAMT>-1099.10</TRNAMT><FITID>X1</FITID><MEMO>DARF &amp; GPS</MEMO></STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>100.00</BALAMT><DTASOF>20260831</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

describe("extrato OFX: leitura determinística", () => {
  it("OFX 1.x SGML (latin1, vírgula, fuso) e 2.x XML", () => {
    expect(ofxAmount("15.000,00")).toBe("15000.00");
    expect(ofxAmount("-35,9")).toBe("-35.90");
    expect(ofxAmount("1,234.56")).toBe("1234.56");
    expect(ofxAmount("abc")).toBeNull();
    expect(ofxDate("20260905120000[-3:BRT]")).toBe("2026-09-05");
    const s = parseOfx(ofxSgml().toString("latin1"));
    expect(s).toMatchObject({ bankCode: "0341", branch: "6157", account: "74251-8", periodStart: "2026-09-01", periodEnd: "2026-09-30", balance: "2478.20", balanceDate: "2026-09-30" });
    expect(s.transactions.map((t) => [t.postedOn, t.amount, t.fitId])).toEqual([
      ["2026-09-05", "15000.00", "A001"], ["2026-09-10", "-12450.00", "A002"], ["2026-09-30", "-35.90", null], ["2026-09-30", "-35.90", null],
    ]);
    expect(s.transactions[1]!.memo).toBe("PAGTO CONTA ENERGIA ELÉTRICA");
    const x = parseOfx(ofxXml);
    expect(x).toMatchObject({ bankCode: "756", branch: null, account: "12345-6", balance: "100.00" });
    expect(x.transactions[0]).toMatchObject({ amount: "-1099.10", memo: "DARF & GPS" });
    expect(() => parseOfx("não é ofx")).toThrow(/OFX/);
  });
});

describe("One Ledger: partidas dobradas", () => {
  it("lança, não duplica, estorna, bloqueia período e o banco recusa o que não fecha", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    await expect(applyStandardChart(appPool, t, entityId, "2026-09-01", ENGINE)).rejects.toThrow(LedgerError);
    expect(await applyStandardChart(appPool, t, entityId, "2026-09-01", LUAN)).toMatchObject({ already: false });
    expect(await applyStandardChart(appPool, t, entityId, "2026-09-01", LUAN)).toMatchObject({ created: 0, already: true });

    const energia = {
      entityId, date: "2026-09-10", history: "Conta de energia 09/2026", origin: "FISCAL" as const, rule: "teste@1",
      idempotencyKey: "energia:2026-09", evidence: [{ kind: "documento", id: "x" }],
      lines: [{ account: "4.3.1.02", debit: "12450.00" }, { account: "2.1.1.01", credit: "12450.00" }],
    };
    const e1 = await withTenant(appPool, t, (tx) => postEntry(tx, energia, ENGINE));
    expect(e1.created).toBe(true);
    expect(await withTenant(appPool, t, (tx) => postEntry(tx, energia, ENGINE))).toEqual({ id: e1.id, created: false });

    // Código barra antes de chegar ao banco
    await expect(withTenant(appPool, t, (tx) => postEntry(tx, { ...energia, idempotencyKey: "x1", lines: [{ account: "4.3.1.02", debit: "10.00" }, { account: "2.1.1.01", credit: "9.99" }] }, ENGINE))).rejects.toThrow(/diferentes/);
    await expect(withTenant(appPool, t, (tx) => postEntry(tx, { ...energia, idempotencyKey: "x2", lines: [{ account: "4.3", debit: "10.00" }, { account: "2.1.1.01", credit: "10.00" }] }, ENGINE))).rejects.toThrow(/sintética/);
    await expect(withTenant(appPool, t, (tx) => postEntry(tx, { ...energia, date: "2026-08-31", idempotencyKey: "x3" }, ENGINE))).rejects.toThrow(/não vigente/);

    // O próprio banco recusa, mesmo gravando direto no SQL
    const direct = (debit: string, credit: string) =>
      withTenant(appPool, t, async (tx) => {
        const acc = await tx.query<{ code: string; id: string }>("SELECT code, id FROM chart_account WHERE entity_id = $1 AND code IN ('4.3.1.02', '2.1.1.01')", [entityId]);
        const id = newId();
        await tx.query(
          `INSERT INTO journal_entry (id, tenant_id, entity_id, competence, entry_date, history, origin, actor_kind, actor_id, idempotency_key)
           VALUES ($1, current_tenant(), $2, '2026-09-01', '2026-09-11', 'direto', 'MANUAL', 'USER', 'x', $3)`,
          [id, entityId, `direto:${id}`],
        );
        const by = Object.fromEntries(acc.rows.map((r) => [r.code, r.id]));
        await tx.query("INSERT INTO journal_line (id, tenant_id, entity_id, entry_id, seq, account_id, debit) VALUES ($1, current_tenant(), $2, $3, 1, $4, $5)", [newId(), entityId, id, by["4.3.1.02"], debit]);
        await tx.query("INSERT INTO journal_line (id, tenant_id, entity_id, entry_id, seq, account_id, credit) VALUES ($1, current_tenant(), $2, $3, 2, $4, $5)", [newId(), entityId, id, by["2.1.1.01"], credit]);
      });
    await expect(direct("10.00", "9.00")).rejects.toThrow(/Débitos/);
    await expect(withTenant(appPool, t, (tx) => tx.query("UPDATE journal_entry SET history = 'x' WHERE id = $1", [e1.id]))).rejects.toThrow();
    await expect(withTenant(appPool, t, async (tx) => {
      const a = await tx.query<{ id: string }>("SELECT id FROM chart_account WHERE entity_id = $1 AND code = '4.3.1.02'", [entityId]);
      await tx.query("INSERT INTO journal_line (id, tenant_id, entity_id, entry_id, seq, account_id, debit) VALUES ($1, current_tenant(), $2, $3, 9, $4, 1)", [newId(), entityId, e1.id, a.rows[0]!.id]);
    })).rejects.toThrow(/estorno/);

    // Pagamento e estorno
    await withTenant(appPool, t, (tx) => postEntry(tx, { ...energia, date: "2026-09-15", history: "Pagamento energia", origin: "BANCO", idempotencyKey: "pg:energia",
      lines: [{ account: "2.1.1.01", debit: "12450.00" }, { account: "1.1.1.01", credit: "12450.00" }] }, ENGINE));
    const rev = await withTenant(appPool, t, (tx) => reverseEntry(tx, e1.id, "nota lançada em duplicidade", LUAN));
    expect(rev.created).toBe(true);
    expect((await withTenant(appPool, t, (tx) => reverseEntry(tx, e1.id, "de novo", LUAN))).created).toBe(false);

    const tb = await withTenant(appPool, t, (tx) => trialBalance(tx, entityId, "2026-09-01", "2026-09-30"));
    expect(tb.totals).toEqual({ debit: "37350.00", credit: "37350.00", balanced: true });
    const by = Object.fromEntries(tb.rows.map((r) => [r.code, r]));
    expect(by["4.3.1.02"]).toMatchObject({ debit: "12450.00", credit: "12450.00", closing: "0.00" });
    expect(by["2.1.1.01"]).toMatchObject({ closing: "12450.00" });
    expect(by["1"]).toMatchObject({ closing: "-12450.00", analytic: false });
    expect(by["2"]).toMatchObject({ closing: "12450.00" });

    // Período bloqueado
    await withTenant(appPool, t, (tx) => setPeriodLock(tx, entityId, "2026-09-01", "BLOQUEADO", "fechamento", LUAN));
    await expect(withTenant(appPool, t, (tx) => postEntry(tx, { ...energia, idempotencyKey: "bloq" }, ENGINE))).rejects.toThrow(/bloqueado/);
    await expect(withTenant(appPool, t, (tx) => setPeriodLock(tx, entityId, "2026-09-01", "REABERTO", "agente", ENGINE))).rejects.toThrow(LedgerError);
    await withTenant(appPool, t, (tx) => setPeriodLock(tx, entityId, "2026-09-01", "REABERTO", "ajuste", LUAN));
    expect((await withTenant(appPool, t, (tx) => postEntry(tx, { ...energia, idempotencyKey: "reaberto" }, ENGINE))).created).toBe(true);

    await withTenant(appPool, t, async (tx) => {
      const ev = await tx.query("SELECT type, count(*)::int AS n FROM outbox WHERE type LIKE 'ACCOUNTING%' OR type = 'CHART_OF_ACCOUNTS_DEFINED' GROUP BY 1 ORDER BY 1");
      expect(ev.rows).toEqual([
        { type: "ACCOUNTING_POSTING_CREATED", n: 3 }, { type: "ACCOUNTING_POSTING_REVERSED", n: 1 }, { type: "CHART_OF_ACCOUNTS_DEFINED", n: 1 },
      ]);
    });
  });
});

describe("agente Financeiro: extrato bancário", () => {
  it("guarda o arquivo, cria a conta (e a conta contábil) e não duplica movimento", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    // Sem plano: conta bancária criada, conta contábil fica para depois
    const r0 = await importBankStatement(appPool, t, entityId, { name: "coop.ofx", bytes: Buffer.from(ofxXml) }, LUAN);
    expect(r0).toMatchObject({ status: "IMPORTADO", transactions: 1, ledgerAccount: null, account: "Sicoob cc 12345-6" });

    await applyStandardChart(appPool, t, entityId, "2026-01-01", LUAN);
    const r1 = await importBankStatement(appPool, t, entityId, { name: "itau-set.ofx", bytes: ofxSgml() }, LUAN);
    expect(r1).toMatchObject({ status: "IMPORTADO", transactions: 4, duplicated: 0, account: "Itaú ag 6157 cc 74251-8", ledgerAccount: "1.1.1.02.01", balance: "2478.20" });
    expect(await importBankStatement(appPool, t, entityId, { name: "itau-set (1).ofx", bytes: ofxSgml() }, LUAN)).toMatchObject({ status: "REPETIDO", transactions: 0 });
    // Arquivo novo com os mesmos movimentos e um a mais: só o novo entra
    const more = `<STMTTRN>\r\n<TRNTYPE>CREDIT\r\n<DTPOSTED>20260930\r\n<TRNAMT>0,45\r\n<FITID>A003\r\n<MEMO>RENDIMENTO\r\n</STMTTRN>\r\n`;
    expect(await importBankStatement(appPool, t, entityId, { name: "itau-set-2.ofx", bytes: ofxSgml(more) }, LUAN)).toMatchObject({ status: "IMPORTADO", transactions: 1, duplicated: 4 });
    await expect(importBankStatement(appPool, t, entityId, { name: "extrato.pdf", bytes: Buffer.from("%PDF-1.4") }, LUAN)).rejects.toThrow(StatementError);

    await withTenant(appPool, t, async (tx) => {
      const o = await bankOverview(tx, entityId);
      expect(o.accounts.map((a: { label: string; transactions: number; ledger_code: string | null }) => [a.label, a.transactions, a.ledger_code])).toEqual([
        ["Itaú ag 6157 cc 74251-8", 5, "1.1.1.02.01"], ["Sicoob cc 12345-6", 1, null],
      ]);
      const ev = await tx.query("SELECT count(*)::int AS n FROM outbox WHERE type = 'BANK_STATEMENT_RECEIVED'");
      expect(ev.rows[0].n).toBe(3);
    });
  });
});
