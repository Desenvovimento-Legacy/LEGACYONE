import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readEntityNfseTaxes } from "../src/modules/fiscal/withholdings.js";
import { importBankStatement } from "../src/modules/financial/bank-statements.js";
import { approveAccountingRule, approveTakenServicesRule, REVENUE_RETENTIONS_RULE, runAutoPosting } from "../src/modules/ledger/auto-posting.js";
import { closeMonth, closingStatus, reopenMonth } from "../src/modules/ledger/closing.js";
import { applyStandardChart, LedgerError, PeriodClosedError, postEntry } from "../src/modules/ledger/ledger.js";
import { balanceSheet } from "../src/modules/ledger/reports.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const LUAN: Actor = { kind: "USER", id: "luan@legacy.test" };
const TOMADOR = "60611420000136";
const PRESTADOR = "17889141000100";

const issued = (o: { serv: string; day: string; cp?: string; iss?: string }) => {
  const ret = o.cp || o.iss;
  const total = (Number(o.cp ?? 0) + Number(o.iss ?? 0)).toFixed(2);
  return `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS1"><nNFSe>1</nNFSe><emit><CNPJ>${CNPJ_MATRIZ}</CNPJ><xNome>NOS</xNome></emit>` +
    `<valores>${o.iss ? `<vISSQN>${o.iss}</vISSQN>` : ""}${ret ? `<vTotalRet>${total}</vTotalRet>` : ""}<vLiq>${(Number(o.serv) - Number(ret ? total : 0)).toFixed(2)}</vLiq></valores>` +
    `<DPS versao="1.01"><infDPS Id="DPS1"><dhEmi>${o.day}T10:00:00-03:00</dhEmi><dCompet>${o.day}</dCompet>` +
    `<prest><CNPJ>${CNPJ_MATRIZ}</CNPJ><regTrib><opSimpNac>3</opSimpNac></regTrib></prest><toma><CNPJ>${TOMADOR}</CNPJ></toma>` +
    `<serv><cServ><cTribNac>070201</cTribNac></cServ></serv><valores><vServPrest><vServ>${o.serv}</vServ></vServPrest><trib><tribMun><tpRetISSQN>${o.iss ? 2 : 1}</tpRetISSQN></tribMun>` +
    `<tribFed>${o.cp ? `<vRetCP>${o.cp}</vRetCP>` : ""}</tribFed></trib></valores></infDPS></DPS></infNFSe></NFSe>`;
};
const taken = (serv: string, day: string) =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS1"><nNFSe>1</nNFSe><emit><CNPJ>${PRESTADOR}</CNPJ><xNome>X</xNome></emit>` +
  `<valores><vLiq>${serv}</vLiq></valores><DPS versao="1.01"><infDPS Id="DPS1"><dhEmi>${day}T10:00:00-03:00</dhEmi><dCompet>${day}</dCompet>` +
  `<prest><CNPJ>${PRESTADOR}</CNPJ><regTrib><opSimpNac>3</opSimpNac></regTrib></prest><toma><CNPJ>${CNPJ_MATRIZ}</CNPJ></toma>` +
  `<serv><cServ><cTribNac>171401</cTribNac></cServ></serv><valores><vServPrest><vServ>${serv}</vServ></vServPrest><trib><tribMun><tpRetISSQN>1</tpRetISSQN></tribMun>` +
  `<tribFed></tribFed></trib></valores></infDPS></DPS></infNFSe></NFSe>`;

