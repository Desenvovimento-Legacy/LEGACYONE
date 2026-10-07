import { gunzipSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";
import { httpsTransport, type HttpTransport } from "../integra-contador/serpro.js";

/**
 * NFeDistribuicaoDFe — Ambiente Nacional da NF-e (distribuição de DF-e aos
 * interessados: destinatário, emitente, transportador, autorizado no XML).
 *
 *   POST https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx
 *   SOAP 1.2 · TLS mútuo com o e-CNPJ do interessado (mesma raiz do CNPJ consultado)
 *   distDFeInt v1.01 · distNSU/ultNSU · até 50 documentos por resposta (docZip gzip+base64)
 *
 * Não é cobrado. Regra de uso (NT 2014.002): ver dfe-sync.ts.
 */

export const DIST_DFE_URL = "https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx";
const SOAP_ACTION = "http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse";

/** Código IBGE da UF (cUFAutor). */
export const UF_CODE: Record<string, string> = {
  RO: "11", AC: "12", AM: "13", RR: "14", PA: "15", AP: "16", TO: "17", MA: "21", PI: "22", CE: "23", RN: "24",
  PB: "25", PE: "26", AL: "27", SE: "28", BA: "29", MG: "31", ES: "32", RJ: "33", SP: "35", PR: "41", SC: "42",
  RS: "43", MS: "50", MT: "51", GO: "52", DF: "53",
};

export interface DfeDoc {
  nsu: string;
  schema: string;
  xml: string;
}

export interface DistResult {
  statusCode: string;
  statusMessage: string;
  ultNsu: string | null;
  maxNsu: string | null;
  respondedAt: string | null;
  docs: DfeDoc[];
}

export interface ClientCertificate {
  pfx: Buffer;
  passphrase: string;
}

export interface DfeDistribution {
  /** Próximo lote a partir do último NSU recebido. */
  distNsu(input: { cnpj: string; uf: string; ultNsu: string; certificate: ClientCertificate }): Promise<DistResult>;
}

export class SefazError extends Error {
  constructor(message: string, readonly httpStatus: number) {
    super(message);
    this.name = "SefazError";
  }
}

export const nsu15 = (n: string | bigint | number) => String(n).replace(/\D/g, "").padStart(15, "0").slice(-15);

export function distNsuEnvelope(cnpj: string, uf: string, ultNsu: string, tpAmb: "1" | "2" = "1"): string {
  const cUF = UF_CODE[uf];
  if (!cUF) throw new Error(`UF desconhecida: ${uf}`);
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(cnpj)) throw new Error("CNPJ inválido para a consulta");
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">' +
    "<soap12:Body>" +
    '<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDadosMsg>' +
    `<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>${tpAmb}</tpAmb><cUFAutor>${cUF}</cUFAutor>` +
    `<CNPJ>${cnpj}</CNPJ><distNSU><ultNSU>${nsu15(ultNsu)}</ultNSU></distNSU></distDFeInt>` +
    "</nfeDadosMsg></nfeDistDFeInteresse></soap12:Body></soap12:Envelope>"
  );
}

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, attributeNamePrefix: "@_" });

function find(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  if (key in o) return o[key];
  for (const v of Object.values(o)) {
    const r = find(v, key);
    if (r !== undefined) return r;
  }
  return undefined;
}

export function parseDistResponse(soap: string): DistResult {
  const doc = parser.parse(soap);
  const ret = find(doc, "retDistDFeInt") as Record<string, unknown> | undefined;
  if (!ret) {
    const fault = find(doc, "Text") ?? find(doc, "faultstring");
    throw new SefazError(`Resposta sem retDistDFeInt${fault ? `: ${String(typeof fault === "object" ? (fault as Record<string, unknown>)["#text"] : fault)}` : ""}`, 200);
  }
  const lote = (ret.loteDistDFeInt as Record<string, unknown> | undefined)?.docZip;
  const zips = lote === undefined ? [] : Array.isArray(lote) ? lote : [lote];
  const docs = zips.map((z) => {
    const node = z as Record<string, string>;
    const xml = gunzipSync(Buffer.from(node["#text"] ?? "", "base64")).toString("utf8");
    return { nsu: nsu15(node["@_NSU"] ?? "0"), schema: node["@_schema"] ?? "", xml };
  });
  const s = (k: string) => (ret[k] === undefined ? null : String(ret[k]));
  return {
    statusCode: s("cStat") ?? "",
    statusMessage: s("xMotivo") ?? "",
    ultNsu: s("ultNSU") ? nsu15(s("ultNSU")!) : null,
    maxNsu: s("maxNSU") ? nsu15(s("maxNSU")!) : null,
    respondedAt: s("dhResp"),
    docs,
  };
}

