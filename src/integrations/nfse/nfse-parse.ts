import { XMLParser } from "fast-xml-parser";
import { money } from "../sefaz/nfe-parse.js";

/**
 * Leitura determinística da NFS-e no leiaute nacional (NFSe/infNFSe com a DPS
 * dentro) e dos eventos. Sem IA. Valores em texto com 2 casas.
 */

export interface NfseSummary {
  isEvent: boolean;
  accessKey: string | null;
  number: string | null;
  issuedAt: string | null;
  providerDoc: string | null;
  providerName: string | null;
  takerDoc: string | null;
  takerName: string | null;
  serviceValue: string | null;
  netValue: string | null;
  issValue: string | null;
  /** tpRetISSQN: 1 = não retido; 2/3 = retido (tomador/intermediário). */
  issWithheld: boolean | null;
  municipality: string | null;
  eventType: string | null;
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
const doc = (n: Node): string | null => str(n.CNPJ) ?? str(n.CPF) ?? str(n.NIF);

export function summarizeNfse(xml: string): NfseSummary {
  const root = parser.parse(xml) as Node;
  const base: NfseSummary = {
    isEvent: false, accessKey: null, number: null, issuedAt: null, providerDoc: null, providerName: null, takerDoc: null,
    takerName: null, serviceValue: null, netValue: null, issValue: null, issWithheld: null, municipality: null, eventType: null,
  };
  if (root.NFSe) {
    const inf = obj(obj(root.NFSe).infNFSe);
    const dps = obj(obj(inf.DPS).infDPS);
    const emit = obj(inf.emit);
    const prest = obj(dps.prest);
    const toma = obj(dps.toma);
    const vals = obj(inf.valores);
    const dv = obj(dps.valores);
    const ret = str(obj(obj(dv.trib).tribMun).tpRetISSQN);
    const id = str(inf["@_Id"]);
    return {
      ...base,
      accessKey: id ? id.replace(/^NFS/, "") : null,
      number: str(inf.nNFSe),
      issuedAt: str(dps.dhEmi) ?? str(inf.dhProc),
      providerDoc: doc(emit) ?? doc(prest),
      providerName: str(emit.xNome) ?? str(prest.xNome),
      takerDoc: doc(toma),
      takerName: str(toma.xNome),
      serviceValue: money(obj(dv.vServPrest).vServ),
      netValue: money(vals.vLiq),
      issValue: money(vals.vISSQN),
      issWithheld: ret === null ? null : ret !== "1",
      municipality: str(inf.xLocIncid) ?? str(inf.xLocEmi),
    };
  }
  const ev = obj(root.evento ?? root.Evento ?? root.pedRegEvento);
  const inf = obj(ev.infEvento ?? ev.infPedReg);
  const ped = obj(obj(inf.pedRegEvento).infPedReg);
  const tp = Object.keys(ped).find((k) => /^e\d{6}$/.test(k)) ?? Object.keys(inf).find((k) => /^e\d{6}$/.test(k)) ?? null;
  return {
    ...base,
    isEvent: true,
    accessKey: str(ped.chNFSe) ?? str(inf.chNFSe),
    issuedAt: str(ped.dhEvento) ?? str(inf.dhProc) ?? str(inf.dhEvento),
    eventType: tp ? tp.slice(1) : null,
  };
}

/** Papel da empresa na nota, pela raiz do CNPJ. */
export function nfseRole(s: NfseSummary, entityCnpj: string): "PRESTADA" | "TOMADA" | "OUTRA" | "EVENTO" {
  if (s.isEvent) return "EVENTO";
  const root = entityCnpj.slice(0, 8);
  if (s.providerDoc?.slice(0, 8) === root) return "PRESTADA";
  if (s.takerDoc?.slice(0, 8) === root) return "TOMADA";
  return "OUTRA";
}
