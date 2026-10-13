import { XMLParser } from "fast-xml-parser";
import { Dec } from "../../shared/decimal.js";

/**
 * Itens da NF-e/NFC-e (leitura determinística do XML autorizado, sem IA):
 * produto, NCM, CEST, CFOP, CST/CSOSN do ICMS, ICMS-ST, crédito do Simples
 * (pCredSN), IPI, PIS e COFINS de cada item, e o cabeçalho que dá o sentido
 * da operação (tpNF, idDest, CRT do emitente, UFs).
 */

export const NFE_ITEMS_PARSER = "nfe-itens-1";

export interface NfeHeader {
  accessKey: string | null;
  model: string | null;
  number: string | null;
  issuedAt: string | null;
  /** 0 entrada · 1 saída (do ponto de vista do emitente) */
  nfType: string | null;
  /** 1 interna · 2 interestadual · 3 exterior */
  idDest: string | null;
  /** finNFe: 1 normal · 2 complementar · 3 ajuste · 4 devolução */
  purpose: string | null;
  operation: string | null;
  issuerDoc: string | null;
  issuerName: string | null;
  /** CRT: 1 Simples · 2 Simples com excesso de sublimite · 3 regime normal · 4 MEI */
  issuerCrt: string | null;
  issuerUf: string | null;
  recipientDoc: string | null;
  recipientUf: string | null;
  authorized: boolean;
  /** vNF: total da nota (produtos − desconto + frete + seguro + outras + IPI + ST) */
  totalNf: string | null;
  freight: string;
  insurance: string;
  /** duplicatas (cobr/dup): parcelas a pagar/receber */
  installments: { n: string; due: string | null; amount: string }[];
}

export interface NfeItem {
  n: number;
  productCode: string | null;
  description: string | null;
  ncm: string | null;
  cest: string | null;
  cfop: string | null;
  unit: string | null;
  quantity: string | null;
  total: string;
  discount: string;
  freight: string;
  other: string;
  origin: string | null;
  icmsCst: string | null;
  icmsCsosn: string | null;
  icmsBase: string;
  icmsRate: string | null;
  icmsValue: string;
  stBase: string;
  stValue: string;
  stRetained: string;
  snCreditRate: string | null;
  snCreditValue: string;
  ipiCst: string | null;
  ipiValue: string;
  pisCst: string | null;
  pisValue: string;
  cofinsCst: string | null;
  cofinsValue: string;
}

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, attributeNamePrefix: "@_" });
type Node = Record<string, unknown>;
const obj = (v: unknown): Node => (v && typeof v === "object" && !Array.isArray(v) ? (v as Node) : {});
const str = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v === "object") return str((v as Node)["#text"]);
  const s = String(v).trim();
  return s === "" ? null : s;
};
const num = (v: unknown, places = 2): string | null => {
  const s = str(v);
  return s && /^-?\d+(\.\d+)?$/.test(s) ? Dec.of(s).toFixed(places) : null;
};
const z = (v: string | null) => v ?? "0.00";
const docOf = (n: unknown): string | null => str(obj(n).CNPJ) ?? str(obj(n).CPF);
/** Grupo com um único filho de nome variável (ICMS00, ICMSSN101, PISAliq...). */
const inner = (n: unknown): Node => {
  const o = obj(n);
  const k = Object.keys(o).find((x) => !x.startsWith("@_"));
  return k ? obj(o[k]) : {};
};

export function readNfeItems(xml: string): { header: NfeHeader; items: NfeItem[] } | null {
  let root: Node;
  try {
    root = parser.parse(xml) as Node;
  } catch {
    return null;
  }
  const nfe = root.nfeProc ? obj(obj(root.nfeProc).NFe) : root.NFe ? obj(root.NFe) : null;
  if (!nfe) return null;
  const inf = obj(nfe.infNFe);
  const ide = obj(inf.ide);
  const emit = obj(inf.emit);
  const dest = obj(inf.dest);
  const prot = obj(obj(obj(root.nfeProc).protNFe).infProt);
  const id = str(inf["@_Id"])?.replace(/^NFe/, "") ?? str(prot.chNFe);
  const cStat = str(prot.cStat);
  const header: NfeHeader = {
    accessKey: id && /^\d{44}$/.test(id) ? id : null,
    model: str(ide.mod),
    number: str(ide.nNF),
    issuedAt: str(ide.dhEmi) ?? str(ide.dEmi),
    nfType: str(ide.tpNF),
    idDest: str(ide.idDest),
    purpose: str(ide.finNFe),
    operation: str(ide.natOp),
    issuerDoc: docOf(emit),
    issuerName: str(emit.xNome),
    issuerCrt: str(emit.CRT),
    issuerUf: str(obj(emit.enderEmit).UF),
    recipientDoc: docOf(dest),
    recipientUf: str(obj(dest.enderDest).UF),
    authorized: cStat === "100" || cStat === "150",
    totalNf: num(obj(obj(inf.total).ICMSTot).vNF),
    freight: z(num(obj(obj(inf.total).ICMSTot).vFrete)),
    insurance: z(num(obj(obj(inf.total).ICMSTot).vSeg)),
    installments: (() => {
      const d = obj(inf.cobr).dup;
      const list = d === undefined ? [] : Array.isArray(d) ? d : [d];
      return list.map((x, i) => ({ n: str(obj(x).nDup) ?? String(i + 1).padStart(3, "0"), due: str(obj(x).dVenc), amount: z(num(obj(x).vDup)) }))
        .filter((x) => Dec.of(x.amount).gt("0"));
    })(),
  };
  const dets = inf.det === undefined ? [] : Array.isArray(inf.det) ? inf.det : [inf.det];
  const items: NfeItem[] = dets.map((d, i) => {
    const det = obj(d);
    const prod = obj(det.prod);
    const imp = obj(det.imposto);
    const icms = inner(imp.ICMS);
    const ipi = obj(imp.IPI);
    const ipiG = obj(ipi.IPITrib ?? ipi.IPINT);
    const pis = inner(imp.PIS);
    const cof = inner(imp.COFINS);
    return {
      n: Number(str(det["@_nItem"]) ?? i + 1),
      productCode: str(prod.cProd),
      description: str(prod.xProd),
      ncm: str(prod.NCM),
      cest: str(prod.CEST),
      cfop: str(prod.CFOP),
      unit: str(prod.uCom),
      quantity: num(prod.qCom, 4),
      total: z(num(prod.vProd)),
      discount: z(num(prod.vDesc)),
      freight: z(num(prod.vFrete)),
      other: z(num(prod.vOutro)),
      origin: str(icms.orig),
      icmsCst: str(icms.CST),
      icmsCsosn: str(icms.CSOSN),
      icmsBase: z(num(icms.vBC)),
      icmsRate: num(icms.pICMS, 4),
      icmsValue: z(num(icms.vICMS)),
      stBase: z(num(icms.vBCST)),
      stValue: z(num(icms.vICMSST)),
      stRetained: z(num(icms.vICMSSTRet)),
      snCreditRate: num(icms.pCredSN, 4),
      snCreditValue: z(num(icms.vCredICMSSN)),
      ipiCst: str(ipiG.CST),
      ipiValue: z(num(ipiG.vIPI)),
      pisCst: str(pis.CST),
      pisValue: z(num(pis.vPIS)),
      cofinsCst: str(cof.CST),
      cofinsValue: z(num(cof.vCOFINS)),
    };
  });
  return { header, items };
}
