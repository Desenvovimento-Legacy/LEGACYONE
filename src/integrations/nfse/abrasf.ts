import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { Dec } from "../../shared/decimal.js";
import type { NfseSummary } from "./nfse-parse.js";
import { NFSE_TAX_PARSER, type NfseTaxes } from "./nfse-taxes.js";

/**
 * NFS-e dos emissores municipais no padrão ABRASF (1.0 e 2.0x: Ginfes, Betha,
 * ISSNet, e-Governe, WebISS e a maioria dos sistemas próprios). Leitura
 * determinística, sem IA: um arquivo pode trazer uma nota (CompNfse) ou uma
 * lista (ConsultarNfseResposta, ListaNfse...). Cada nota é o trecho original do
 * arquivo (evidência), com hash próprio.
 *
 * Chave: as notas municipais não têm a chave de 50 posições do padrão nacional;
 * a IARIS usa "ABRASF:<município>:<CNPJ do prestador>:<número>", que liga a nota
 * ao cancelamento (NfseCancelamento) do mesmo arquivo.
 *
 * Tributos (grupo Valores):
 *   IssRetido 1 = retido pelo tomador (ValorIss, ou ValorIssRetido no 1.0)
 *   ValorIr, ValorInss, ValorCsll, ValorPis, ValorCofins = retenções federais
 *   (no ABRASF esses campos são as retenções, não o tributo do prestador)
 *   Prova: ValorServicos − deduções/descontos − retenções = ValorLiquidoNfse.
 */

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, attributeNamePrefix: "@_" });
type Node = Record<string, unknown>;
const obj = (v: unknown): Node => (v && typeof v === "object" && !Array.isArray(v) ? (v as Node) : {});
const str = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v === "object") return str((v as Node)["#text"]);
  const s = String(v).trim();
  return s === "" ? null : s;
};
const num = (v: unknown): string | null => {
  const s = str(v)?.replace(",", ".") ?? null;
  return s && /^-?\d+(\.\d+)?$/.test(s) ? Dec.of(s).toFixed(2) : null;
};
const z = (v: string | null) => v ?? "0.00";
const docOf = (n: unknown): string | null => {
  const o = obj(n);
  const cc = obj(o.CpfCnpj);
  return str(cc.Cnpj) ?? str(cc.Cpf) ?? str(o.Cnpj) ?? str(o.Cpf);
};
const brl = (v: string) => Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2 });

/** O XML é de NFS-e ABRASF? (CompNfse/Nfse/InfNfse, com qualquer envelope de resposta). */
export function isAbrasf(xml: string): boolean {
  return /<(\w+:)?InfNfse[\s>]/.test(xml) && !/<(\w+:)?infNFSe[\s>]/.test(xml);
}

export interface AbrasfNote {
  /** trecho original da nota (CompNfse, ou Nfse quando não há CompNfse) */
  xml: string;
  sha256: Buffer;
  /** trecho do cancelamento, quando o arquivo o traz */
  cancellationXml: string | null;
}

/** Separa as notas do arquivo, preservando o texto original de cada uma. */
export function splitAbrasf(xml: string): AbrasfNote[] {
  const take = (tag: string) => {
    const re = new RegExp(`<((?:\\w+:)?${tag})(?:\\s[^>]*)?>[\\s\\S]*?</\\1>`, "g");
    return [...xml.matchAll(re)].map((m) => m[0]);
  };
  const comps = take("CompNfse");
  const parts = comps.length ? comps : take("Nfse").filter((p) => /<(\w+:)?InfNfse[\s>]/.test(p));
  return parts.map((p) => {
    const cancel = new RegExp(`<((?:\\w+:)?NfseCancelamento)(?:\\s[^>]*)?>[\\s\\S]*?</\\1>`).exec(p);
    return { xml: p, sha256: createHash("sha256").update(p, "utf8").digest(), cancellationXml: cancel ? cancel[0] : null };
  });
}

interface Read {
  inf: Node;
  decl: Node;
  valores: Node;
  servico: Node;
  prestadorDoc: string | null;
  prestadorName: string | null;
  tomadorDoc: string | null;
  tomadorName: string | null;
  number: string | null;
  issuedAt: string | null;
  city: string | null;
}

function read(fragment: string): Read | null {
  let root: Node;
  try {
    root = parser.parse(fragment) as Node;
  } catch {
    return null;
  }
  const comp = obj(root.CompNfse);
  const nfse = obj(comp.Nfse ?? root.Nfse);
  const inf = obj(nfse.InfNfse);
  if (!Object.keys(inf).length) return null;
  // 2.0x: dados do serviço dentro da declaração; 1.0: direto na InfNfse
  const decl = obj(obj(inf.DeclaracaoPrestacaoServico).InfDeclaracaoPrestacaoServico);
  const servico = obj(decl.Servico ?? inf.Servico);
  const valores = { ...obj(servico.Valores), ...obj(inf.ValoresNfse) };
  const prest = obj(inf.PrestadorServico);
  const tom = obj(decl.TomadorServico ?? decl.Tomador ?? inf.TomadorServico);
  const prestDoc = docOf(prest.IdentificacaoPrestador) ?? docOf(decl.Prestador) ?? docOf(prest);
  const city = str(obj(inf.OrgaoGerador).CodigoMunicipio) ?? str(servico.CodigoMunicipio) ?? str(servico.MunicipioIncidencia);
  const issued = str(inf.DataEmissao);
  return {
    inf, decl, valores, servico,
    prestadorDoc: prestDoc,
    prestadorName: str(prest.RazaoSocial) ?? str(prest.NomeFantasia),
    tomadorDoc: docOf(tom.IdentificacaoTomador) ?? docOf(tom),
    tomadorName: str(tom.RazaoSocial) ?? str(tom.NomeRazaoSocial),
    number: str(inf.Numero),
    // DataEmissao sem fuso é horário local (Brasília)
    issuedAt: issued ? (/[zZ]|[+-]\d{2}:?\d{2}$/.test(issued) ? issued : /T/.test(issued) ? `${issued}-03:00` : `${issued}T12:00:00-03:00`) : null,
    city,
  };
}

