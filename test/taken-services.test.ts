import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readEntityNfseTaxes } from "../src/modules/fiscal/withholdings.js";
import { importBankStatement } from "../src/modules/financial/bank-statements.js";
import { approveTakenServicesRule, classifySupplier, pendingTaken, runAutoPosting } from "../src/modules/ledger/auto-posting.js";
import { applyStandardChart, LedgerError, trialBalance } from "../src/modules/ledger/ledger.js";
import { serviceAccount } from "../src/modules/ledger/service-accounts.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const LUAN: Actor = { kind: "USER", id: "luan@legacy.test" };
const tag = (n: string, v?: string) => (v === undefined ? "" : `<${n}>${v}</${n}>`);
const nota = (o: { prest: string; code: string; serv: string; irrf?: string; csll?: string; total?: string; day: string }) =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS1"><nNFSe>1</nNFSe><emit><CNPJ>${o.prest}</CNPJ><xNome>PRESTADOR ${o.prest.slice(0, 4)}</xNome></emit>` +
  `<valores>${tag("vTotalRet", o.total)}<vLiq>0</vLiq></valores><DPS versao="1.01"><infDPS Id="DPS1"><dhEmi>${o.day}T10:00:00-03:00</dhEmi><dCompet>${o.day}</dCompet>` +
  `<prest><CNPJ>${o.prest}</CNPJ><regTrib><opSimpNac>1</opSimpNac></regTrib></prest><toma><CNPJ>${CNPJ_MATRIZ}</CNPJ></toma>` +
  `<serv><cServ><cTribNac>${o.code}</cTribNac></cServ></serv><valores><vServPrest><vServ>${o.serv}</vServ></vServPrest><trib><tribMun><tpRetISSQN>1</tpRetISSQN></tribMun>` +
  `<tribFed>${o.csll ? "<piscofins><tpRetPisCofins>3</tpRetPisCofins></piscofins>" : ""}${tag("vRetIRRF", o.irrf)}${tag("vRetCSLL", o.csll)}</tribFed></trib></valores></infDPS></DPS></infNFSe></NFSe>`;

describe("NFS-e tomadas no razão", () => {
  it("tabela por tipo de serviço só depois de aprovada; fornecedor sem conta fica para pessoa; pagamento baixa Fornecedores", async () => {
    expect(serviceAccount("171401")).toBe("4.3.1.06");
    expect(serviceAccount("171901")).toBe("4.3.1.05");
    expect(serviceAccount("010101")).toBe("4.3.1.09");
    expect(serviceAccount("990101")).toBeNull();

    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    let nsu = 0;
    await withTenant(appPool, t, async (tx) => {
      const put = (xml: string, value: string, day: string, prest: string, number: string) =>
        tx.query(
          `INSERT INTO nfse_document (id, tenant_id, entity_id, nsu, access_key, role, number, issued_at, provider_doc, provider_name, service_value, xml, sha256)
           VALUES ($1, current_tenant(), $2, $3, $4, 'TOMADA', $5, $6, $7, $8, $9, $10, $11)`,
          [newId(), entityId, ++nsu, `K${nsu}`, number, `${day}T10:00:00-03:00`, prest, `PRESTADOR ${prest.slice(0, 4)}`, value, xml, createHash("sha256").update(xml + nsu).digest()],
        );
      await put(nota({ prest: "17889141000100", code: "171401", serv: "3196.59", irrf: "47.95", csll: "148.64", total: "196.59", day: "2026-09-10" }), "3196.59", "2026-09-10", "17889141000100", "91");
      await put(nota({ prest: "11222333000181", code: "990101", serv: "500.00", day: "2026-09-12" }), "500.00", "2026-09-12", "11222333000181", "7");
      await put(nota({ prest: "98765432000110", code: "010101", serv: "200.00", day: "2026-09-15" }), "200.00", "2026-09-15", "98765432000110", "3");
    });
    await readEntityNfseTaxes(appPool, t, entityId);
    await applyStandardChart(appPool, t, entityId, "2026-09-01", LUAN);

    // Antes da aprovação: nada das tomadas é lançado
    expect(await runAutoPosting(appPool, t, entityId)).toMatchObject({ posted: 0, pendingFiscal: 3 });
    expect((await pendingTaken(appPool, t, entityId))[0]!.reason).toMatch(/aguardando aprovação/);

    await expect(approveTakenServicesRule(appPool, t, { kind: "AGENT", id: "x" })).rejects.toThrow(LedgerError);
    expect(await approveTakenServicesRule(appPool, t, LUAN)).toMatchObject({ posted: 2 });
    const p = await pendingTaken(appPool, t, entityId);
    expect(p.map((x) => [x.number, x.reason])).toEqual([["7", "Tipo de serviço 990101 sem conta definida"]]);

    // Pessoa define a conta do fornecedor: a nota dele entra
    expect(await classifySupplier(appPool, t, { entityId, supplierDoc: "11222333000181", account: "4.3.1.12", history: "Manutenção predial", scope: "EMPRESA" }, LUAN)).toMatchObject({ posted: 1 });
    expect(await pendingTaken(appPool, t, entityId)).toEqual([]);

    // Pagamento do líquido da nota de advocacia no extrato baixa Fornecedores
    const ofx = `OFXHEADER:100\r\n<OFX>\r\n<BANKMSGSRSV1>\r\n<STMTTRNRS>\r\n<STMTRS>\r\n<BANKACCTFROM>\r\n<BANKID>0341\r\n<ACCTID>1-1\r\n</BANKACCTFROM>\r\n<BANKTRANLIST>\r\n` +
      `<STMTTRN>\r\n<TRNTYPE>DEBIT\r\n<DTPOSTED>20260920\r\n<TRNAMT>-3000,00\r\n<FITID>P1\r\n<MEMO>PIX ADVOGADO\r\n</STMTTRN>\r\n</BANKTRANLIST>\r\n</STMTRS>\r\n</STMTTRNRS>\r\n</BANKMSGSRSV1>\r\n</OFX>\r\n`;
    await importBankStatement(appPool, t, entityId, { name: "x.ofx", bytes: Buffer.from(ofx, "latin1") }, LUAN);
    expect(await runAutoPosting(appPool, t, entityId)).toMatchObject({ posted: 1, pendingBank: 0 });

    const tb = await withTenant(appPool, t, (tx) => trialBalance(tx, entityId, "2026-09-01", "2026-09-30"));
    expect(tb.totals.balanced).toBe(true);
    const by = Object.fromEntries(tb.rows.map((r) => [r.code, r.closing]));
    expect(by["4.3.1.06"]).toBe("3196.59");
    expect(by["4.3.1.09"]).toBe("200.00");
    expect(by["4.3.1.12"]).toBe("500.00");
    expect(by["2.1.2.02"]).toBe("-47.95");
    expect(by["2.1.2.03"]).toBe("-148.64");
    expect(by["2.1.1.01"]).toBe("-700.00"); // 3.000 + 200 + 500 − 3.000 pago
    await withTenant(appPool, t, async (tx) => {
      const m = await tx.query("SELECT method FROM bank_match");
      expect(m.rows).toEqual([{ method: "NFSE_TOMADA" }]);
    });
  });
});
