import { describe, expect, it } from "vitest";
import { readNfeItems } from "../src/integrations/sefaz/nfe-items.js";
import { credits, entryCfop, itemChecks } from "../src/modules/fiscal/cfop-rules.js";
import { nfeItemsOverview, readEntityNfeItems } from "../src/modules/fiscal/nfe-items.js";
import { ingestFiles } from "../src/modules/documents/xml-intake.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const LUAN: Actor = { kind: "USER", id: "luan" };
const SUPPLIER = "44555666000177";
type It = { cfop: string; csosn?: string; cst?: string; v: string; cred?: [string, string]; st?: string; pis?: string; ipi?: string; icms?: [string, string, string] };
const nfe = (key: string, crt: string, idDest: string, ufDest: string, items: It[]) =>
  `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${key}" versao="4.00"><ide><mod>55</mod><nNF>10</nNF><dhEmi>2026-09-10T10:00:00-03:00</dhEmi><tpNF>1</tpNF><idDest>${idDest}</idDest><finNFe>1</finNFe><natOp>VENDA</natOp></ide>` +
  `<emit><CNPJ>${SUPPLIER}</CNPJ><xNome>DISTRIBUIDORA TESTE</xNome><enderEmit><UF>MG</UF></enderEmit><CRT>${crt}</CRT></emit><dest><CNPJ>${CNPJ_MATRIZ}</CNPJ><enderDest><UF>${ufDest}</UF></enderDest></dest>` +
  items.map((i, n) => `<det nItem="${n + 1}"><prod><cProd>P${n}</cProd><xProd>PRODUTO ${n}</xProd><NCM>02013000</NCM><CFOP>${i.cfop}</CFOP><uCom>KG</uCom><qCom>10.0000</qCom><vProd>${i.v}</vProd></prod><imposto>` +
    (i.csosn ? `<ICMS><ICMSSN${i.csosn}><orig>0</orig><CSOSN>${i.csosn}</CSOSN>${i.cred ? `<pCredSN>${i.cred[0]}</pCredSN><vCredICMSSN>${i.cred[1]}</vCredICMSSN>` : ""}${i.st ? `<vICMSSTRet>${i.st}</vICMSSTRet>` : ""}</ICMSSN${i.csosn}></ICMS>`
      : `<ICMS><ICMS${i.cst}><orig>0</orig><CST>${i.cst}</CST>${i.icms ? `<vBC>${i.icms[0]}</vBC><pICMS>${i.icms[1]}</pICMS><vICMS>${i.icms[2]}</vICMS>` : ""}</ICMS${i.cst}></ICMS>`) +
    (i.ipi ? `<IPI><IPITrib><CST>50</CST><vIPI>${i.ipi}</vIPI></IPITrib></IPI>` : "") +
    `<PIS><PISAliq><CST>${i.pis ?? "01"}</CST><vPIS>0.00</vPIS></PISAliq></PIS><COFINS><COFINSAliq><CST>${i.pis ?? "01"}</CST><vCOFINS>0.00</vCOFINS></COFINSAliq></COFINS></imposto></det>`).join("") +
  `<total><ICMSTot><vNF>1</vNF></ICMSTot></total></infNFe></NFe><protNFe versao="4.00"><infProt><chNFe>${key}</chNFe><cStat>100</cStat></infProt></protNFe></nfeProc>`;
const K1 = "31260944555666000177550010000000101000000010";
const K2 = "31260944555666000177550010000000111000000011";

