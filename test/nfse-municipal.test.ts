import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { isAbrasf, readAbrasfTaxes, splitAbrasf, summarizeAbrasf } from "../src/integrations/nfse/abrasf.js";
import { parseLote, type AdnLote, type NfseDistribution } from "../src/integrations/nfse/adn.js";
import { parseFiscalXml } from "../src/integrations/fiscal-xml/parse.js";
import { ingestFiles } from "../src/modules/documents/xml-intake.js";
import { syncEntityNfse } from "../src/modules/documents/nfse-sync.js";
import { readEntityNfseTaxes } from "../src/modules/fiscal/withholdings.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const LUAN: Actor = { kind: "USER", id: "luan" };
const CLIENTE = "11222333000181";
const FORNECEDOR = "44555666000177";

/** ABRASF 2.02: nota com retenções (IR 1,5%, CSRF 4,65%, ISS retido) e uma cancelada. */
const v2 = (n: string, prest: string, toma: string, v: string, opts: { cancel?: boolean; ret?: boolean } = {}) => {
  const ir = opts.ret ? (Number(v) * 0.015).toFixed(2) : "0.00";
  const pis = opts.ret ? (Number(v) * 0.0065).toFixed(2) : "0.00";
  const cof = opts.ret ? (Number(v) * 0.03).toFixed(2) : "0.00";
  const csll = opts.ret ? (Number(v) * 0.01).toFixed(2) : "0.00";
  const iss = (Number(v) * 0.02).toFixed(2);
  const liq = (Number(v) - Number(ir) - Number(pis) - Number(cof) - Number(csll) - (opts.ret ? Number(iss) : 0)).toFixed(2);
  return `<CompNfse><Nfse versao="2.02"><InfNfse Id="N${n}"><Numero>${n}</Numero><CodigoVerificacao>AB12</CodigoVerificacao><DataEmissao>2025-11-10T14:30:00</DataEmissao>` +
    `<ValoresNfse><BaseCalculo>${v}</BaseCalculo><Aliquota>2.00</Aliquota><ValorIss>${iss}</ValorIss><ValorLiquidoNfse>${liq}</ValorLiquidoNfse></ValoresNfse>` +
    `<PrestadorServico><IdentificacaoPrestador><CpfCnpj><Cnpj>${prest}</Cnpj></CpfCnpj><InscricaoMunicipal>123</InscricaoMunicipal></IdentificacaoPrestador><RazaoSocial>PRESTADORA ${prest}</RazaoSocial></PrestadorServico>` +
    `<OrgaoGerador><CodigoMunicipio>3105608</CodigoMunicipio><Uf>MG</Uf></OrgaoGerador>` +
    `<DeclaracaoPrestacaoServico><InfDeclaracaoPrestacaoServico><Competencia>2025-11-01</Competencia><Servico><Valores><ValorServicos>${v}</ValorServicos>` +
    `<ValorPis>${pis}</ValorPis><ValorCofins>${cof}</ValorCofins><ValorInss>0.00</ValorInss><ValorIr>${ir}</ValorIr><ValorCsll>${csll}</ValorCsll><ValorIss>${iss}</ValorIss><Aliquota>2.00</Aliquota></Valores>` +
    `<IssRetido>${opts.ret ? 1 : 2}</IssRetido><ItemListaServico>17.19</ItemListaServico><CodigoMunicipio>3105608</CodigoMunicipio></Servico>` +
    `<Prestador><CpfCnpj><Cnpj>${prest}</Cnpj></CpfCnpj></Prestador><TomadorServico><IdentificacaoTomador><CpfCnpj><Cnpj>${toma}</Cnpj></CpfCnpj></IdentificacaoTomador><RazaoSocial>TOMADORA ${toma}</RazaoSocial></TomadorServico>` +
    `<OptanteSimplesNacional>1</OptanteSimplesNacional></InfDeclaracaoPrestacaoServico></DeclaracaoPrestacaoServico></InfNfse></Nfse>` +
    (opts.cancel ? `<NfseCancelamento versao="2.02"><Confirmacao><Pedido><InfPedidoCancelamento><CodigoCancelamento>2</CodigoCancelamento></InfPedidoCancelamento></Pedido><DataHora>2025-11-12T10:00:00</DataHora></Confirmacao></NfseCancelamento>` : "") +
    `</CompNfse>`;
};
const lista = (...notes: string[]) => `<?xml version="1.0" encoding="UTF-8"?><ConsultarNfseResposta xmlns="http://www.abrasf.org.br/nfse.xsd"><ListaNfse>${notes.join("")}</ListaNfse></ConsultarNfseResposta>`;