describe("fechamento da competência", () => {
  it("receita com retenção (regra aprovada), conferências, fechar, bloquear, reabrir e balanço", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    let nsu = 0;
    const putNote = (role: "PRESTADA" | "TOMADA", xml: string, value: string, day: string, number: string) =>
      withTenant(appPool, t, (tx) =>
        tx.query(
          `INSERT INTO nfse_document (id, tenant_id, entity_id, nsu, access_key, role, number, issued_at, provider_doc, provider_name, taker_doc, taker_name, service_value, xml, sha256)
           VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [newId(), entityId, ++nsu, `K${nsu}`, role, number, `${day}T10:00:00-03:00`,
            role === "TOMADA" ? PRESTADOR : CNPJ_MATRIZ, role === "TOMADA" ? "MANUTENCAO X LTDA" : "NOS",
            role === "TOMADA" ? CNPJ_MATRIZ : TOMADOR, role === "TOMADA" ? "NOS" : "SAFE ON SERVICOS LTDA", value, xml, createHash("sha256").update(xml + nsu).digest()],
        ),
      );
    await withTenant(appPool, t, (tx) =>
      tx.query("INSERT INTO tax_regime_history (id, tenant_id, entity_id, regime, valid_from, source) VALUES ($1, current_tenant(), $2, 'SIMPLES_NACIONAL', '2026-01-01', 'teste')", [newId(), entityId]),
    );
    await putNote("PRESTADA", issued({ serv: "1000.00", day: "2026-08-05" }), "1000.00", "2026-08-05", "1");
    await putNote("PRESTADA", issued({ serv: "2000.00", day: "2026-08-10", cp: "220.00", iss: "100.00" }), "2000.00", "2026-08-10", "2");
    await putNote("TOMADA", taken("500.00", "2026-08-12"), "500.00", "2026-08-12", "T1");
    await readEntityNfseTaxes(appPool, t, entityId);
    await applyStandardChart(appPool, t, entityId, "2026-08-01", LUAN);
    await approveTakenServicesRule(appPool, t, LUAN);

    // Sem a regra de retenção, a nota 2 espera; sem provisão do Simples e sem extrato, não fecha.
    let st = await closingStatus(appPool, t, entityId, "2026-08");
    const by = (k: string) => st.checks.find((c) => c.key === k)!;
    expect(by("nfse_prestadas")).toMatchObject({ status: "PENDENTE", detail: expect.stringMatching(/1 nota.*retenção do tomador/) });
    expect(by("nfse_tomadas").status).toBe("OK");
    expect(by("simples").status).toBe("PENDENTE");
    expect(by("extrato").status).toBe("PENDENTE");
    expect(st.canClose).toBe(false);
    await expect(closeMonth(appPool, t, entityId, "2026-08", LUAN)).rejects.toThrow(/Não dá para fechar 08\/2026/);

    // Regra de receita com retenção aprovada: conta 3.2.1.03 entra no plano e a nota é lançada pela própria nota
    await expect(approveAccountingRule(appPool, t, REVENUE_RETENTIONS_RULE, { kind: "AGENT", id: "x" })).rejects.toThrow(LedgerError);
    expect(await approveAccountingRule(appPool, t, REVENUE_RETENTIONS_RULE, LUAN)).toMatchObject({ posted: 1 });
    await withTenant(appPool, t, async (tx) => {
      const l = await tx.query(
        `SELECT c.code, l.debit::text, l.credit::text FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN chart_account c ON c.id = l.account_id
          WHERE e.rule_ref = $1 ORDER BY l.seq`, [REVENUE_RETENTIONS_RULE]);
      expect(l.rows).toEqual([
        { code: "1.1.2.01", debit: "1680.00", credit: "0.00" },
        { code: "1.1.3.03", debit: "220.00", credit: "0.00" },
        { code: "3.2.1.03", debit: "100.00", credit: "0.00" },
        { code: "3.1.1.01", debit: "0.00", credit: "2000.00" },
      ]);
    });

    // Simples declarado e extrato do mês inteiro: recebimentos (líquido) e pagamento conciliados
    await withTenant(appPool, t, async (tx) => {
      const pdf = newId();
      await tx.query("INSERT INTO pgdas_declaration_pdf (id, tenant_id, entity_id, competence, kind, pdf, sha256) VALUES ($1, current_tenant(), $2, '2026-08-01', 'DECLARACAO', 'x', $3)",
        [pdf, entityId, createHash("sha256").update("pdf").digest()]);
      await tx.query(
        `INSERT INTO pgdas_declared_tax (id, tenant_id, entity_id, competence, declaration_number, pdf_id, seq, activity, annex, local_withheld,
                                         revenue, irpj, csll, cofins, pis, cpp, icms, ipi, iss, total, parser)
         VALUES ($1, current_tenant(), $2, '2026-08-01', '1', $3, 1, 'Serviços', 'III', true, 3000, 0, 0, 0, 0, 0, 0, 0, 0, 180, 'pgdas-pdf-2')`,
        [newId(), entityId, pdf],
      );
    });
    const ofx = `OFXHEADER:100\r\n<OFX>\r\n<BANKMSGSRSV1>\r\n<STMTTRNRS>\r\n<STMTRS>\r\n<BANKACCTFROM>\r\n<BANKID>0341\r\n<ACCTID>1-1\r\n</BANKACCTFROM>\r\n<BANKTRANLIST>\r\n<DTSTART>20260801\r\n<DTEND>20260831\r\n` +
      [["1", "20260806", "1000,00", "PIX RECEBIDO SAFE"], ["2", "20260815", "1680,00", "PIX RECEBIDO SAFE"], ["3", "20260820", "-500,00", "PIX ENVIADO MANUT"]]
        .map(([id, dd, a, m]) => `<STMTTRN>\r\n<TRNTYPE>OTHER\r\n<DTPOSTED>${dd}\r\n<TRNAMT>${a}\r\n<FITID>${id}\r\n<MEMO>${m}\r\n</STMTTRN>\r\n`).join("") +
      `</BANKTRANLIST>\r\n</STMTRS>\r\n</STMTTRNRS>\r\n</BANKMSGSRSV1>\r\n</OFX>\r\n`;
    await importBankStatement(appPool, t, entityId, { name: "ago.ofx", bytes: Buffer.from(ofx, "latin1") }, LUAN);
    expect(await runAutoPosting(appPool, t, entityId)).toMatchObject({ pendingBank: 0, pendingFiscal: 0 });

    st = await closingStatus(appPool, t, entityId, "2026-08");
    expect(st.checks.filter((c) => c.status !== "OK" && c.status !== "NAO_SE_APLICA").map((c) => [c.key, c.status, c.detail])).toEqual([]);
    expect(st.canClose).toBe(true);
    expect(st.totals!.result).toBe("2220.00"); // 3.000 − 100 ISS − 180 Simples − 500 serviço

    // Balanço fecha: ativo 2.180 banco + 220 INSS a recuperar = passivo 180 + resultado 2.220
    const bp = await withTenant(appPool, t, (tx) => balanceSheet(tx, entityId, "2026-08-31"));
    expect(bp.totals).toMatchObject({ ativo: "2400.00", passivo: "180.00", pl: "2220.00", balanced: true });

    // Fechar: só pessoa; Case concluído, competência bloqueada, evento
    await expect(closeMonth(appPool, t, entityId, "2026-08", { kind: "AGENT", id: "ledger" })).rejects.toThrow(LedgerError);
    const closed = await closeMonth(appPool, t, entityId, "2026-08", LUAN);
    await expect(closeMonth(appPool, t, entityId, "2026-08", LUAN)).rejects.toThrow(/já está fechada/);
    await withTenant(appPool, t, async (tx) => {
      const c = await tx.query("SELECT type, status, competence::text FROM \"case\" WHERE id = $1", [closed.caseId]);
      expect(c.rows[0]).toEqual({ type: "ACCOUNTING_CLOSING", status: "COMPLETED", competence: "2026-08-01" });
      const ev = await tx.query("SELECT payload FROM outbox WHERE type = 'ACCOUNTING_CLOSING_COMPLETED'");
      expect(ev.rows[0].payload).toMatchObject({ competence: "2026-08-01", result: "2220.00" });
      await expect(postEntry(tx, { entityId, date: "2026-08-15", history: "x", origin: "MANUAL", idempotencyKey: "x1",
        lines: [{ account: "4.3.1.99", debit: "1.00" }, { account: "2.1.1.01", credit: "1.00" }] }, LUAN)).rejects.toThrow(PeriodClosedError);
    });
    expect((await closingStatus(appPool, t, entityId, "2026-08")).locked).toBe(true);
    expect((await closingStatus(appPool, t, entityId, "2026-09")).checks.find((c) => c.key === "anteriores")!.status).toBe("OK");

    // Nota de agosto que chega depois do fechamento: não entra; fica contada até reabrir
    await putNote("TOMADA", taken("300.00", "2026-08-25"), "300.00", "2026-08-25", "T2");
    await readEntityNfseTaxes(appPool, t, entityId);
    expect(await runAutoPosting(appPool, t, entityId)).toMatchObject({ posted: 0, lockedItems: 1 });

    await expect(reopenMonth(appPool, t, entityId, "2026-08", "", LUAN)).rejects.toThrow(/motivo/);
    await reopenMonth(appPool, t, entityId, "2026-08", "nota de manutenção chegou depois", LUAN);
    await expect(reopenMonth(appPool, t, entityId, "2026-08", "de novo sem estar fechada", LUAN)).rejects.toThrow(/não está fechada/);
    expect(await runAutoPosting(appPool, t, entityId)).toMatchObject({ posted: 1, lockedItems: 0 });
    const again = await closingStatus(appPool, t, entityId, "2026-08");
    expect(again.locked).toBe(false);
    expect(again.totals!.result).toBe("1920.00");
  });
});