describe("Fiscal: itens da NF-e (CFOP, CST, ST) e créditos", () => {
  it("lê os itens e confere CFOP × destino, CST × regime do emitente e CFOP de ST", () => {
    const r = readNfeItems(nfe(K2, "3", "1", "SP", [{ cfop: "6102", cst: "00", v: "100.00", icms: ["100.00", "12.0000", "12.00"] }, { cfop: "5405", cst: "00", v: "50.00" }, { cfop: "5102", csosn: "102", v: "10.00" }]))!;
    expect(r.header).toMatchObject({ accessKey: K2, issuerCrt: "3", idDest: "1", issuerUf: "MG", recipientUf: "SP", authorized: true });
    expect(r.items[0]).toMatchObject({ cfop: "6102", icmsCst: "00", icmsValue: "12.00", icmsRate: "12.0000" });
    const codes = r.items.map((i) => itemChecks(r.header, i).map((c) => c.code));
    expect(codes[0]).toEqual(["CFOP_DESTINO", "CFOP_DESTINO"]); // 6102 numa operação interna, e UFs diferentes
    expect(codes[1]).toEqual(["CFOP_DESTINO", "CFOP_ST_SEM_CST"]);
    expect(codes[2]).toContain("CST_REGIME"); // regime normal usando CSOSN
  });

  it("CFOP de entrada pela destinação; crédito pelo regime (Simples não se aplica; Real e Presumido conforme a lei)", () => {
    expect(entryCfop("5102", "REVENDA")).toMatchObject({ cfop: "1102" });
    expect(entryCfop("6102", "USO_CONSUMO")).toMatchObject({ cfop: "2556" });
    expect(entryCfop("5405", "REVENDA")).toMatchObject({ cfop: "1403" });
    expect(entryCfop("5910", null)).toMatchObject({ cfop: "1910" });
    expect(entryCfop("5102", null)).toMatchObject({ cfop: null });
    const it = readNfeItems(nfe(K1, "1", "1", "MG", [{ cfop: "5102", csosn: "101", v: "1000.00", cred: ["2.5000", "25.00"] }]))!.items[0]!;
    expect(credits("SIMPLES_NACIONAL", it, "1102").every((c) => c.status === "NAO_SE_APLICA")).toBe(true);
    const real = credits("LUCRO_REAL_ANUAL", it, "1102");
    expect(real.find((c) => c.tax === "ICMS")).toMatchObject({ status: "APROPRIAVEL", value: "25.00" });
    expect(real.find((c) => c.tax === "PIS")).toMatchObject({ status: "APROPRIAVEL", value: "16.50" });
    expect(real.find((c) => c.tax === "COFINS")).toMatchObject({ status: "APROPRIAVEL", value: "76.00" });
    const pres = credits("LUCRO_PRESUMIDO", it, "1556");
    expect(pres.find((c) => c.tax === "ICMS")).toMatchObject({ status: "NAO_SE_APLICA" });
    expect(pres.find((c) => c.tax === "PIS")!.reason).toMatch(/cumulativo/);
    const mono = readNfeItems(nfe(K1, "3", "1", "MG", [{ cfop: "5405", cst: "60", v: "200.00", pis: "04" }]))!.items[0]!;
    const m = credits("LUCRO_REAL_ANUAL", mono, "1403");
    expect(m.find((c) => c.tax === "ICMS")!.reason).toMatch(/ICMS-ST/);
    expect(m.find((c) => c.tax === "PIS")!.reason).toMatch(/monofásico/);
  });

  it("agente lê as NF-e recebidas, grava itens e créditos, e mostra o resumo", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    await withTenant(appPool, t, (tx) =>
      tx.query("INSERT INTO tax_regime_history (id, tenant_id, entity_id, regime, valid_from, source) VALUES ($1, current_tenant(), $2, 'SIMPLES_NACIONAL', '2020-01-01', 'teste')", [newId(), entityId]));
    await ingestFiles(appPool, t, [{ name: "c.xml", bytes: Buffer.from(nfe(K1, "1", "1", "MG", [{ cfop: "5102", csosn: "101", v: "1000.00", cred: ["2.5000", "25.00"] }, { cfop: "5405", csosn: "500", v: "300.00", st: "30.00" }])) }], { source: "UPLOAD", actor: LUAN });
    const r = await readEntityNfeItems(appPool, t, entityId);
    expect(r).toMatchObject({ documents: 1, items: 2 });
    expect((await readEntityNfeItems(appPool, t, entityId)).items).toBe(0); // idempotente
    await withTenant(appPool, t, async (tx) => {
      const o = await nfeItemsOverview(tx, entityId);
      expect(o.months).toEqual([expect.objectContaining({ competence: "2026-09-01", direction: "ENTRADA", notes: 1, items: 2, value: "1300.00", st: "300.00" })]);
      expect(o.credits.every((c) => c.status === "NAO_SE_APLICA")).toBe(true);
      expect(o.credits).toHaveLength(4);
      expect(o.destination).toBeNull();
      expect(o.entries.map((e) => [e.cfop, e.entry_cfop])).toEqual(expect.arrayContaining([["5102", null], ["5405", null]]));
      const ev = await tx.query("SELECT payload FROM outbox WHERE type = 'NFE_ITEMS_READ'");
      expect(ev.rows[0].payload).toMatchObject({ documents: 1, items: 2 });
    });
  });
});