/** ABRASF 1.0 (Ginfes): serviço direto na InfNfse, ISS retido pelo tomador. */
const v1 = `<ns3:CompNfse xmlns:ns3="http://www.ginfes.com.br/tipos_v03.xsd"><ns3:Nfse><ns3:InfNfse><ns3:Numero>77</ns3:Numero><ns3:DataEmissao>2025-12-03T08:00:00</ns3:DataEmissao><ns3:OptanteSimplesNacional>2</ns3:OptanteSimplesNacional>` +
  `<ns3:Servico><ns3:Valores><ns3:ValorServicos>500.00</ns3:ValorServicos><ns3:IssRetido>1</ns3:IssRetido><ns3:ValorIss>25.00</ns3:ValorIss><ns3:ValorIssRetido>25.00</ns3:ValorIssRetido><ns3:BaseCalculo>500.00</ns3:BaseCalculo><ns3:Aliquota>0.05</ns3:Aliquota><ns3:ValorLiquidoNfse>475.00</ns3:ValorLiquidoNfse></ns3:Valores><ns3:ItemListaServico>7.10</ns3:ItemListaServico><ns3:CodigoMunicipio>3550308</ns3:CodigoMunicipio></ns3:Servico>` +
  `<ns3:PrestadorServico><ns3:IdentificacaoPrestador><ns3:Cnpj>${FORNECEDOR}</ns3:Cnpj></ns3:IdentificacaoPrestador><ns3:RazaoSocial>LIMPEZA BOA LTDA</ns3:RazaoSocial></ns3:PrestadorServico>` +
  `<ns3:TomadorServico><ns3:IdentificacaoTomador><ns3:CpfCnpj><ns3:Cnpj>${CNPJ_MATRIZ}</ns3:Cnpj></ns3:CpfCnpj></ns3:IdentificacaoTomador><ns3:RazaoSocial>ALPHA</ns3:RazaoSocial></ns3:TomadorServico>` +
  `<ns3:OrgaoGerador><ns3:CodigoMunicipio>3550308</ns3:CodigoMunicipio><ns3:Uf>SP</ns3:Uf></ns3:OrgaoGerador></ns3:InfNfse></ns3:Nfse></ns3:CompNfse>`;

const national = (n: string, prest: string, toma: string, v: string) =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00"><infNFSe Id="NFS31056082${n.padStart(41, "0")}"><xLocEmi>Barbacena</xLocEmi><nNFSe>${n}</nNFSe><dhProc>2026-09-10T10:00:00-03:00</dhProc><emit><CNPJ>${prest}</CNPJ><xNome>PRESTADOR</xNome></emit><valores><vLiq>${v}</vLiq></valores><DPS versao="1.00"><infDPS Id="D"><dhEmi>2026-09-10T09:00:00-03:00</dhEmi><dCompet>2026-09-10</dCompet><prest><CNPJ>${prest}</CNPJ></prest><toma><CNPJ>${toma}</CNPJ></toma><valores><vServPrest><vServ>${v}</vServ></vServPrest><trib><tribMun><tpRetISSQN>1</tpRetISSQN></tribMun></trib></valores></infDPS></DPS></infNFSe></NFSe>`;

class FakeAdn implements NfseDistribution {
  constructor(private readonly responses: AdnLote[]) {}
  async lote(): Promise<AdnLote> {
    const r = this.responses.shift();
    if (!r) throw new Error("sem resposta");
    return r;
  }
}