export const abrasfKey = (city: string | null, provider: string | null, number: string | null) =>
  `ABRASF:${city ?? "?"}:${provider ?? "?"}:${number ?? "?"}`;

/** Resumo no mesmo formato da NFS-e nacional. */
export function summarizeAbrasf(fragment: string): NfseSummary | null {
  const r = read(fragment);
  if (!r) return null;
  const v = r.valores;
  const retido = str(v.IssRetido) ?? str(r.servico.IssRetido) ?? str(r.decl.IssRetido);
  return {
    isEvent: false,
    accessKey: abrasfKey(r.city, r.prestadorDoc, r.number),
    number: r.number,
    issuedAt: r.issuedAt,
    providerDoc: r.prestadorDoc,
    providerName: r.prestadorName,
    takerDoc: r.tomadorDoc,
    takerName: r.tomadorName,
    serviceValue: num(v.ValorServicos),
    netValue: num(v.ValorLiquidoNfse),
    issValue: num(v.ValorIss),
    issWithheld: retido === null ? null : retido === "1",
    municipality: r.city,
    eventType: null,
  };
}

/** Código do serviço (item da lista da LC 116) no formato do código nacional: "17.14" → "1714". */
function itemCode(v: string | null): string | null {
  if (!v) return null;
  const m = /^(\d{1,2})\.?(\d{2})/.exec(v.trim());
  return m ? `${m[1]!.padStart(2, "0")}${m[2]}` : v.replace(/\D/g, "") || null;
}

/** Tributos e retenções da nota ABRASF, no mesmo formato da leitura nacional. */
export function readAbrasfTaxes(fragment: string): NfseTaxes | null {
  const r = read(fragment);
  if (!r) return null;
  const v = r.valores;
  const notes: string[] = ["Leiaute ABRASF (emissor municipal): IR, INSS, CSLL, PIS e COFINS informados são retenções"];
  const retido = str(v.IssRetido) ?? str(r.servico.IssRetido) ?? str(r.decl.IssRetido);
  const issValue = num(v.ValorIss);
  const issWithheld = retido === "1" ? z(num(v.ValorIssRetido) ?? issValue) : "0.00";
  const irrf = z(num(v.ValorIr));
  const cp = z(num(v.ValorInss));
  const csll = z(num(v.ValorCsll));
  const pis = z(num(v.ValorPis));
  const cofins = z(num(v.ValorCofins));
  const csrf = Dec.of(csll).add(pis).add(cofins);
  const federal = Dec.of(irrf).add(cp).add(csrf);
  const total = federal.add(issWithheld);
  const serv = num(v.ValorServicos);
  const liq = num(v.ValorLiquidoNfse);
  const other = z(num(v.OutrasRetencoes));
  const discInc = z(num(v.DescontoIncondicionado));
  const discCond = z(num(v.DescontoCondicionado));
  let check: NfseTaxes["check"] = total.isZero() ? "OK" : "SEM_TOTAL";
  if (serv !== null && liq !== null) {
    const byNet = Dec.of(serv).sub(discInc).sub(discCond).sub(other).sub(liq);
    if (byNet.cmp(total) === 0) check = "OK";
    else {
      check = "DIVERGENTE";
      notes.push(`Serviço − descontos − líquido = R$ ${brl(byNet.toFixed(2))} · retenções lidas R$ ${brl(total.toFixed(2))}`);
    }
  }
  if (!Dec.of(other).isZero()) notes.push(`Outras retenções na nota: R$ ${brl(other)}`);
  const comp = str(r.decl.Competencia) ?? str(r.inf.Competencia);
  const simples = str(r.decl.OptanteSimplesNacional) ?? str(r.inf.OptanteSimplesNacional);
  return {
    parser: NFSE_TAX_PARSER,
    serviceDate: comp && /^\d{4}-\d{2}-\d{2}/.test(comp) ? comp.slice(0, 10) : r.issuedAt ? r.issuedAt.slice(0, 10) : null,
    // ABRASF: 1 = optante, 2 = não optante → códigos nacionais 3 (ME/EPP) e 1 (não optante)
    providerSimples: simples === "1" ? "3" : simples === "2" ? "1" : null,
    providerSpecialRegime: str(r.decl.RegimeEspecialTributacao) ?? str(r.inf.RegimeEspecialTributacao),
    nationalCode: itemCode(str(r.servico.ItemListaServico)),
    nbsCode: null,
    incidenceCity: str(r.servico.MunicipioIncidencia) ?? str(r.servico.CodigoMunicipio) ?? r.city,
    incidenceCityName: null,
    serviceValue: serv,
    unconditionalDiscount: discInc,
    deductions: z(num(v.ValorDeducoes)),
    issBase: num(v.BaseCalculo),
    issRate: num(v.Aliquota),
    issValue,
    issWithheldType: retido === "1" ? "2" : retido === "2" ? "1" : null,
    issWithheld,
    irrf,
    cp,
    csllField: csll,
    pisDue: pis,
    cofinsDue: cofins,
    pisCofinsCode: null,
    csrf: csrf.toFixed(2),
    federalWithheld: federal.toFixed(2),
    totalWithheldRead: null,
    totalWithheldCalc: total.toFixed(2),
    netValue: liq,
    ibs: null,
    cbs: null,
    check,
    notes,
  };
}
