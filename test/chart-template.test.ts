import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readEntityNfseTaxes } from "../src/modules/fiscal/withholdings.js";
import { importBankStatement } from "../src/modules/financial/bank-statements.js";
import { approveTakenServicesRule, runAutoPosting } from "../src/modules/ledger/auto-posting.js";
import { importChartTemplate, parseDominioChart } from "../src/modules/ledger/chart-template.js";
import { closingStatus } from "../src/modules/ledger/closing.js";
import { applyStandardChart, LedgerError } from "../src/modules/ledger/ledger.js";
import { incomeStatement } from "../src/modules/ledger/reports.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const LUAN: Actor = { kind: "USER", id: "luan@legacy.test" };

// Relatório "Plano de Contas" do Domínio salvo em CSV (recorte do modelo do escritório).
const ACCOUNTS: [string, boolean, string, string][] = [
  ["1", true, "1", "ATIVO"], ["2", true, "1.1", "ATIVO CIRCULANTE"], ["3", true, "1.1.1", "DISPONÍVEL"],
  ["7", true, "1.1.1.02", "BANCOS CONTA MOVIMENTO"], ["8", false, "1.1.1.02.000001", "BANCO DO BRASIL"],
  ["12", true, "1.1.2", "CLIENTES"], ["13", true, "1.1.2.01", "DUPLICATAS A RECEBER"], ["10000", false, "1.1.2.01.000001", "CLIENTES"],
  ["18", true, "1.1.3", "OUTROS CRÉDITOS"], ["28", true, "1.1.3.08", "TRIBUTOS A RECUPERAR/COMPENSAR"],
  ["31", false, "1.1.3.08.000003", "IRRF A RECUPERAR"], ["38", false, "1.1.3.08.000010", "INSS A COMPENSAR"],
  ["596", false, "1.1.3.08.000017", "TRIBUTOS FEDERAIS A COMPENSAR (DCTF Web)"],
  ["149", true, "2", "PASSIVO"], ["150", true, "2.1", "PASSIVO CIRCULANTE"], ["164", true, "2.1.3", "FORNECEDORES"],
  ["165", true, "2.1.3.01", "FORNECEDORES"], ["10001", false, "2.1.3.01.000001", "FORNECEDORES"],
  ["169", true, "2.1.4", "OBRIGAÇÕES TRIBUTÁRIAS"], ["170", true, "2.1.4.01", "IMPOSTOS E CONTRIBUIÇÕES A RECOLHER"],
  ["178", false, "2.1.4.01.000008", "IRRF A RECOLHER"], ["182", false, "2.1.4.01.000012", "CRF A RECOLHER"],
  ["183", false, "2.1.4.01.000013", "ISS RETIDO A RECOLHER"], ["184", false, "2.1.4.01.000014", "INSS RETIDO A RECOLHER"],
  ["479", false, "2.1.4.01.000015", "SIMPLES NACIONAL A RECOLHER"],
  ["185", true, "2.1.5", "OBRIGAÇÕES TRABALHISTA E PREVIDENCIÁRIA"], ["190", true, "2.1.5.02", "OBRIGAÇÕES SOCIAIS"],
  ["191", false, "2.1.5.02.000001", "INSS A RECOLHER"],
  ["242", true, "2.3", "PATRIMÔNIO LÍQUIDO"], ["243", true, "2.3.1", "CAPITAL SOCIAL"], ["244", true, "2.3.1.01", "CAPITAL SUBSCRITO"],
  ["245", false, "2.3.1.01.000001", "CAPITAL SOCIAL"],
  ["402", true, "3", "CONTAS DE RESULTADO - RECEITAS"], ["403", true, "3.1", "RECEITAS OPERACIONAIS"],
  ["404", true, "3.1.1", "RECEITA BRUTA DE VENDAS E SERVIÇOS"], ["410", true, "3.1.1.02", "RECEITA DE PRESTAÇÃO DE SERVIÇOS"],
  ["411", false, "3.1.1.02.000001", "SERVIÇOS PRESTADOS"],
  ["413", true, "3.1.2", "(-) DEDUÇÕES DA RECEITA BRUTA"], ["424", true, "3.1.2.03", "(-) IMPOSTOS SOBRE VENDAS E SERVIÇOS"],
  ["427", false, "3.1.2.03.000003", "(-) ISS"], ["480", false, "3.1.2.03.000008", "(-) SIMPLES NACIONAL"],
  ["430", true, "3.1.3", "RECEITAS FINANCEIRAS"],
  ["269", true, "4", "CONTAS DE RESULTADOS - CUSTOS E DESPESAS"], ["500", true, "4.1", "CUSTOS"],
  ["295", true, "4.2", "DESPESAS OPERACIONAIS"], ["329", true, "4.2.2", "DESPESAS ADMINISTRATIVAS"],
  ["345", true, "4.2.2.03", "IMPOSTOS, TAXAS E CONTRIBUIÇÕES"], ["352", false, "4.2.2.03.000007", "MULTAS DE MORA"],
  ["566", true, "4.2.2.05", "SERVICOS TOMADOS DE PJ"], ["573", false, "4.2.2.05.000007", "SERVS. ADVOCATICIOS"],
  ["367", true, "4.2.2.06", "DESPESAS FINANCEIRAS"], ["372", false, "4.2.2.06.000005", "JUROS DE MORA"],
  ["526", false, "4.2.2.06.000010", "MULTAS DE MORA"], ["535", false, "4.2.2.06.000011", "TARIFA BANCÁRIA"],
];
const csv = ["Empresa:,,,,,FURK TECH LTDA,,,,,,,,,,,,,Folha:,,,0001,", "PLANO DE CONTAS,,,,,,,,,,,,,,,,,,,,,,", ",Código,,T,,,,Classificação,,,,Nome,,,,,,,,,,,Grau",
  ...ACCOUNTS.map(([short, s, code, name]) => `${short},,,${s ? "S" : ""},,,,${code},,,,${",".repeat(code.split(".").length - 1)}"${name}",,,,,,,${code.split(".").length},`)].join("\r\n");

