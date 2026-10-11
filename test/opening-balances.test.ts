import { describe, expect, it } from "vitest";
import { importBankStatement } from "../src/modules/financial/bank-statements.js";
import { applyStandardChart, trialBalance } from "../src/modules/ledger/ledger.js";
import { importOpeningBalances, OpeningBalanceError, parseBalancete } from "../src/modules/ledger/opening-balances.js";
import { incomeStatement } from "../src/modules/ledger/reports.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const LUAN: Actor = { kind: "USER", id: "luan@legacy.test" };
const cnpjFmt = `${CNPJ_MATRIZ.slice(0, 2)}.${CNPJ_MATRIZ.slice(2, 5)}.${CNPJ_MATRIZ.slice(5, 8)}/${CNPJ_MATRIZ.slice(8, 12)}-${CNPJ_MATRIZ.slice(12)}`;

// Formato do balancete do Domínio extraído do PDF: saldo atual, crédito, débito, saldo anterior, código e nome colados.
const BALANCETE = (extra = "") => `BALANCETE
C.N.P.J.: ${cnpjFmt}
Período: 01/01/2026 - 30/06/2026
Descrição da conta Crédito Saldo AtualSaldo Anterior Débito
1.200,00D300,00500,001.000,00D1 ATIVO
1.200,00D300,00500,001.000,00D2 ATIVO CIRCULANTE
250,00D50,00100,00200,00D4 CAIXA
250,00D50,00100,00200,00D5 CAIXA
950,00D250,00400,00800,00D7 BANCOS CONTA MOVIMENTO
950,00D250,00400,00800,00D15 BANCO ITAU
1.000,00C0,000,001.000,00C149 PASSIVO
600,00C0,000,00600,00C243 CAPITAL SOCIAL
600,00C0,000,00600,00C245 CAPITAL SOCIAL
400,00C0,000,00400,00C266 LUCROS OU PREJUÍZOS ACUMULADOS
${extra}500,00C500,000,000,00402 RECEITAS
500,00C500,000,000,00411 RECEITA DE PRESTAÇÃO DE SERVIÇOS
300,00D0,00300,000,00269 DESPESAS
300,00D0,00300,000,00362 HONORÁRIOS CONTÁBEIS
CONTAS DEVEDORAS 1.000,00D 800,00 300,00 1.500,00D
_______________________________________
Fulano Contador
Reg. no CRC - PR 012345/O-1`;

const ofx = `OFXHEADER:100\r\n<OFX>\r\n<BANKMSGSRSV1>\r\n<STMTTRNRS>\r\n<STMTRS>\r\n<BANKACCTFROM>\r\n<BANKID>0341\r\n<ACCTID>1-1\r\n</BANKACCTFROM>\r\n<BANKTRANLIST>\r\n<DTSTART>20260701\r\n<DTEND>20260731\r\n` +
  `<STMTTRN>\r\n<TRNTYPE>OTHER\r\n<DTPOSTED>20260710\r\n<TRNAMT>-15,00\r\n<FITID>x1\r\n<MEMO>TARIFA BANCARIA\r\n</STMTTRN>\r\n</BANKTRANLIST>\r\n</STMTRS>\r\n</STMTTRNRS>\r\n</BANKMSGSRSV1>\r\n</OFX>\r\n`;