describe("NFS-e municipal (ABRASF) e NFS-e enviada por arquivo", () => {
  it("lê ABRASF 2.02 e 1.0: partes, valores, retenções e cancelamento", () => {
    const file = lista(v2("101", CNPJ_MATRIZ, CLIENTE, "10000.00", { ret: true }), v2("102", CNPJ_MATRIZ, CLIENTE, "800.00", { cancel: true }));
    expect(isAbrasf(file)).toBe(true);
    const notes = splitAbrasf(file);
    expect(notes).toHaveLength(2);
    expect(notes[1]!.cancellationXml).toMatch(/NfseCancelamento/);
    expect(summarizeAbrasf(notes[0]!.xml)).toMatchObject({
      number: "101", providerDoc: CNPJ_MATRIZ, takerDoc: CLIENTE, serviceValue: "10000.00", issWithheld: true,
      issuedAt: "2025-11-10T14:30:00-03:00", accessKey: `ABRASF:3105608:${CNPJ_MATRIZ}:101`,
    });
    const t = readAbrasfTaxes(notes[0]!.xml)!;
    expect(t).toMatchObject({ irrf: "150.00", csrf: "465.00", issWithheld: "200.00", federalWithheld: "615.00", totalWithheldCalc: "815.00", check: "OK", nationalCode: "1719", providerSimples: "3", serviceDate: "2025-11-01" });
    const g = readAbrasfTaxes(v1)!;
    expect(g).toMatchObject({ issWithheld: "25.00", irrf: "0.00", check: "OK", nationalCode: "0710", providerSimples: "1" });
    expect(parseFiscalXml(file)).toMatchObject({ docType: "NFSE", number: "2 notas", total: "10800.00" });
  });

  it("arquivo vira nota para o fiscal (tributos lidos), cancelada não soma, reenvio não duplica", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    const file = lista(v2("101", CNPJ_MATRIZ, CLIENTE, "10000.00", { ret: true }), v2("102", CNPJ_MATRIZ, CLIENTE, "800.00", { cancel: true }));
    const r = await ingestFiles(appPool, t, [{ name: "prefeitura.xml", bytes: Buffer.from(file) }, { name: "tomada.xml", bytes: Buffer.from(v1) }], { source: "UPLOAD", actor: LUAN });
    expect(r.imported).toBe(2);
    await withTenant(appPool, t, async (tx) => {
      const d = await tx.query("SELECT role, number, source, layout, event_type, nsu FROM nfse_document WHERE entity_id = $1 ORDER BY role, number", [entityId]);
      expect(d.rows.map((x) => [x.role, x.number, x.source, x.layout, x.nsu])).toEqual([
        ["EVENTO", "102", "UPLOAD", "ABRASF", null],
        ["PRESTADA", "101", "UPLOAD", "ABRASF", null],
        ["PRESTADA", "102", "UPLOAD", "ABRASF", null],
        ["TOMADA", "77", "UPLOAD", "ABRASF", null],
      ]);
      const ev = await tx.query("SELECT payload FROM outbox WHERE type = 'NFSE_BATCH_RECEIVED'");
      expect(ev.rows[0].payload).toMatchObject({ documents: 4, roles: { PRESTADA: 2, EVENTO: 1, TOMADA: 1 } });
    });
    const taxes = await readEntityNfseTaxes(appPool, t, entityId);
    expect(taxes.read).toBe(3);
    await withTenant(appPool, t, async (tx) => {
      const x = await tx.query("SELECT t.role, t.iss_withheld::text, t.federal_withheld::text, t.read_check FROM nfse_tax t ORDER BY t.service_value DESC");
      expect(x.rows[0]).toMatchObject({ role: "PRESTADA", iss_withheld: "200.00", federal_withheld: "615.00", read_check: "OK" });
    });
    // reenviar o mesmo arquivo (ou a mesma nota em outro arquivo) não duplica
    const again = await ingestFiles(appPool, t, [{ name: "de-novo.xml", bytes: Buffer.from(v2("101", CNPJ_MATRIZ, CLIENTE, "10000.00", { ret: true })) }], { source: "PASTA", actor: LUAN });
    expect(again.imported).toBe(1); // o arquivo fica como evidência
    await withTenant(appPool, t, async (tx) => {
      expect((await tx.query("SELECT count(*)::int AS n FROM nfse_document WHERE entity_id = $1 AND role = 'PRESTADA'", [entityId])).rows[0].n).toBe(2);
    });
  });

  it("NFS-e nacional enviada por arquivo e depois trazida pelo ADN: fica uma só", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    const xml = national("55", FORNECEDOR, CNPJ_MATRIZ, "300.00");
    await ingestFiles(appPool, t, [{ name: "n.xml", bytes: Buffer.from(xml) }], { source: "UPLOAD", actor: LUAN });
    const key = `31056082${"55".padStart(41, "0")}`;
    const adn = new FakeAdn([
      parseLote(200, JSON.stringify({ StatusProcessamento: "DOCUMENTOS_LOCALIZADOS", LoteDFe: [{ NSU: 9, ChaveAcesso: key, TipoDocumento: "NFSE", ArquivoXml: gzipSync(Buffer.from(xml)).toString("base64"), DataHoraGeracao: "2026-09-10T10:00:01" }] })),
      parseLote(404, "NENHUM_DOCUMENTO_LOCALIZADO"),
    ]);
    await syncEntityNfse({ appPool, adn, certificates: () => ({ pfx: Buffer.from("x"), passphrase: "y" }), now: () => new Date("2026-10-06T20:00:00Z"), sleep: async () => undefined }, t, entityId);
    await withTenant(appPool, t, async (tx) => {
      const d = await tx.query("SELECT source, access_key FROM nfse_document WHERE entity_id = $1", [entityId]);
      expect(d.rows).toEqual([{ source: "UPLOAD", access_key: key }]);
      const dup = await tx.query("SELECT source, nsu::int FROM nfse_duplicate WHERE entity_id = $1", [entityId]);
      expect(dup.rows).toEqual([{ source: "ADN", nsu: 9 }]);
    });
  });
});