describe("plano de contas padrão do escritório (modelo do Domínio)", () => {
  it("importa o modelo, localiza as contas por nome, aplica na empresa e os lançamentos automáticos usam o plano novo", async () => {
    const parsed = parseDominioChart(csv);
    expect(parsed).toHaveLength(ACCOUNTS.length);
    expect(parsed.find((a) => a.code === "1")).toMatchObject({ name: "ATIVO", analytic: false, shortCode: "1", nature: "ATIVO", parentCode: null });
    expect(parsed.find((a) => a.code === "2.1.3.01.000001")).toMatchObject({ name: "FORNECEDORES", analytic: true, shortCode: "10001", nature: "PASSIVO", parentCode: "2.1.3.01" });

    const t = await newTenant();
    const file = { name: "Furk Tech (modelo)", fileName: "PLANO DE CONTAS PADRAO.csv", bytes: Buffer.from(csv, "latin1") };
    await expect(importChartTemplate(appPool, t, file, { kind: "AGENT", id: "x" })).rejects.toThrow(LedgerError);
    const imp = await importChartTemplate(appPool, t, file, LUAN);
    expect(imp.accounts).toBe(ACCOUNTS.length);
    expect(imp.roles).toMatchObject({
      CLIENTES: "1.1.2.01.000001", FORNECEDORES: "2.1.3.01.000001", RECEITA_SERVICOS: "3.1.1.02.000001", SIMPLES_DEDUCAO: "3.1.2.03.000008",
      SIMPLES_RECOLHER: "2.1.4.01.000015", BANCOS: "1.1.1.02", MULTA_MORA: "4.2.2.06.000010", INSS_RECOLHER: "2.1.5.02.000001",
    });
    expect(imp.unresolved).toContainEqual(expect.stringMatching(/^serviço INFORMATICA/));
    expect(imp.unresolved.some((u) => u.startsWith("CLIENTES"))).toBe(false);

    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    expect(await applyStandardChart(appPool, t, entityId, "2026-07-01", LUAN)).toMatchObject({ created: ACCOUNTS.length });
    await withTenant(appPool, t, async (tx) => {
      const c = await tx.query("SELECT short_code, source FROM chart_account WHERE entity_id = $1 AND code = '1.1.2.01.000001'", [entityId]);
      expect(c.rows[0]).toEqual({ short_code: "10000", source: "PADRAO_ESCRITORIO" });
      await tx.query("INSERT INTO tax_regime_history (id, tenant_id, entity_id, regime, valid_from, source) VALUES ($1, current_tenant(), $2, 'SIMPLES_NACIONAL', '2026-01-01', 'teste')", [newId(), entityId]);
      await tx.query(
        `INSERT INTO nfse_document (id, tenant_id, entity_id, nsu, role, number, issued_at, taker_doc, taker_name, service_value, xml, sha256)
         VALUES ($1, current_tenant(), $2, 1, 'PRESTADA', '10', '2026-07-10T10:00:00-03:00', '60611420000136', 'CLIENTE X', 1000, '<x/>', $3)`,
        [newId(), entityId, createHash("sha256").update("n1").digest()],
      );
      const xml = `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="N"><nNFSe>1</nNFSe><emit><CNPJ>17889141000100</CNPJ></emit><valores><vLiq>300.00</vLiq></valores>` +
        `<DPS versao="1.01"><infDPS Id="D"><dhEmi>2026-07-12T10:00:00-03:00</dhEmi><dCompet>2026-07-12</dCompet><prest><CNPJ>17889141000100</CNPJ><regTrib><opSimpNac>3</opSimpNac></regTrib></prest>` +
        `<toma><CNPJ>${CNPJ_MATRIZ}</CNPJ></toma><serv><cServ><cTribNac>171401</cTribNac></cServ></serv><valores><vServPrest><vServ>300.00</vServ></vServPrest><trib><tribMun><tpRetISSQN>1</tpRetISSQN></tribMun><tribFed></tribFed></trib></valores></infDPS></DPS></infNFSe></NFSe>`;
      await tx.query(
        `INSERT INTO nfse_document (id, tenant_id, entity_id, nsu, role, number, issued_at, provider_doc, provider_name, service_value, xml, sha256)
         VALUES ($1, current_tenant(), $2, 2, 'TOMADA', 'A1', '2026-07-12T10:00:00-03:00', '17889141000100', 'ADVOGADOS', 300, $3, $4)`,
        [newId(), entityId, xml, createHash("sha256").update("n2").digest()],
      );
      const pdf = newId();
      await tx.query("INSERT INTO pgdas_declaration_pdf (id, tenant_id, entity_id, competence, kind, pdf, sha256) VALUES ($1, current_tenant(), $2, '2026-07-01', 'DECLARACAO', 'x', $3)",
        [pdf, entityId, createHash("sha256").update("p").digest()]);
      await tx.query(
        `INSERT INTO pgdas_declared_tax (id, tenant_id, entity_id, competence, declaration_number, pdf_id, seq, activity, annex, local_withheld,
                                         revenue, irpj, csll, cofins, pis, cpp, icms, ipi, iss, total, parser)
         VALUES ($1, current_tenant(), $2, '2026-07-01', '1', $3, 1, 'Serviços', 'III', false, 1000, 0, 0, 0, 0, 0, 0, 0, 0, 60, 'pgdas-pdf-2')`,
        [newId(), entityId, pdf],
      );
    });
    await readEntityNfseTaxes(appPool, t, entityId);
    await approveTakenServicesRule(appPool, t, LUAN);
    await runAutoPosting(appPool, t, entityId);

    const ofx = `OFXHEADER:100\r\n<OFX>\r\n<BANKMSGSRSV1>\r\n<STMTTRNRS>\r\n<STMTRS>\r\n<BANKACCTFROM>\r\n<BANKID>0237\r\n<ACCTID>9-9\r\n</BANKACCTFROM>\r\n<BANKTRANLIST>\r\n<DTSTART>20260701\r\n<DTEND>20260731\r\n` +
      `<STMTTRN>\r\n<TRNTYPE>OTHER\r\n<DTPOSTED>20260715\r\n<TRNAMT>1000,00\r\n<FITID>1\r\n<MEMO>PIX RECEBIDO CLIENTE X\r\n</STMTTRN>\r\n</BANKTRANLIST>\r\n</STMTRS>\r\n</STMTTRNRS>\r\n</BANKMSGSRSV1>\r\n</OFX>\r\n`;
    expect(await importBankStatement(appPool, t, entityId, { name: "b.ofx", bytes: Buffer.from(ofx, "latin1") }, LUAN)).toMatchObject({ ledgerAccount: "1.1.1.02.000002" });
    await runAutoPosting(appPool, t, entityId);

    await withTenant(appPool, t, async (tx) => {
      const l = await tx.query<{ origin: string; code: string; debit: string; credit: string }>(
        `SELECT e.origin, c.code, l.debit::text, l.credit::text FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN chart_account c ON c.id = l.account_id
          WHERE l.entity_id = $1 ORDER BY e.entry_date, e.created_at, l.seq`, [entityId]);
      expect(l.rows).toEqual([
        { origin: "FISCAL", code: "1.1.2.01.000001", debit: "1000.00", credit: "0.00" },
        { origin: "FISCAL", code: "3.1.1.02.000001", debit: "0.00", credit: "1000.00" },
        { origin: "FISCAL", code: "4.2.2.05.000007", debit: "300.00", credit: "0.00" },
        { origin: "FISCAL", code: "2.1.3.01.000001", debit: "0.00", credit: "300.00" },
        { origin: "BANCO", code: "1.1.1.02.000002", debit: "1000.00", credit: "0.00" },
        { origin: "BANCO", code: "1.1.2.01.000001", debit: "0.00", credit: "1000.00" },
        { origin: "TRIBUTOS", code: "3.1.2.03.000008", debit: "60.00", credit: "0.00" },
        { origin: "TRIBUTOS", code: "2.1.4.01.000015", debit: "0.00", credit: "60.00" },
      ]);
      const dre = await incomeStatement(tx, entityId, "2026-07");
      const v = (k: string) => dre.monthLines.find((x) => x.key === k)?.value;
      expect([v("rb"), v("ded"), v("adm"), v("res")]).toEqual(["1000.00", "-60.00", "-300.00", "640.00"]);
    });
    const st = await closingStatus(appPool, t, entityId, "2026-07");
    expect(st.checks.find((c) => c.key === "simples")!.status).toBe("OK");
  });
});
