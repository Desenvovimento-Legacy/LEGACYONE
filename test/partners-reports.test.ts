import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readEntityNfseTaxes } from "../src/modules/fiscal/withholdings.js";
import { importBankStatement } from "../src/modules/financial/bank-statements.js";
import { approveTakenServicesRule, pendingMovements, runAutoPosting } from "../src/modules/ledger/auto-posting.js";
import { applyStandardChart } from "../src/modules/ledger/ledger.js";
import { addAlias, bankText, identifyPartner, loadPartnerIndex, PartnerError, partnerRegistry } from "../src/modules/ledger/partners.js";
import { incomeStatement, ledgerDetail, openItems } from "../src/modules/ledger/reports.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { CNPJ_MATRIZ, CNPJ_PRESUMIDO } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const LUAN: Actor = { kind: "USER", id: "luan@legacy.test" };
const DELTA = CNPJ_PRESUMIDO;
const UNIMED = "16513178000176";
const COMPU = "11629916000121";
const CLIENTE = "60611420000136";

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

describe("cadastro de parceiros, razão, DRE e contas em aberto", () => {
  it("reconhece o parceiro no extrato, desempata, quita notas agrupadas e mostra o que está em aberto por parceiro", async () => {
    expect(bankText("PIX ENVIADO 08/09 DELTA SERV MANUT")).toBe("DELTA SERV MANUT");

    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    await newEntity(t, DELTA); // o fornecedor também é cliente do escritório
    let nsu = 0;
    await withTenant(appPool, t, async (tx) => {
      const taken = (prest: string, name: string, value: string, day: string, number: string) =>
        tx.query(
          `INSERT INTO nfse_document (id, tenant_id, entity_id, nsu, access_key, role, number, issued_at, provider_doc, provider_name, service_value, xml, sha256)
           VALUES ($1, current_tenant(), $2, $3, $4, 'TOMADA', $5, $6, $7, $8, $9, $10, $11)`,
          [newId(), entityId, ++nsu, `K${nsu}`, number, `${day}T10:00:00-03:00`, prest, name, value, nota(prest, value, day), createHash("sha256").update(`t${nsu}`).digest()],
        );
      const issued = (value: string, day: string, number: string) =>
        tx.query(
          `INSERT INTO nfse_document (id, tenant_id, entity_id, nsu, access_key, role, number, issued_at, taker_doc, taker_name, service_value, xml, sha256)
           VALUES ($1, current_tenant(), $2, $3, $4, 'PRESTADA', $5, $6, $7, 'SAFE ON SERVICOS LTDA', $8, '<x/>', $9)`,
          [newId(), entityId, ++nsu, `K${nsu}`, number, `${day}T10:00:00-03:00`, CLIENTE, value, createHash("sha256").update(`p${nsu}`).digest()],
        );
      const DN = "DELTA SERVICOS DE MANUTENCAO ELETRONICA LTDA";
      await taken(DELTA, DN, "1000.00", "2026-07-10", "D1");
      await taken(DELTA, DN, "1100.00", "2026-08-10", "D2");
      await taken(COMPU, "COMPU FORTE EQUIPAMENTOS E SISTEMAS LTDA", "1000.00", "2026-08-12", "C1");
      await taken(UNIMED, "UNIMED BELO HORIZONTE COOPERATIVA DE TRABALHO MEDICO", "300.00", "2026-09-05", "U1");
      await taken(UNIMED, "UNIMED BELO HORIZONTE COOPERATIVA DE TRABALHO MEDICO", "450.00", "2026-09-06", "U2");
      await issued("5000.00", "2026-07-20", "100");
      await issued("5000.00", "2026-08-20", "101");
    });
    await readEntityNfseTaxes(appPool, t, entityId);
    await applyStandardChart(appPool, t, entityId, "2026-07-01", LUAN);
    await approveTakenServicesRule(appPool, t, LUAN);

    await importBankStatement(appPool, t, entityId, { name: "b.ofx", bytes: Buffer.from(ofx([
      ["1", "20260820", "-1000,00", "PIX ENVIADO DELTA SERV MANUT"], // dois R$ 1.000 em aberto: o nome desempata (DELTA)
      ["2", "20260825", "-1100,00", `SISPAG FORNECEDOR ${DELTA}`], // CNPJ no histórico
      ["3", "20260915", "-750,00", "PIX ENVIADO UNIMED BH"], // 300 + 450 agrupados
      ["4", "20260916", "-999,00", "PIX ENVIADO UNIMED BH"], // não fecha: pendência com hipóteses
      ["5", "20260825", "5000,00", "PIX RECEBIDO SAFE ON"], // duas notas de 5.000 do mesmo cliente em aberto: quita a mais antiga (FIFO)
    ]), "latin1") }, LUAN);
    await runAutoPosting(appPool, t, entityId);

    await withTenant(appPool, t, async (tx) => {
      const m = await tx.query<{ method: string; n: number }>("SELECT method, count(*)::int AS n FROM bank_match GROUP BY method ORDER BY method");
      expect(m.rows).toEqual([{ method: "NFSE", n: 1 }, { method: "NFSE_TOMADA", n: 4 }]);
      // apelido aprendido no pagamento conciliado pelo nome
      const a = await tx.query("SELECT a.pattern, a.source FROM partner_alias a JOIN partner p ON p.id = a.partner_id WHERE p.doc = $1", [DELTA]);
      expect(a.rows).toEqual([{ pattern: "DELTA SERV MANUT", source: "APRENDIDO" }]);
      const idx = await loadPartnerIndex(tx, entityId);
      expect(identifyPartner(idx, "TED DELTA SERV MANUT 123", "FORNECEDOR")).toMatchObject({ doc: DELTA, via: "APELIDO" });
      expect(identifyPartner(idx, "PAGAMENTO BOLETO", "FORNECEDOR")).toBeNull();
    });
    const pend = await pendingMovements(appPool, t, entityId);
    expect(pend.map((p) => [p.amount, p.reason])).toEqual([
      ["-999.00", expect.stringMatching(/^Pagamento a UNIMED .*sem NFS-e em aberto$/)],
    ]);

    // Apelido só para parceiro existente e com texto que identifica
    await expect(withTenant(appPool, t, (tx) => addAlias(tx, entityId, newId(), "SAFE ON", LUAN))).rejects.toThrow(PartnerError);
    await expect(withTenant(appPool, t, (tx) => addAlias(tx, entityId, newId(), "PIX 123", LUAN))).rejects.toThrow(/curto/);

    await withTenant(appPool, t, async (tx) => {
      // Fornecedores em aberto: COMPU 1.000 (nota sem pagamento)
      const open = await openItems(tx, entityId, "2.1.1.01", "2026-09-30");
      expect(open.items.map((i) => [i.partnerDoc, i.balance])).toEqual([[COMPU, "-1000.00"]]);
      expect(open.total).toBe("-1000.00");
      const cli = await openItems(tx, entityId, "1.1.2.01", "2026-09-30");
      expect(cli.items).toEqual([expect.objectContaining({ partnerDoc: CLIENTE, partner: "SAFE ON SERVICOS LTDA", balance: "5000.00", lines: 3 })]);

      // Razão de Fornecedores filtrado pela DELTA: crédito das notas, débito dos pagamentos, saldo zerado
      const rz = await ledgerDetail(tx, entityId, "2.1.1.01", "2026-07-01", "2026-09-30", DELTA);
      expect(rz!.lines.map((l) => [l.date, l.debit, l.credit, l.balance])).toEqual([
        ["2026-07-10", "0.00", "1000.00", "-1000.00"],
        ["2026-08-10", "0.00", "1100.00", "-2100.00"],
        ["2026-08-20", "1000.00", "0.00", "-1100.00"],
        ["2026-08-25", "1100.00", "0.00", "0.00"],
      ]);
      expect(rz!.lines[2]!.partner).toBe("DELTA SERVICOS DE MANUTENCAO ELETRONICA LTDA");
      // Razão da conta sintética 2.1 a partir de setembro: saldo anterior = COMPU em aberto
      const syn = await ledgerDetail(tx, entityId, "2.1.1", "2026-09-01", "2026-09-30");
      expect(syn!.opening).toBe("-1000.00");
      expect(syn!.lines.at(-1)!.history).toMatch(/\[2\.1\.1\.01\]$/);

      // DRE: receita 5.000/mês; despesas de serviços tomados
      const dre = await incomeStatement(tx, entityId, "2026-08");
      const v = (k: string, l = dre.monthLines) => l.find((x) => x.key === k)!.value;
      expect(v("rb")).toBe("5000.00");
      expect(v("adm")).toBe("-2100.00");
      expect(v("res")).toBe("2900.00");
      expect(dre.ytdFrom).toBe("2026-07-01");
      expect(v("rb", dre.ytdLines)).toBe("10000.00");
      expect(v("res", dre.ytdLines)).toBe("6900.00");

      // Cadastro: DELTA recorrente (07 e 08) sem nota em 09 = esperada; é cliente do escritório
      const reg = await partnerRegistry(tx, entityId, "2026-09");
      const delta = reg.suppliers.find((p) => p.doc === DELTA)!;
      expect(delta).toMatchObject({ status: "ESPERADA", recurring: true, expected: "1050.00", officeClient: "ALPHA INDÚSTRIA LTDA", aliases: ["DELTA SERV MANUT"], open: "0.00", codes: ["171401"] });
      expect(delta.account).toEqual({ code: "4.3.1.06", source: "TABELA" });
      expect(reg.suppliers.find((p) => p.doc === UNIMED)).toMatchObject({ status: "NO_MES", recurring: false });
      expect(reg.suppliers.find((p) => p.doc === COMPU)).toMatchObject({ status: "EVENTUAL", open: "-1000.00" });
      expect(reg.customers).toEqual([expect.objectContaining({ doc: CLIENTE, status: "ESPERADA", open: "5000.00" })]);
      expect(reg.expectedMissing.map((e) => e.doc).sort()).toEqual([CLIENTE, DELTA].sort());
      const ev = await tx.query("SELECT payload FROM outbox WHERE type = 'PARTNERS_REGISTERED'");
      expect(ev.rows[0].payload).toMatchObject({ suppliers: 3, customers: 1 });
    });

    // Apelido informado por pessoa para o cliente
    const cliId = await withTenant(appPool, t, async (tx) => (await tx.query("SELECT id FROM partner WHERE doc = $1", [CLIENTE])).rows[0].id as string);
    await expect(withTenant(appPool, t, (tx) => addAlias(tx, entityId, cliId, "SAFE ON", { kind: "AGENT", id: "x" }))).rejects.toThrow(PartnerError);
    expect(await withTenant(appPool, t, (tx) => addAlias(tx, entityId, cliId, "pix recebido Safe On", LUAN))).toBe("SAFE ON");
  });
});
