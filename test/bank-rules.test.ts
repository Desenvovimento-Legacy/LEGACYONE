import { describe, expect, it } from "vitest";
import { importBankStatement } from "../src/modules/financial/bank-statements.js";
import { approveAccountingRule, BANK_STANDARD_RULE, pendingMovements, runAutoPosting, standardKind } from "../src/modules/ledger/auto-posting.js";
import { applyStandardChart, trialBalance } from "../src/modules/ledger/ledger.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const LUAN: Actor = { kind: "USER", id: "luan@legacy.test" };
const ofx = (bank: string, acct: string, rows: [string, string, string, string][]) =>
  `OFXHEADER:100\r\n<OFX>\r\n<BANKMSGSRSV1>\r\n<STMTTRNRS>\r\n<STMTRS>\r\n<BANKACCTFROM>\r\n<BANKID>${bank}\r\n<ACCTID>${acct}\r\n</BANKACCTFROM>\r\n<BANKTRANLIST>\r\n<DTSTART>20260701\r\n<DTEND>20260731\r\n` +
  rows.map(([id, d, a, m]) => `<STMTTRN>\r\n<TRNTYPE>OTHER\r\n<DTPOSTED>${d}\r\n<TRNAMT>${a}\r\n<FITID>${id}\r\n<MEMO>${m}\r\n</STMTTRN>\r\n`).join("") +
  `</BANKTRANLIST>\r\n</STMTRS>\r\n</STMTTRNRS>\r\n</BANKMSGSRSV1>\r\n</OFX>\r\n`;

describe("extrato: transferência entre contas próprias e movimentos típicos do banco", () => {
  it("liga as duas pontas da transferência; aplicação, resgate, rendimento e tarifa só com a regra aprovada", async () => {
    expect(standardKind("RES APLIC AUT MAIS", false)).toBe("RESGATE");
    expect(standardKind("APL APLIC AUT MAIS", true)).toBe("APLICACAO");
    expect(standardKind("APLICACAO CDB", true)).toBe("APLICACAO");
    expect(standardKind("RENTAB.INVEST FACILCRED*", false)).toBe("RENDIMENTO");
    expect(standardKind("RENDIMENTOS REND PAGO APLIC AUT MAIS", false)).toBe("RENDIMENTO");
    expect(standardKind("TARIFA BANCARIA CESTA PJ FACIL 1", true)).toBe("TARIFA");
    expect(standardKind("CARTAO CREDITO ANUIDADE", true)).toBe("TARIFA");
    expect(standardKind("PIX RECEBIDO FULANO", false)).toBeNull();

    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ); // ALPHA INDÚSTRIA LTDA
    await applyStandardChart(appPool, t, entityId, "2026-07-01", LUAN);
    await importBankStatement(appPool, t, entityId, { name: "itau.ofx", bytes: Buffer.from(ofx("0341", "1-1", [
      ["i1", "20260710", "1000,00", `PIX RECEBIDO ALPHA INDUSTRIA LTDA ${CNPJ_MATRIZ}`],
      ["i2", "20260711", "-500,00", "APL APLIC AUT MAIS"],
      ["i3", "20260712", "200,00", "RES APLIC AUT MAIS"],
      ["i4", "20260713", "1,23", "RENDIMENTOS REND PAGO APLIC AUT MAIS"],
      ["i5", "20260714", "-15,00", "TARIFA BANCARIA CESTA PJ"],
    ]), "latin1") }, LUAN);
    await importBankStatement(appPool, t, entityId, { name: "brad.ofx", bytes: Buffer.from(ofx("0237", "2-2", [
      ["b1", "20260710", "-1000,00", "PIX ENVIADO DES: ALPHA INDUSTRIA"],
      ["b2", "20260720", "300,00", "PIX RECEBIDO REM: ALPHA INDUSTRIA"],
    ]), "latin1") }, LUAN);

    expect(await runAutoPosting(appPool, t, entityId)).toMatchObject({ posted: 1, pendingBank: 5 });
    const pend = await pendingMovements(appPool, t, entityId);
    expect(pend.map((p) => p.reason).sort()).toEqual([
      "Aplicação financeira do banco: aprove as regras padrão de extrato",
      "Rendimento de aplicação do banco: aprove as regras padrão de extrato",
      "Resgate de aplicação do banco: aprove as regras padrão de extrato",
      "Tarifa bancária do banco: aprove as regras padrão de extrato",
      "Transferência entre contas da própria empresa: falta o extrato (ou o movimento) da outra conta",
    ]);
    await withTenant(appPool, t, async (tx) => {
      const m = await tx.query("SELECT method, count(*)::int AS n, count(DISTINCT entry_id)::int AS e FROM bank_match GROUP BY method");
      expect(m.rows).toEqual([{ method: "TRANSFERENCIA", n: 2, e: 1 }]);
    });

    expect(await approveAccountingRule(appPool, t, BANK_STANDARD_RULE, LUAN)).toMatchObject({ posted: 4 });
    const tb = await withTenant(appPool, t, (tx) => trialBalance(tx, entityId, "2026-07-01", "2026-07-31"));
    const by = Object.fromEntries(tb.rows.map((r) => [r.code, r.closing]));
    expect(by["1.1.1.03"]).toBe("300.00"); // aplicado 500, resgatado 200
    expect(by["3.3.1.01"]).toBe("-1.23");
    expect(by["4.4.1.01"]).toBe("15.00");
    expect(tb.totals.balanced).toBe(true);
    expect((await pendingMovements(appPool, t, entityId)).map((p) => p.amount)).toEqual(["300.00"]);
  });
});
