import { XMLParser } from "fast-xml-parser";
import { Dec } from "../../shared/decimal.js";

/**
 * Tributos e retenções da NFS-e do padrão nacional (leitura determinística, sem IA).
 *
 * Retenções federais (grupo tribFed):
 *   vRetIRRF  IRRF retido · vRetCP  contribuição previdenciária retida
 *   vRetCSLL  depende de tpRetPisCofins:
 *     3 a 9 (NT SE/CGNFS-e 007)  soma consolidada de PIS + COFINS + CSLL retidos;
 *                                vPis/vCofins passam a ser o tributo devido pelo prestador
 *     1 (leiaute anterior)       CSLL retida; PIS e COFINS retidos em vPis/vCofins
 *     2 (leiaute anterior)       CSLL retida; PIS e COFINS não retidos
 *     0                          PIS, COFINS e CSLL não retidos
 *     ausente                    vRetCSLL; PIS/COFINS só entram se o vTotalRet da nota os incluir
 *                                E tiverem a alíquota de retenção (0,65% e 3%, Lei 10.833/2003,
 *                                art. 31). Com outra alíquota (ex.: 1,65%/7,6% do não cumulativo)
 *                                são o tributo do prestador: não contam e a nota fica a conferir.
 * ISS retido: tpRetISSQN 2 (tomador) ou 3 (intermediário) → vISSQN.
 *
 * Prova: quando a nota traz vTotalRet, a soma lida tem de bater com ele; se não
 * bater, a nota fica DIVERGENTE (os valores lidos não são "corrigidos").
 */

export const NFSE_TAX_PARSER = "nfse-trib-2";

export type TaxReadCheck = "OK" | "DIVERGENTE" | "SEM_TOTAL";

export interface NfseTaxes {
  parser: string;
  /** dCompet da DPS (AAAA-MM-DD) */
  serviceDate: string | null;
  /** opSimpNac do prestador: 1 não optante · 2 MEI · 3 ME/EPP */
  providerSimples: string | null;
  providerSpecialRegime: string | null;
  nationalCode: string | null;
  nbsCode: string | null;
  incidenceCity: string | null;
  incidenceCityName: string | null;
  serviceValue: string | null;
  unconditionalDiscount: string;
  deductions: string;
  issBase: string | null;
  issRate: string | null;
  issValue: string | null;
  issWithheldType: string | null;
  issWithheld: string;
  irrf: string;
  cp: string;
  csllField: string;
  pisDue: string;
  cofinsDue: string;
  pisCofinsCode: string | null;
  /** PIS + COFINS + CSLL efetivamente retidos, pela regra acima */
  csrf: string;
  federalWithheld: string;
  totalWithheldRead: string | null;
  totalWithheldCalc: string;
  netValue: string | null;
  ibs: string | null;
  cbs: string | null;
  check: TaxReadCheck;
  notes: string[];
}

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, attributeNamePrefix: "@_" });
type Node = Record<string, unknown>;
const obj = (v: unknown): Node => (v && typeof v === "object" ? (v as Node) : {});
const str = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v === "object") return str((v as Node)["#text"]);
  const s = String(v).trim();
  return s === "" ? null : s;
};
const num = (v: unknown): string | null => {
  const s = str(v);
  return s && /^-?\d+(\.\d+)?$/.test(s) ? Dec.of(s).toFixed(2) : null;
};
const z = (v: string | null) => v ?? "0.00";
const brl = (v: string) => Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2 });

