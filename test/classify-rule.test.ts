import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readEntityNfseTaxes } from "../src/modules/fiscal/withholdings.js";
import { importBankStatement } from "../src/modules/financial/bank-statements.js";
import { approveAccountingRule, approveTakenServicesRule, CLASSIFY_RULE, pendingMovements, runAutoPosting } from "../src/modules/ledger/auto-posting.js";
import { addAccount, applyStandardChart } from "../src/modules/ledger/ledger.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { CNPJ_MATRIZ, CNPJ_PRESUMIDO } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const LUAN: Actor = { kind: "USER", id: "luan@legacy.test" };
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

describe("classificação do extrato (regra do responsável técnico)", () => {
  it("sócio vai em adiantamento a sócios; pessoa com conta própria vai na conta dela; pago a maior que a nota vira juros e multas", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    await withTenant(appPool, t, async (tx) => {
      await tx.query("INSERT INTO partner_history (id, tenant_id, entity_id, name, valid_from, source) VALUES ($1, current_tenant(), $2, 'JOAO MARIA FAGUNDES FILHO', '2020-01-01', 'teste')", [newId(), entityId]);
      await tx.query(
        `INSERT INTO nfse_document (id, tenant_id, entity_id, nsu, access_key, role, number, issued_at, provider_doc, provider_name, service_value, xml, sha256)
         VALUES ($1, current_tenant(), $2, 1, 'K1', 'TOMADA', 'D1', '2026-07-02T10:00:00-03:00', $3, 'DELTA SERVICOS LTDA', '1000.00', $4, $5)`,
        [newId(), entityId, DELTA, nota(DELTA, "1000.00", "2026-07-02"), createHash("sha256").update("t1").digest()],
      );
    });
    await readEntityNfseTaxes(appPool, t, entityId);
    await applyStandardChart(appPool, t, entityId, "2026-07-01", LUAN);
    await approveTakenServicesRule(appPool, t, LUAN);
    // fornecedora pessoa física com conta própria no plano (veio do escritório anterior)
    await withTenant(appPool, t, (tx) => addAccount(tx, { entityId, parent: "2.1.1", name: "DANIELLE DE BARROS SANTOS", validFrom: "2026-07-01", source: "MIGRACAO" }, LUAN));
    await importBankStatement(appPool, t, entityId, { name: "b.ofx", bytes: Buffer.from(ofx([
      ["1", "20260703", "-15000,00", "PAGAMENTOS A FORNECEDORES JOAO MARIA FAGUNDES FILHO 017.782.629-02"],
      ["2", "20260705", "-4400,98", "PAGAMENTOS A FORNECEDORES DANIELLE DE BARROS SANTOS 067.060.569-79"],
      ["3", "20260720", "-1032,50", `SISPAG FORNECEDOR ${DELTA}`], // nota de 1.000 paga com 32,50 de juros/multa
      ["4", "20260722", "-5000,00", `SISPAG FORNECEDOR ${DELTA}`], // muito acima: não é juros, fica pendente
      ["5", "20260725", "0,01", "PIX RECEBIDO REM: LINKANA"], // PIX de teste de conta: outras receitas
    ]), "latin1") }, LUAN);

    // sem a regra: tudo espera
    await runAutoPosting(appPool, t, entityId);
    expect((await pendingMovements(appPool, t, entityId)).length).toBe(5);
    await expect(approveAccountingRule(appPool, t, CLASSIFY_RULE, { kind: "AGENT", id: "ledger" })).rejects.toThrow(/pessoa/);
    await approveAccountingRule(appPool, t, CLASSIFY_RULE, LUAN);

    const pend = await pendingMovements(appPool, t, entityId);
    expect(pend.map((p) => p.amount)).toEqual(["-5000.00"]);
    await withTenant(appPool, t, async (tx) => {
      const e = await tx.query<{ history: string; lines: { code: string; name: string; debit: string; credit: string }[] }>(
        `SELECT e.history, json_agg(json_build_object('code', c.code, 'name', c.name, 'debit', l.debit::text, 'credit', l.credit::text) ORDER BY l.debit DESC, c.code) AS lines
           FROM journal_entry e JOIN journal_line l ON l.entry_id = e.id JOIN chart_account c ON c.id = l.account_id
          WHERE e.entity_id = $1 AND e.origin = 'BANCO' GROUP BY e.id, e.history, e.entry_date ORDER BY e.entry_date`,
        [entityId],
      );
      expect(e.rows).toHaveLength(4);
      expect(e.rows[3]!.lines.find((l) => l.credit === "0.01")).toMatchObject({ name: "OUTRAS RECEITAS" });
      expect(e.rows[0]!.history).toMatch(/^Adiantamento ao sócio JOAO MARIA/);
      expect(e.rows[0]!.lines[0]).toMatchObject({ name: "ADIANTAMENTO A SÓCIOS", debit: "15000.00" });
      expect(e.rows[0]!.lines[0]!.code.startsWith("1.1.4.")).toBe(true); // criada em Outros Créditos
      expect(e.rows[1]!.lines[0]).toMatchObject({ name: "DANIELLE DE BARROS SANTOS", debit: "4400.98" });
      expect(e.rows[2]!.history).toMatch(/juros e multas 32,50/);
      expect(e.rows[2]!.lines.map((l) => [l.code, l.debit, l.credit])).toEqual([["2.1.1.01", "1000.00", "0.00"], ["4.4.1.02", "32.50", "0.00"], [expect.any(String), "0.00", "1032.50"]]);
    });
  });
});
