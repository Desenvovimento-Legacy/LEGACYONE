import { unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";

/**
 * Leitor mínimo de planilha .xlsx (Office Open XML), sem dependência nova:
 * primeira aba, células como texto (números no formato do arquivo, datas como
 * número de série do Excel). .xls antigo (binário) não é aceito.
 */

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false, removeNSPrefix: true });
type Node = Record<string, unknown>;
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string => {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") {
    const o = v as Node;
    if ("#text" in o) return String(o["#text"]);
    // rich text: <si><r><t>..</t></r>...</si>
    if (o.r) return arr(o.r as Node[]).map((r) => text((r as Node).t)).join("");
    if (o.t !== undefined) return text(o.t);
    return "";
  }
  return String(v);
};

export class XlsxError extends Error {}

export function isXlsx(bytes: Buffer): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/** Linhas da primeira aba (cada linha = valores das colunas A, B, C...). */
export function readXlsxRows(bytes: Buffer): string[][] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(bytes));
  } catch {
    throw new XlsxError("Planilha corrompida ou protegida por senha");
  }
  const dec = (p: string) => (files[p] ? Buffer.from(files[p]!).toString("utf8") : null);
  const wb = dec("xl/workbook.xml");
  if (!wb) throw new XlsxError("Arquivo não é uma planilha .xlsx");
  const rels = dec("xl/_rels/workbook.xml.rels");
  const sheets = arr(((parser.parse(wb) as Node).workbook as Node)?.sheets ? (((parser.parse(wb) as Node).workbook as Node).sheets as Node).sheet as Node[] : []);
  const firstRid = sheets[0] ? String((sheets[0] as Node)["@_id"] ?? "") : "";
  let path = "xl/worksheets/sheet1.xml";
  if (rels && firstRid) {
    const rel = arr(((parser.parse(rels) as Node).Relationships as Node)?.Relationship as Node[]).find((r) => (r as Node)["@_Id"] === firstRid) as Node | undefined;
    const target = rel ? String(rel["@_Target"]) : null;
    if (target) path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  }
  const sheetXml = dec(path);
  if (!sheetXml) throw new XlsxError("Planilha sem aba legível");
  const ssXml = dec("xl/sharedStrings.xml");
  const shared = ssXml ? arr(((parser.parse(ssXml) as Node).sst as Node)?.si as Node[]).map((si) => text(si)) : [];
  const sheet = (parser.parse(sheetXml) as Node).worksheet as Node;
  const rows = arr(((sheet?.sheetData as Node) ?? {}).row as Node[]);
  const colIndex = (ref: string) => {
    const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  return rows.map((r) => {
    const out: string[] = [];
    for (const c of arr((r as Node).c as Node[])) {
      const cell = c as Node;
      const t = String(cell["@_t"] ?? "");
      const raw = t === "inlineStr" ? text((cell.is as Node) ?? "") : text(cell.v);
      const v = t === "s" ? shared[Number(raw)] ?? "" : raw;
      out[colIndex(String(cell["@_r"] ?? "A1"))] = v.trim();
    }
    return Array.from(out, (x) => x ?? "");
  });
}
