import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readEntityNfseTaxes } from "../src/modules/fiscal/withholdings.js";
import { importBankStatement } from "../src/modules/financial/bank-statements.js";
import { approveTakenServicesRule, pendingMovements, runAutoPosting } from "../src/modules/ledger/auto-posting.js";
import { applyStandardChart } from "../src/modules/ledger/ledger.js";
import { openItems } from "../src/modules/ledger/reports.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { CNPJ_MATRIZ, CNPJ_PRESUMIDO } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const LUAN: Actor = { kind: "USER", id: "luan@legacy.test" };
const CLIENTE = "60611420000136";
const DELTA = CNPJ_PRESUMIDO;

const nota = (prest: string, serv: string, day: string) =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS1"><nNFSe>1</nNFSe><emit><CNPJ>${prest}</CNPJ><xNome>X</xNome></emit>` +
  `<valores><vLiq>0</vLiq></valores><DPS versao="1.01"><infDPS Id="DPS1"><dhEmi>${day}T10:00:00-03:00</dhEmi><dCompet>${day}</dCompet>` +
  `<prest><CNPJ>${prest}</CNPJ><regTrib><opSimpNac>1</opSimpNac></regTrib></prest><toma><CNPJ>${CNPJ_MATRIZ}</CNPJ></toma>` +
  `<serv><cServ><cTribNac>171401</cTribNac></cServ></serv><valores><vServPrest><vServ>${serv}</vServ></vServPrest><trib><tribMun><tpRetISSQN>1</tpRetISSQN></tribMun>` +
  `<tribFed></tribFed></trib></valores></infDPS></DPS></infNFSe></NFSe>`;

const ofx = (rows: [string, string, string, string][]) =>
  `OFXHEADER:100\r\n<OFX>\r\n<BANKMSGSRSV1>\r\n<STMTTRNRS>\r\n<STMTRS>\r\n<BANKACCTFROM>\r\n<BANKID>0341\r\n<ACCTID>1-1\r\n</BANKACCTFROM>\r\n<BANKTRANLIST>\r\n` +
  rows.map(([id, day, amt, memo]) => `<STMTTRN>\r\n<TRNTYPE>OTHER\r\n<DTPOSTED>${day}\r\n<TRNAMT>${amt}\r\n<FITID>${id}\r\n<MEMO>${memo}\r\n</STMTTRN>\r\n`).join("") +
  `</BANKTRANLIST>\r\n</STMTRS>\r\n</STMTTRNRS>\r\n</BANKMSGSRSV1>\r\n</OFX>\r\n`;

describe("recebimento e pagamento parcial de NFS-e", () => {
  it("baixa parcelas das notas mais antigas, a última parcela quita pelo saldo e valor acima do saldo fica pendente", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    let nsu = 0;
    await withTenant(appPool, t, async (tx) => {
      const issued = (value: string, day: string, number: string) =>
        tx.query(
          `INSERT INTO nfse_document (id, tenant_id, entity_id, nsu, access_key, role, number, issued_at, taker_doc, taker_name, service_value, xml, sha256)
           VALUES ($1, current_tenant(), $2, $3, $4, 'PRESTADA', $5, $6, $7, 'SAFE ON SERVICOS LTDA', $8, '<x/>', $9)`,
          [newId(), entityId, ++nsu, `K${nsu}`, number, `${day}T10:00:00-03:00`, CLIENTE, value, createHash("sha256").update(`p${nsu}`).digest()],
        );
      await issued("1000.00", "2026-07-01", "10");
      await issued("2000.00", "2026-07-05", "11");
      await tx.query(
        `INSERT INTO nfse_document (id, tenant_id, entity_id, nsu, access_key, role, number, issued_at, provider_doc, provider_name, service_value, xml, sha256)
         VALUES ($1, current_tenant(), $2, $3, $4, 'TOMADA', 'D1', '2026-07-02T10:00:00-03:00', $5, 'DELTA SERVICOS LTDA', '1000.00', $6, $7)`,
        [newId(), entityId, ++nsu, `K${nsu}`, DELTA, nota(DELTA, "1000.00", "2026-07-02"), createHash("sha256").update("t1").digest()],
      );
    });
    await readEntityNfseTaxes(appPool, t, entityId);
    await applyStandardChart(appPool, t, entityId, "2026-07-01", LUAN);
    await approveTakenServicesRule(appPool, t, LUAN);

    await importBankStatement(appPool, t, entityId, { name: "b.ofx", bytes: Buffer.from(ofx([
      ["1", "20260710", "600,00", `PIX RECEBIDO ${CLIENTE}`], // parcela da nota 10
      ["2", "20260715", "1400,00", `PIX RECEBIDO ${CLIENTE}`], // quita os 400 da 10 e 1.000 da 11
      ["3", "20260720", "1000,00", `PIX RECEBIDO ${CLIENTE}`], // valor exato do saldo da 11: quitação
      ["4", "20260712", "-300,00", `SISPAG FORNECEDOR ${DELTA}`], // parcela da nota tomada D1
      ["5", "20260713", "-900,00", `SISPAG FORNECEDOR ${DELTA}`], // acima do saldo de 700: pendência
    ]), "latin1") }, LUAN);
    await runAutoPosting(appPool, t, entityId);

    await withTenant(appPool, t, async (tx) => {
      const m = await tx.query<{ method: string; amount: string }>(
        "SELECT method, amount::text FROM bank_match ORDER BY method, bank_match.amount");
      expect(m.rows).toEqual([
        { method: "NFSE", amount: "400.00" },
        { method: "NFSE", amount: "1000.00" },
        { method: "NFSE_PARCIAL", amount: "600.00" },
        { method: "NFSE_PARCIAL", amount: "1000.00" },
        { method: "NFSE_TOMADA_PARCIAL", amount: "300.00" },
      ]);
      const h = await tx.query<{ history: string }>("SELECT history FROM journal_entry WHERE origin = 'BANCO' ORDER BY entry_date, history");
      expect(h.rows.map((r) => r.history.replace(/ — .*$/, ""))).toEqual([
        "Recebimento parcial de SAFE ON SERVICOS LTDA (NFS-e nº 10 parcial)",
        "Pagamento parcial a DELTA SERVICOS LTDA (NFS-e nº D1 parcial)",
        "Recebimento parcial de SAFE ON SERVICOS LTDA (NFS-e nº 10, 11 parcial)",
        "Recebimento da NFS-e nº 11 (SAFE ON SERVICOS LTDA)",
      ]);
      const cli = await openItems(tx, entityId, "1.1.2.01", "2026-07-31");
      expect(cli.total).toBe("0.00");
      const sup = await openItems(tx, entityId, "2.1.1.01", "2026-07-31");
      expect(sup.items.map((i) => [i.partnerDoc, i.balance])).toEqual([[DELTA, "-700.00"]]);
    });
    const pend = await pendingMovements(appPool, t, entityId);
    expect(pend.map((p) => [p.amount, p.reason])).toEqual([
      ["-900.00", expect.stringMatching(/valor não fecha com as notas em aberto \(1 nota\(s\), 700,00\)/)],
    ]);
  });
});
