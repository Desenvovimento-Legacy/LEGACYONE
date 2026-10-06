import { XMLParser } from "fast-xml-parser";

/**
 * Leitura determinística dos documentos da distribuição (sem IA): resumo de
 * NF-e, NF-e completa (nfeProc), resumo de evento e evento completo.
 */

export type DfeKind = "RES_NFE" | "NFE" | "RES_EVENTO" | "EVENTO" | "OUTRO";

export interface DfeSummary {
  kind: DfeKind;
  accessKey: string | null;
  issuerDoc: string | null;
  issuerName: string | null;
  recipientDoc: string | null;
  issuedAt: string | null;
  nfType: string | null;
  /** Valor total em texto com 2 casas ("1234.50"), nunca float. */
  total: string | null;
  situation: string | null;
  eventType: string | null;
  eventDesc: string | null;
}

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, attributeNamePrefix: "@_" });

const str = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v === "object") return str((v as Record<string, unknown>)["#text"]);
  const s = String(v).trim();
  return s === "" ? null : s;
};

export function money(v: unknown): string | null {
  const s = str(v);
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const [i, d = ""] = s.split(".");
  return `${i}.${(d + "00").slice(0, 2)}`;
}

const key44 = (v: unknown): string | null => {
  const s = str(v)?.replace(/^NFe/, "") ?? null;
  return s && /^\d{44}$/.test(s) ? s : null;
};

export function kindFromSchema(schema: string): DfeKind {
  if (/^resNFe/i.test(schema)) return "RES_NFE";
  if (/^procNFe/i.test(schema)) return "NFE";
  if (/^resEvento/i.test(schema)) return "RES_EVENTO";
  if (/^procEvento/i.test(schema)) return "EVENTO";
  return "OUTRO";
}

export function summarizeDfe(schema: string, xml: string): DfeSummary {
  const kind = kindFromSchema(schema);
  const empty: DfeSummary = {
    kind, accessKey: null, issuerDoc: null, issuerName: null, recipientDoc: null, issuedAt: null,
    nfType: null, total: null, situation: null, eventType: null, eventDesc: null,
  };
  const doc = parser.parse(xml) as Record<string, Record<string, unknown>>;
  if (kind === "RES_NFE") {
    const r = doc.resNFe ?? {};
    return {
      ...empty,
      accessKey: key44(r.chNFe),
      issuerDoc: str(r.CNPJ) ?? str(r.CPF),
      issuerName: str(r.xNome),
      issuedAt: str(r.dhEmi),
      nfType: str(r.tpNF),
      total: money(r.vNF),
      situation: str(r.cSitNFe),
    };
  }
  if (kind === "NFE") {
    const proc = doc.nfeProc ?? {};
    const inf = ((proc.NFe as Record<string, unknown>)?.infNFe ?? {}) as Record<string, Record<string, unknown>>;
    const prot = ((proc.protNFe as Record<string, unknown>)?.infProt ?? {}) as Record<string, unknown>;
    const dest = inf.dest ?? {};
    return {
      ...empty,
      accessKey: key44(prot.chNFe) ?? key44(inf["@_Id"]),
      issuerDoc: str(inf.emit?.CNPJ) ?? str(inf.emit?.CPF),
      issuerName: str(inf.emit?.xNome),
      recipientDoc: str(dest.CNPJ) ?? str(dest.CPF),
      issuedAt: str(inf.ide?.dhEmi) ?? str(inf.ide?.dEmi),
      nfType: str(inf.ide?.tpNF),
      total: money((inf.total?.ICMSTot as Record<string, unknown> | undefined)?.vNF),
      situation: str(prot.cStat) === "100" ? "1" : str(prot.cStat),
    };
  }
  if (kind === "RES_EVENTO") {
    const r = doc.resEvento ?? {};
    return {
      ...empty,
      accessKey: key44(r.chNFe),
      issuerDoc: str(r.CNPJ) ?? str(r.CPF),
      issuedAt: str(r.dhEvento),
      eventType: str(r.tpEvento),
      eventDesc: str(r.xEvento),
    };
  }
  if (kind === "EVENTO") {
    const p = doc.procEventoNFe ?? {};
    const inf = ((p.evento as Record<string, unknown>)?.infEvento ?? {}) as Record<string, unknown>;
    const det = (inf.detEvento ?? {}) as Record<string, unknown>;
    return {
      ...empty,
      accessKey: key44(inf.chNFe),
      issuerDoc: str(inf.CNPJ) ?? str(inf.CPF),
      issuedAt: str(inf.dhEvento),
      eventType: str(inf.tpEvento),
      eventDesc: str(det.descEvento),
    };
  }
  return empty;
}
