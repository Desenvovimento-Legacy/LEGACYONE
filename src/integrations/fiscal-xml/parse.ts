import { XMLParser } from "fast-xml-parser";
import { summarizeNfse } from "../nfse/nfse-parse.js";
import { money } from "../sefaz/nfe-parse.js";

/**
 * Identificação determinística de XML fiscal (sem IA): NF-e (mod. 55), NFC-e
 * (mod. 65), CT-e (mod. 57/67), NFS-e do padrão nacional e eventos de NF-e e
 * CT-e. Lê só o que está no XML; não confere assinatura (a evidência é o
 * próprio arquivo guardado com hash).
 */

export type FiscalDocType = "NFE" | "NFCE" | "CTE" | "NFSE" | "EVENTO_NFE" | "EVENTO_CTE" | "OUTRO";
export type FiscalStatus = "AUTORIZADO" | "CANCELADO" | "DENEGADO" | "SEM_PROTOCOLO";

export interface FiscalDoc {
  docType: FiscalDocType;
  accessKey: string | null;
  number: string | null;
  issuerDoc: string | null;
  issuerName: string | null;
  recipientDoc: string | null;
  recipientName: string | null;
  /** tomador do serviço (CT-e e NFS-e) */
  takerDoc: string | null;
  issuedAt: string | null;
  total: string | null;
  status: FiscalStatus | null;
  eventType: string | null;
  /** todos os CPF/CNPJ citados (para achar a empresa) */
  parties: string[];
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
const docOf = (n: unknown): string | null => str(obj(n).CNPJ) ?? str(obj(n).CPF);
const key = (v: unknown, prefix: string): string | null => {
  const s = str(v)?.replace(new RegExp(`^${prefix}`), "") ?? null;
  return s && /^\d{44}$/.test(s) ? s : null;
};
const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => Boolean(x)))];

function protStatus(cStat: string | null): FiscalStatus {
  if (!cStat) return "SEM_PROTOCOLO";
  if (cStat === "100" || cStat === "150") return "AUTORIZADO";
  if (cStat === "101" || cStat === "151" || cStat === "135" || cStat === "155") return "CANCELADO";
  if (cStat === "110" || cStat === "301" || cStat === "302" || cStat === "303") return "DENEGADO";
  return "SEM_PROTOCOLO";
}

const empty = (docType: FiscalDocType): FiscalDoc => ({
  docType, accessKey: null, number: null, issuerDoc: null, issuerName: null, recipientDoc: null, recipientName: null,
  takerDoc: null, issuedAt: null, total: null, status: null, eventType: null, parties: [],
});

