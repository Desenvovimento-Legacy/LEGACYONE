import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { parsePdfStatement, parseTabular, readCsvRows } from "../src/integrations/bank/statement-text.js";
import { readXlsxRows } from "../src/integrations/bank/xlsx.js";
import { importBankStatement, StatementError } from "../src/modules/financial/bank-statements.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const LUAN: Actor = { kind: "USER", id: "luan" };
const CSV = [
  "Banco Itaú - Extrato de conta corrente",
  "Agência: 1234   Conta: 56789-0",
  "",
  "Data;Lançamento;Valor (R$);Saldo (R$)",
  "30/06/2026;SALDO ANTERIOR;;1.000,00",
  "01/07/2026;PIX RECEBIDO CLIENTE A;2.500,00;3.500,00",
  "02/07/2026;PAGTO BOLETO ENERGIA;-450,30;3.049,70",
  "02/07/2026;TARIFA PACOTE;-49,70;3.000,00",
].join("\r\n");

function xlsx(rows: string[][]): Buffer {
  const cell = (v: string, r: number, c: number) => `<c r="${String.fromCharCode(65 + c)}${r}" t="inlineStr"><is><t>${v}</t></is></c>`;
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => (v ? cell(v, i + 1, j) : "")).join("")}</row>`).join("")}</sheetData></worksheet>`;
  return Buffer.from(zipSync({
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Extrato" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
  }));
}

const ofx = (rows: [string, string, string, string][]) =>
  `OFXHEADER:100\r\n<OFX>\r\n<BANKMSGSRSV1>\r\n<STMTTRNRS>\r\n<STMTRS>\r\n<BANKACCTFROM>\r\n<BANKID>0341\r\n<BRANCHID>1234\r\n<ACCTID>56789-0\r\n</BANKACCTFROM>\r\n<BANKTRANLIST>\r\n` +
  rows.map(([id, d, a, m]) => `<STMTTRN>\r\n<TRNTYPE>OTHER\r\n<DTPOSTED>${d}\r\n<TRNAMT>${a}\r\n<FITID>${id}\r\n<MEMO>${m}\r\n</STMTTRN>\r\n`).join("") +
  `</BANKTRANLIST>\r\n</STMTRS>\r\n</STMTTRNRS>\r\n</BANKMSGSRSV1>\r\n</OFX>\r\n`;

describe("extrato em CSV, Excel e PDF", () => {
  it("CSV: acha o cabeçalho, lê banco/agência/conta, ignora linhas de saldo e confere o saldo linha a linha", () => {
    const st = parseTabular(readCsvRows(CSV), "CSV");
    expect(st).toMatchObject({ bankCode: "341", branch: "1234", account: "56789-0", proof: "SALDO_POR_LINHA", periodStart: "2026-07-01", periodEnd: "2026-07-02", balance: "3000.00" });
    expect(st.transactions.map((t) => [t.postedOn, t.amount, t.memo])).toEqual([
      ["2026-07-01", "2500.00", "PIX RECEBIDO CLIENTE A"], ["2026-07-02", "-450.30", "PAGTO BOLETO ENERGIA"], ["2026-07-02", "-49.70", "TARIFA PACOTE"],
    ]);
    expect(() => parseTabular(readCsvRows(CSV.replace("3.049,70", "3.049,00")), "CSV")).toThrow(/Saldo não fecha em 02\/07\/2026/);
  });

  it("Excel (.xlsx): colunas de débito e crédito", () => {
    const rows = readXlsxRows(xlsx([["Data", "Histórico", "Débito", "Crédito"], ["05/07/2026", "PIX ENVIADO FORNECEDOR", "1.200,00", ""], ["06/07/2026", "TED RECEBIDA", "", "800,00"]]));
    const st = parseTabular(rows, "XLSX");
    expect(st.transactions.map((t) => [t.postedOn, t.amount])).toEqual([["2026-07-05", "-1200.00"], ["2026-07-06", "800.00"]]);
    expect(st.proof).toBe("SEM_SALDO");
  });

  it("PDF: só entra com o saldo fechando", () => {
    const text = ["BRADESCO  Agência: 0456  Conta: 12345-6", "Extrato de 01/07/2026 a 31/07/2026", "Data Histórico Valor Saldo", "SALDO ANTERIOR 1.000,00",
      "01/07 PIX RECEBIDO CLIENTE B 300,00 1.300,00", "03/07 PAGTO FORNECEDOR XPTO -150,00 1.150,00", "05/07 TARIFA BANCARIA 10,00- 1.140,00"].join("\n");
    const st = parsePdfStatement(text);
    expect(st).toMatchObject({ format: "PDF", bankCode: "237", branch: "0456", account: "12345-6", proof: "SALDO_POR_LINHA", balance: "1140.00" });
    expect(st.transactions.map((t) => t.amount)).toEqual(["300.00", "-150.00", "-10.00"]);
    expect(() => parsePdfStatement(text.replace("1.140,00", "1.139,00"))).toThrow(/Saldo não fecha/);
    expect(() => parsePdfStatement("Período 01/07/2026 a 31/07/2026\n01/07 PIX 300,00\n03/07 PAGTO -150,00")).toThrow(/saldo para conferir/);
  });

  it("importa CSV; o mesmo período depois em OFX não duplica; sem conta no arquivo pede a conta", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    const a = await importBankStatement(appPool, t, entityId, { name: "jul.csv", bytes: Buffer.from(CSV, "latin1") }, LUAN);
    expect(a).toMatchObject({ status: "IMPORTADO", transactions: 3, account: expect.stringMatching(/cc 56789-0/) });
    const b = await importBankStatement(appPool, t, entityId, { name: "jul.ofx", bytes: Buffer.from(ofx([
      ["F1", "20260701", "2500.00", "PIX RECEBIDO CLIENTE A"], ["F2", "20260702", "-450.30", "PAGTO BOLETO ENERGIA"], ["F3", "20260702", "-49.70", "TARIFA"], ["F4", "20260703", "-10.00", "NOVO"],
    ]), "latin1") }, LUAN);
    expect(b).toMatchObject({ status: "IMPORTADO", transactions: 1, duplicated: 3 });
    const noAcc = Buffer.from(["Data;Descrição;Valor", "10/07/2026;PIX;100,00"].join("\n"));
    await expect(importBankStatement(appPool, t, entityId, { name: "x.csv", bytes: noAcc }, LUAN)).rejects.toThrow(StatementError);
    const c = await importBankStatement(appPool, t, entityId, { name: "x.csv", bytes: noAcc }, LUAN, { account: { id: a.bankAccountId } });
    expect(c).toMatchObject({ transactions: 1, bankAccountId: a.bankAccountId });
    await withTenant(appPool, t, async (tx) => {
      const f = await tx.query("SELECT format FROM bank_statement_file WHERE entity_id = $1 ORDER BY received_at", [entityId]);
      expect(f.rows.map((r) => r.format)).toEqual(["CSV", "OFX", "CSV"]);
    });
  });
});