describe("saldos de abertura herdados (balancete do escritório anterior)", () => {
  it("lê o balancete, monta a árvore pelas somas e confere com o resumo", () => {
    const b = parseBalancete(BALANCETE());
    expect(b).toMatchObject({ cnpj: CNPJ_MATRIZ, periodEnd: "2026-06-30", totalDebit: "1500.00", firm: "Fulano Contador (Reg. no CRC - PR 012345/O-1)" });
    expect(b.leaves.map((l) => [l.code, l.curr])).toEqual([
      ["5", "250.00"], ["15", "950.00"], ["245", "-600.00"], ["266", "-400.00"], ["411", "-500.00"], ["362", "300.00"],
    ]);
    expect(b.leaves[1]!.path).toEqual(["ATIVO", "ATIVO CIRCULANTE", "BANCOS CONTA MOVIMENTO"]);
    expect(() => parseBalancete(BALANCETE().replace("250,00D50,00100,00200,00D5 CAIXA", "251,00D50,00100,00200,00D5 CAIXA"))).toThrow(/não fecha/);
  });

  it("lança a abertura no início do plano, vale como saldo anterior e entra no acumulado do ano; sem de/para não lança", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    await applyStandardChart(appPool, t, entityId, "2026-07-01", LUAN);
    await importBankStatement(appPool, t, entityId, { name: "itau.ofx", bytes: Buffer.from(ofx, "latin1") }, LUAN);
    const bank = await withTenant(appPool, t, async (tx) => (await tx.query("SELECT c.code FROM bank_account b JOIN chart_account c ON c.id = b.ledger_account_id")).rows[0].code as string);

    // conta sem correspondente no plano: nada é lançado
    const bad = BALANCETE("").replace("400,00C0,000,00400,00C266 LUCROS OU PREJUÍZOS ACUMULADOS", "400,00C0,000,00400,00C266 XYZW QWERTY");
    await expect(importOpeningBalances(appPool, t, { entityId, fileName: "b0.pdf", bytes: Buffer.from("x0"), text: bad }, LUAN)).rejects.toThrow(/Sem conta no plano para: 266 XYZW QWERTY/);
    await expect(importOpeningBalances(appPool, t, { entityId, fileName: "b.pdf", bytes: Buffer.from("x1"), text: BALANCETE() }, { kind: "AGENT", id: "ia" })).rejects.toThrow(OpeningBalanceError);

    const r = await importOpeningBalances(appPool, t, { entityId, fileName: "b.pdf", bytes: Buffer.from("x1"), text: BALANCETE() }, LUAN);
    expect(r.created).toBe(true);
    expect(r.lines.map((l) => [l.code, l.account, l.method, l.status])).toEqual([
      ["5", "1.1.1.01", "NOME", "INHERITED_NOT_VALIDATED"],
      ["15", bank, "CONTA_BANCARIA", "INHERITED_NOT_VALIDATED"],
      ["245", "2.3.1.01", "NOME", "INHERITED_NOT_VALIDATED"],
      ["266", "2.3.1.02", "NOME", "INHERITED_NOT_VALIDATED"],
      ["411", "3.1.1.01", "NOME", "INHERITED_NOT_VALIDATED"],
      ["362", "4.3.1.05", "NOME", "INHERITED_NOT_VALIDATED"],
    ]);
    // mesmo arquivo de novo: idempotente; outro arquivo: barra
    expect((await importOpeningBalances(appPool, t, { entityId, fileName: "b.pdf", bytes: Buffer.from("x1"), text: BALANCETE() }, LUAN)).created).toBe(false);
    await expect(importOpeningBalances(appPool, t, { entityId, fileName: "c.pdf", bytes: Buffer.from("x2"), text: BALANCETE() }, LUAN)).rejects.toThrow(/já tem saldos de abertura/);

    await withTenant(appPool, t, async (tx) => {
      const tb = await trialBalance(tx, entityId, "2026-07-01", "2026-07-31");
      const by = Object.fromEntries(tb.rows.map((x) => [x.code, x]));
      expect(by[bank]).toMatchObject({ opening: "950.00", debit: "0.00", credit: "0.00", closing: "950.00" }); // abertura não é movimento de julho
      expect(by["2.3.1.01"]).toMatchObject({ opening: "-600.00", closing: "-600.00" });
      expect(tb.totals.balanced).toBe(true);
      const dre = await incomeStatement(tx, entityId, "2026-07");
      const v = (k: string, l: typeof dre.monthLines) => l.find((x) => x.key === k)?.value;
      expect(dre.ytdFrom).toBe("2026-01-01");
      expect(v("rb", dre.monthLines)).toBe("0.00"); // julho não recebe o semestre anterior
      expect(v("rb", dre.ytdLines)).toBe("500.00"); // o acumulado do ano inclui
      const ev = await tx.query("SELECT payload FROM outbox WHERE type = 'OPENING_BALANCES_IMPORTED'");
      expect(ev.rows[0].payload).toMatchObject({ accounts: 6, total: "1500.00", period_end: "2026-06-30" });
    });
  });
});