export function parseFiscalXml(xml: string): FiscalDoc | null {
  let root: Node;
  try {
    root = parser.parse(xml) as Node;
  } catch {
    return null;
  }

  // ---------------------------------------------------------------- NF-e / NFC-e
  const nfeNode = root.nfeProc ? obj(obj(root.nfeProc).NFe) : root.NFe ? obj(root.NFe) : null;
  if (nfeNode) {
    const inf = obj(nfeNode.infNFe);
    const ide = obj(inf.ide);
    const emit = obj(inf.emit);
    const dest = obj(inf.dest);
    const prot = obj(obj(obj(root.nfeProc).protNFe).infProt);
    const mod = str(ide.mod);
    return {
      ...empty(mod === "65" ? "NFCE" : "NFE"),
      accessKey: key(obj(inf)["@_Id"], "NFe") ?? key(prot.chNFe, ""),
      number: str(ide.nNF),
      issuerDoc: docOf(emit),
      issuerName: str(emit.xNome),
      recipientDoc: docOf(dest),
      recipientName: str(dest.xNome),
      issuedAt: str(ide.dhEmi) ?? str(ide.dEmi),
      total: money(obj(obj(inf.total).ICMSTot).vNF),
      status: protStatus(str(prot.cStat)),
      parties: uniq([docOf(emit), docOf(dest), docOf(obj(inf.transp).transporta)]),
    };
  }

  // ---------------------------------------------------------------- evento de NF-e
  if (root.procEventoNFe || root.evento) {
    const ev = obj(obj(root.procEventoNFe).evento ?? root.evento);
    const inf = obj(ev.infEvento);
    const ret = obj(obj(obj(root.procEventoNFe).retEvento).infEvento);
    const tp = str(inf.tpEvento);
    return {
      ...empty("EVENTO_NFE"),
      accessKey: key(inf.chNFe, ""),
      issuerDoc: docOf(inf),
      issuedAt: str(inf.dhEvento),
      eventType: tp,
      status: tp === "110111" && (str(ret.cStat) === "135" || str(ret.cStat) === "155") ? "CANCELADO" : str(ret.cStat) ? "AUTORIZADO" : "SEM_PROTOCOLO",
      parties: uniq([docOf(inf), str(ret.CNPJDest)]),
    };
  }

  // ---------------------------------------------------------------- CT-e
  const cteNode = root.cteProc ? obj(obj(root.cteProc).CTe) : root.CTe ? obj(root.CTe) : null;
  if (cteNode) {
    const inf = obj(cteNode.infCte);
    const ide = obj(inf.ide);
    const emit = obj(inf.emit);
    const rem = obj(inf.rem);
    const dest = obj(inf.dest);
    const exped = obj(inf.exped);
    const receb = obj(inf.receb);
    const prot = obj(obj(obj(root.cteProc).protCTe).infProt);
    // Tomador: toma3 (0 remetente, 1 expedidor, 2 recebedor, 3 destinatário) ou toma4 (outro)
    const t3 = str(obj(ide.toma3).toma) ?? str(obj(ide.toma).toma);
    const toma4 = obj(ide.toma4);
    const takerDoc = docOf(toma4) ?? (t3 === "0" ? docOf(rem) : t3 === "1" ? docOf(exped) : t3 === "2" ? docOf(receb) : t3 === "3" ? docOf(dest) : null);
    return {
      ...empty("CTE"),
      accessKey: key(inf["@_Id"], "CTe") ?? key(prot.chCTe, ""),
      number: str(ide.nCT),
      issuerDoc: docOf(emit),
      issuerName: str(emit.xNome),
      recipientDoc: docOf(dest),
      recipientName: str(dest.xNome),
      takerDoc,
      issuedAt: str(ide.dhEmi),
      total: money(obj(inf.vPrest).vTPrest),
      status: protStatus(str(prot.cStat)),
      parties: uniq([docOf(emit), docOf(rem), docOf(dest), docOf(exped), docOf(receb), docOf(toma4)]),
    };
  }

  // ---------------------------------------------------------------- evento de CT-e
  if (root.procEventoCTe || root.eventoCTe) {
    const ev = obj(obj(root.procEventoCTe).eventoCTe ?? root.eventoCTe);
    const inf = obj(ev.infEvento);
    const ret = obj(obj(obj(root.procEventoCTe).retEventoCTe).infEvento);
    const tp = str(inf.tpEvento);
    return {
      ...empty("EVENTO_CTE"),
      accessKey: key(inf.chCTe, ""),
      issuerDoc: docOf(inf),
      issuedAt: str(inf.dhEvento),
      eventType: tp,
      status: tp === "110111" && str(ret.cStat) === "135" ? "CANCELADO" : str(ret.cStat) ? "AUTORIZADO" : "SEM_PROTOCOLO",
      parties: uniq([docOf(inf)]),
    };
  }

  // ---------------------------------------------------------------- NFS-e (padrão nacional)
  if (root.NFSe || root.CompNFSe) {
    const s = summarizeNfse(xml);
    return {
      ...empty("NFSE"),
      accessKey: s.accessKey,
      number: s.number,
      issuerDoc: s.providerDoc,
      issuerName: s.providerName,
      recipientDoc: s.takerDoc,
      recipientName: s.takerName,
      takerDoc: s.takerDoc,
      issuedAt: s.issuedAt,
      total: s.serviceValue,
      status: "AUTORIZADO",
      parties: uniq([s.providerDoc, s.takerDoc]),
    };
  }
  return null;
}

/** Papel da empresa no documento, pela raiz do CNPJ (8 primeiras posições). */
export function roleOf(d: FiscalDoc, cnpj: string): "EMITENTE" | "DESTINATARIO" | "TOMADOR" | "PRESTADOR" | "OUTRO" {
  const root = (x: string | null) => (x && x.length === 14 ? x.slice(0, 8) : x);
  const me = root(cnpj);
  if (d.docType === "NFSE") {
    if (root(d.issuerDoc) === me) return "PRESTADOR";
    if (root(d.takerDoc) === me) return "TOMADOR";
    return "OUTRO";
  }
  if (root(d.issuerDoc) === me) return "EMITENTE";
  if (d.docType === "CTE" && root(d.takerDoc) === me) return "TOMADOR";
  if (root(d.recipientDoc) === me) return "DESTINATARIO";
  return "OUTRO";
}
