import { mkdtempSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { parseFiscalXml, roleOf } from "../src/integrations/fiscal-xml/parse.js";
import { cteDistNsuEnvelope, parseDistResponse, type DfeDistribution, type DistResult } from "../src/integrations/sefaz/dist-dfe.js";
import { syncEntityDfe } from "../src/modules/documents/dfe-sync.js";
import { fiscalXmlList, ingestFiles, scanInbox } from "../src/modules/documents/xml-intake.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const LUAN: Actor = { kind: "USER", id: "luan@legacy.test" };
const K_NFCE = "31261012ABC34501DE35650010000000011000000011";
const K_NFE = "31261098765432000110550010000099991000099999";
const K_CTE = "42261011222333000181570010000004561000004561";

const nfce = (n: string, v: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${K_NFCE.slice(0, 34)}${n.padStart(10, "0")}" versao="4.00"><ide><mod>65</mod><nNF>${n}</nNF><dhEmi>2026-09-15T12:00:00-03:00</dhEmi></ide><emit><CNPJ>${CNPJ_MATRIZ}</CNPJ><xNome>LANCHONETE TESTE</xNome></emit><total><ICMSTot><vNF>${v}</vNF></ICMSTot></total></infNFe></NFe><protNFe><infProt><cStat>100</cStat></infProt></protNFe></nfeProc>`;
const nfeCompra = `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${K_NFE}"><ide><mod>55</mod><nNF>9999</nNF><dhEmi>2026-09-10T09:00:00-03:00</dhEmi></ide><emit><CNPJ>98765432000110</CNPJ><xNome>FORNECEDOR SA</xNome></emit><dest><CNPJ>${CNPJ_MATRIZ}</CNPJ><xNome>LANCHONETE TESTE</xNome></dest><total><ICMSTot><vNF>1200.00</vNF></ICMSTot></total></infNFe></NFe><protNFe><infProt><cStat>100</cStat></infProt></protNFe></nfeProc>`;
const cancel = `<procEventoNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><evento><infEvento><CNPJ>${CNPJ_MATRIZ}</CNPJ><chNFe>${K_NFCE.slice(0, 34)}0000000001</chNFe><dhEvento>2026-09-15T12:30:00-03:00</dhEvento><tpEvento>110111</tpEvento></infEvento></evento><retEvento><infEvento><cStat>135</cStat></infEvento></retEvento></procEventoNFe>`;
const cte = `<cteProc xmlns="http://www.portalfiscal.inf.br/cte" versao="4.00"><CTe><infCte Id="CTe${K_CTE}" versao="4.00"><ide><mod>57</mod><nCT>456</nCT><dhEmi>2026-09-12T08:00:00-03:00</dhEmi><toma3><toma>3</toma></toma3></ide><emit><CNPJ>11222333000181</CNPJ><xNome>TRANSPORTADORA TESTE</xNome></emit><rem><CNPJ>98765432000110</CNPJ></rem><dest><CNPJ>${CNPJ_MATRIZ}</CNPJ><xNome>LANCHONETE TESTE</xNome></dest><vPrest><vTPrest>85.40</vTPrest></vPrest></infCte></CTe><protCTe><infProt><cStat>100</cStat></infProt></protCTe></cteProc>`;
const alheio = nfeCompra.replaceAll(CNPJ_MATRIZ, "11444777000161");

describe("XML fiscal: leitura determinística", () => {
  it("NFC-e, NF-e, CT-e (tomador pelo toma3) e evento de cancelamento", () => {
    expect(parseFiscalXml(nfce("1", "35.9"))).toMatchObject({ docType: "NFCE", number: "1", total: "35.90", status: "AUTORIZADO", issuerDoc: CNPJ_MATRIZ });
    const n = parseFiscalXml(nfeCompra)!;
    expect(n).toMatchObject({ docType: "NFE", accessKey: K_NFE, total: "1200.00", recipientDoc: CNPJ_MATRIZ });
    expect(roleOf(n, CNPJ_MATRIZ)).toBe("DESTINATARIO");
    const c = parseFiscalXml(cte)!;
    expect(c).toMatchObject({ docType: "CTE", accessKey: K_CTE, total: "85.40", takerDoc: CNPJ_MATRIZ });
    expect(roleOf(c, CNPJ_MATRIZ)).toBe("TOMADOR");
    expect(parseFiscalXml(cancel)).toMatchObject({ docType: "EVENTO_NFE", eventType: "110111", status: "CANCELADO" });
    expect(parseFiscalXml("<nada/>")).toBeNull();
    expect(parseFiscalXml("não é xml <<")).toBeNull();
  });
});

describe("entrada de XML: upload e pasta", () => {
  it("acha a empresa pelo CNPJ, abre ZIP, não duplica e recusa o que não é do escritório", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    const zip = Buffer.from(zipSync({ "pdv/0001.xml": strToU8(nfce("1", "35.90")), "pdv/0002.xml": strToU8(nfce("2", "12.00")), "leia-me.txt": strToU8("x") }));
    const r = await ingestFiles(appPool, t, [
      { name: "vendas-setembro.zip", bytes: zip },
      { name: "compra.xml", bytes: Buffer.from(nfeCompra) },
      { name: "frete.xml", bytes: Buffer.from(cte) },
      { name: "cancelamento.xml", bytes: Buffer.from(cancel) },
      { name: "de-outro-cliente.xml", bytes: Buffer.from(alheio) },
      { name: "foto.jpg", bytes: Buffer.from("x") },
    ], { source: "UPLOAD", actor: LUAN });
    expect(r).toMatchObject({ imported: 5, duplicated: 0 });
    expect(r.items.find((i) => i.file === "de-outro-cliente.xml")).toMatchObject({ status: "SEM_EMPRESA" });
    expect(r.items.find((i) => i.file === "foto.jpg")).toMatchObject({ status: "IGNORADO" });
    expect(r.byEntity[entityId]).toEqual({ NFCE: 2, NFE: 1, CTE: 1, EVENTO_NFE: 1 });

    // Reenviar o mesmo conteúdo não duplica.
    const again = await ingestFiles(appPool, t, [{ name: "compra-de-novo.xml", bytes: Buffer.from(nfeCompra) }], { source: "UPLOAD", actor: LUAN });
    expect(again).toMatchObject({ imported: 0, duplicated: 1 });

    const list = await fiscalXmlList(appPool, t, entityId);
    const by = Object.fromEntries(list.summary.map((x) => [`${x.doc_type}:${x.role}`, x]));
    expect(by["NFCE:EMITENTE"]).toMatchObject({ n: 2, total: "47.90" });
    expect(by["CTE:TOMADOR"]).toMatchObject({ n: 1, total: "85.40" });
    await withTenant(appPool, t, async (tx) => {
      const ev = await tx.query("SELECT payload FROM outbox WHERE type = 'XML_BATCH_IMPORTED'");
      expect(ev.rows).toHaveLength(1);
      const a = await tx.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'documents.xml_imported'");
      expect(a.rows[0].n).toBe(1);
    });
  });

  it("pasta de entrada: importa e move para processados ou recusados, sem apagar", async () => {
    const t = await newTenant();
    await newEntity(t, CNPJ_MATRIZ);
    const dir = mkdtempSync(join(tmpdir(), "iaris-entrada-"));
    writeFileSync(join(dir, "nfce-3.xml"), nfce("3", "10.00"));
    writeFileSync(join(dir, "estranho.xml"), "<qualquer/>");
    const r = await scanInbox(appPool, t, dir, { kind: "AGENT", id: "docs" }, new Date("2026-10-07T15:00:00Z"));
    expect(r).toMatchObject({ imported: 1, rejected: 1 });
    expect(readdirSync(dir).filter((n) => n.endsWith(".xml"))).toEqual([]);
    expect(existsSync(join(dir, "processados", "2026-10-07", "nfce-3.xml"))).toBe(true);
    expect(existsSync(join(dir, "recusados", "2026-10-07", "estranho.xml"))).toBe(true);
    expect(await scanInbox(appPool, t, dir, { kind: "AGENT", id: "docs" })).toBeNull();
  });
});

describe("CT-e: distribuição nacional", () => {
  it("monta o pedido do CT-e e guarda os documentos com as regras de NSU e espera", async () => {
    const env = cteDistNsuEnvelope(CNPJ_MATRIZ, "SC", "5");
    expect(env).toContain('<distDFeInt xmlns="http://www.portalfiscal.inf.br/cte" versao="1.00">');
    expect(env).toContain("<cteDadosMsg>");
    expect(env).toContain("<ultNSU>000000000000005</ultNSU>");

    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    await withTenant(appPool, t, (tx) =>
      tx.query(
        `INSERT INTO establishment (id, tenant_id, entity_id, kind, cnpj, uf, municipio_ibge, opened_at)
         VALUES ($1, current_tenant(), $2, 'MATRIZ', $3, 'SC', '4202305', '2020-01-01')`,
        [newId(), entityId, CNPJ_MATRIZ],
      ),
    );
    const soap = `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><cteDistDFeInteresseResponse xmlns="http://www.portalfiscal.inf.br/cte/wsdl/CTeDistribuicaoDFe"><cteDistDFeInteresseResult><retDistDFeInt xmlns="http://www.portalfiscal.inf.br/cte" versao="1.00"><tpAmb>1</tpAmb><cStat>138</cStat><xMotivo>Documento localizado</xMotivo><ultNSU>000000000000001</ultNSU><maxNSU>000000000000001</maxNSU><loteDistDFeInt><docZip NSU="000000000000001" schema="procCTe_v4.00.xsd">${gzipSync(Buffer.from(cte)).toString("base64")}</docZip></loteDistDFeInt></retDistDFeInt></cteDistDFeInteresseResult></cteDistDFeInteresseResponse></soap:Body></soap:Envelope>`;
    const calls: string[] = [];
    const cteDist: DfeDistribution = { distNsu: async (i): Promise<DistResult> => { calls.push(i.ultNsu); return parseDistResponse(soap); } };
    const nfeDist: DfeDistribution = { distNsu: async () => { throw new Error("NF-e não deveria ser chamada"); } };
    const deps = { appPool, dist: nfeDist, cteDist, certificates: () => ({ pfx: Buffer.from("x"), passphrase: "y" }), now: () => new Date("2026-10-07T15:00:00Z") };
    const r = await syncEntityDfe(deps, t, entityId, undefined, "CTE");
    expect(r).toMatchObject({ outcome: "ok", calls: 1, documents: 1, statusCode: "138" });
    expect(await syncEntityDfe(deps, t, entityId, undefined, "CTE")).toMatchObject({ outcome: "aguardando" });
    const list = await fiscalXmlList(appPool, t, entityId);
    expect(list.recent[0]).toMatchObject({ source: "CTE_DIST", doc_type: "CTE", role: "TOMADOR", total: "85.40" });
    await withTenant(appPool, t, async (tx) => {
      // O cursor do CT-e é separado do da NF-e.
      const q = await tx.query("SELECT channel, count(*)::int AS n FROM dfe_query GROUP BY channel");
      expect(q.rows).toEqual([{ channel: "CTE", n: 1 }]);
    });
  });
});