/** Lê os tributos de uma NFS-e (infNFSe com a DPS dentro). Nulo se não for NFS-e. */
export function readNfseTaxes(xml: string): NfseTaxes | null {
  let root: Node;
  try {
    root = parser.parse(xml) as Node;
  } catch {
    return null;
  }
  const nfse = obj(root.NFSe ?? obj(root.CompNFSe).NFSe);
  if (!Object.keys(nfse).length) return null;
  const inf = obj(nfse.infNFSe);
  const dps = obj(obj(inf.DPS).infDPS);
  const regTrib = obj(obj(dps.prest).regTrib);
  const cServ = obj(obj(dps.serv).cServ);
  const dv = obj(dps.valores);
  const trib = obj(dv.trib);
  const mun = obj(trib.tribMun);
  const fed = obj(trib.tribFed);
  const pc = obj(fed.piscofins);
  const vals = obj(inf.valores);
  const desc = obj(dv.vDescCondIncond);
  const cibs = obj(obj(inf.IBSCBS).totCIBS);

  const notes: string[] = [];
  const irrf = z(num(fed.vRetIRRF));
  const cp = z(num(fed.vRetCP));
  const csllField = z(num(fed.vRetCSLL));
  const pisDue = z(num(pc.vPis));
  const cofinsDue = z(num(pc.vCofins));
  const code = str(pc.tpRetPisCofins);
  const issType = str(mun.tpRetISSQN);
  const issValue = num(vals.vISSQN) ?? num(mun.vISSQN);
  const issWithheld = issType === "2" || issType === "3" ? z(issValue) : "0.00";
  const totalRead = num(vals.vTotalRet);

  const base = Dec.of(irrf).add(cp).add(issWithheld);
  const pisCofins = Dec.of(pisDue).add(cofinsDue);
  let csrf: Dec;
  if (code === "1") {
    csrf = Dec.of(csllField).add(pisCofins);
    notes.push("Código 1 (leiaute anterior): PIS e COFINS retidos em vPis/vCofins, CSLL em vRetCSLL");
  } else if (code === "0") {
    csrf = Dec.of(csllField);
    if (!Dec.of(csllField).isZero()) notes.push(`Código 0 (não retidos), mas a nota informa R$ ${brl(csllField)} em vRetCSLL`);
  } else if (code === "2") {
    csrf = Dec.of(csllField);
    notes.push("Código 2 (leiaute anterior): só CSLL retida");
  } else if (code && /^[3-9]$/.test(code)) {
    csrf = Dec.of(csllField);
    notes.push(`Código ${code} (NT 007): vRetCSLL é a soma de PIS, COFINS e CSLL retidos`);
  } else if (code) {
    csrf = Dec.of(csllField);
    notes.push(`Código tpRetPisCofins ${code} desconhecido: considerado só vRetCSLL`);
  } else if (totalRead !== null && !pisCofins.isZero() && base.add(csllField).add(pisCofins).cmp(totalRead) === 0) {
    const pcBase = num(pc.vBCPisCofins) ?? num(obj(dv.vServPrest).vServ) ?? "0";
    const near = (v: string, rate: string) => Dec.of(v).sub(Dec.of(pcBase).mul(rate).round(2)).cmp("0.01") <= 0 && Dec.of(pcBase).mul(rate).round(2).sub(v).cmp("0.01") <= 0;
    if (near(pisDue, "0.0065") && near(cofinsDue, "0.03")) {
      csrf = Dec.of(csllField).add(pisCofins);
      notes.push("Sem código: o total retido da nota inclui PIS e COFINS com alíquota de retenção (0,65% e 3%)");
    } else {
      csrf = Dec.of(csllField);
      const pct = (v: string) => (Dec.of(pcBase).isZero() ? "?" : Dec.of(v).mul("100").div(pcBase).toFixed(2).replace(".", ","));
      notes.push(`Sem código: o total retido inclui PIS ${pct(pisDue)}% e COFINS ${pct(cofinsDue)}%, que não é alíquota de retenção (0,65% e 3%): tributo do prestador, não considerado retido`);
    }
  } else {
    csrf = Dec.of(csllField);
  }
  const federal = Dec.of(irrf).add(cp).add(csrf);
  const totalCalc = federal.add(issWithheld);

  let check: TaxReadCheck;
  if (totalRead !== null) {
    check = totalCalc.cmp(totalRead) === 0 ? "OK" : "DIVERGENTE";
    if (check === "DIVERGENTE") notes.push(`Total retido na nota R$ ${brl(totalRead)} · soma lida R$ ${brl(totalCalc.toFixed(2))}`);
  } else {
    check = totalCalc.isZero() ? "OK" : "SEM_TOTAL";
  }

  const dCompet = str(dps.dCompet);
  return {
    parser: NFSE_TAX_PARSER,
    serviceDate: dCompet && /^\d{4}-\d{2}-\d{2}$/.test(dCompet) ? dCompet : null,
    providerSimples: str(regTrib.opSimpNac),
    providerSpecialRegime: str(regTrib.regEspTrib),
    nationalCode: str(cServ.cTribNac),
    nbsCode: str(cServ.cNBS),
    incidenceCity: str(inf.cLocIncid) ?? str(obj(obj(dps.serv).locPrest).cLocPrestacao),
    incidenceCityName: str(inf.xLocIncid),
    serviceValue: num(obj(dv.vServPrest).vServ),
    unconditionalDiscount: z(num(desc.vDescIncond)),
    deductions: z(num(obj(dv.vDedRed).vDR)),
    issBase: num(vals.vBC),
    issRate: num(vals.pAliqAplic) ?? num(mun.pAliq),
    issValue,
    issWithheldType: issType,
    issWithheld,
    irrf,
    cp,
    csllField,
    pisDue,
    cofinsDue,
    pisCofinsCode: code,
    csrf: csrf.toFixed(2),
    federalWithheld: federal.toFixed(2),
    totalWithheldRead: totalRead,
    totalWithheldCalc: totalCalc.toFixed(2),
    netValue: num(vals.vLiq),
    ibs: num(obj(cibs.gIBS).vIBSTot),
    cbs: num(obj(cibs.gCBS).vCBS),
    check,
    notes,
  };
}