export class SefazDistribution implements DfeDistribution {
  constructor(private readonly transport: HttpTransport = httpsTransport, private readonly url = DIST_DFE_URL) {}

  async distNsu(input: { cnpj: string; uf: string; ultNsu: string; certificate: ClientCertificate }): Promise<DistResult> {
    const res = await this.transport({
      url: this.url,
      method: "POST",
      headers: { "content-type": `application/soap+xml; charset=utf-8; action="${SOAP_ACTION}"` },
      body: distNsuEnvelope(input.cnpj, input.uf, input.ultNsu),
      clientCert: input.certificate,
      timeoutMs: 60_000,
    });
    if (res.status >= 400 && !res.body.includes("retDistDFeInt")) throw new SefazError(`SEFAZ respondeu HTTP ${res.status}`, res.status);
    return parseDistResponse(res.body);
  }
}

/**
 * CTeDistribuicaoDFe — Ambiente Nacional do CT-e (mesmo desenho da NF-e:
 * distDFeInt v1.00, distNSU/ultNSU, docZip gzip+base64, TLS mútuo com o e-CNPJ).
 * Schemas típicos dos documentos: procCTe_v4.00.xsd, procEventoCTe_v4.00.xsd.
 */
export const CTE_DIST_URL = "https://www1.cte.fazenda.gov.br/CTeDistribuicaoDFe/CTeDistribuicaoDFe.asmx";
const CTE_SOAP_ACTION = "http://www.portalfiscal.inf.br/cte/wsdl/CTeDistribuicaoDFe/cteDistDFeInteresse";

export function cteDistNsuEnvelope(cnpj: string, uf: string, ultNsu: string, tpAmb: "1" | "2" = "1"): string {
  const cUF = UF_CODE[uf];
  if (!cUF) throw new Error(`UF desconhecida: ${uf}`);
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(cnpj)) throw new Error("CNPJ inválido para a consulta");
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">' +
    "<soap12:Body>" +
    '<cteDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/cte/wsdl/CTeDistribuicaoDFe"><cteDadosMsg>' +
    `<distDFeInt xmlns="http://www.portalfiscal.inf.br/cte" versao="1.00"><tpAmb>${tpAmb}</tpAmb><cUFAutor>${cUF}</cUFAutor>` +
    `<CNPJ>${cnpj}</CNPJ><distNSU><ultNSU>${nsu15(ultNsu)}</ultNSU></distNSU></distDFeInt>` +
    "</cteDadosMsg></cteDistDFeInteresse></soap12:Body></soap12:Envelope>"
  );
}

export class CteDistribution implements DfeDistribution {
  constructor(private readonly transport: HttpTransport = httpsTransport, private readonly url = CTE_DIST_URL) {}

  async distNsu(input: { cnpj: string; uf: string; ultNsu: string; certificate: ClientCertificate }): Promise<DistResult> {
    const res = await this.transport({
      url: this.url,
      method: "POST",
      headers: { "content-type": `application/soap+xml; charset=utf-8; action="${CTE_SOAP_ACTION}"` },
      body: cteDistNsuEnvelope(input.cnpj, input.uf, input.ultNsu),
      clientCert: input.certificate,
      timeoutMs: 60_000,
    });
    if (res.status >= 400 && !res.body.includes("retDistDFeInt")) throw new SefazError(`SEFAZ (CT-e) respondeu HTTP ${res.status}`, res.status);
    return parseDistResponse(res.body);
  }
}
