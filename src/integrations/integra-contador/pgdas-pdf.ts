import { extractText, getDocumentProxy } from "unpdf";

/**
 * Leitura determinística do PDF oficial da declaração PGDAS-D (sem IA):
 *   2.1) Discriminativo de Receitas → RPA (mercado interno, externo, total) e RBT12
 *   2.2) Receitas Brutas Anteriores → 2.2.1 Mercado Interno / 2.2.2 Mercado Externo, mês a mês
 *   Regime de Apuração: Competência | Caixa
 * Valores em texto com 2 casas (nunca float).
 */

export async function pdfText(pdf: Buffer): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  const { text } = await extractText(doc, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}

/** "1.234,56" → "1234.56" */
export function brMoney(s: string): string {
  const clean = s.replace(/\./g, "").replace(",", ".");
  const [i, d = ""] = clean.split(".");
  return `${Number(i)}.${(d + "00").slice(0, 2)}`;
}

const MONEY = "(\\d{1,3}(?:\\.\\d{3})*,\\d{2})";

export interface DeclaredMonth {
  /** AAAA-MM-01 */
  competence: string;
  internal: string | null;
  external: string | null;
  total: string;
  source: "RPA" | "ANTERIOR";
}

export interface PgdasDeclarationContent {
  period: string | null;
  regime: "COMPETENCIA" | "CAIXA" | null;
  rpa: { internal: string; external: string; total: string } | null;
  rbt12: string | null;
  months: DeclaredMonth[];
}

const comp = (mmYYYY: string) => `${mmYYYY.slice(3, 7)}-${mmYYYY.slice(0, 2)}-01`;
const add = (a: string | null, b: string | null) => {
  const cents = Math.round(Number(a ?? 0) * 100) + Math.round(Number(b ?? 0) * 100);
  return (cents / 100).toFixed(2);
};

function monthPairs(section: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = new RegExp(`(\\d{2}/\\d{4})\\s+${MONEY}`, "g");
  for (const m of section.matchAll(re)) out.set(comp(m[1]!), brMoney(m[2]!));
  return out;
}

export function parsePgdasDeclarationText(raw: string, fallbackCompetence?: string): PgdasDeclarationContent {
  const text = raw.replace(/ /g, " ").replace(/[ \t]+/g, " ");
  const flat = text.replace(/\s+/g, " ");
  // "Período de Apuração (PA): 08/2026" ou "Período de Apuração: 01/08/2026 a 31/08/2026"
  const paM = /Per[ií]odo de Apura[cç][aã]o(?: \(PA\))?:?\s*(?:\d{2}\/)?(\d{2}\/\d{4})/i.exec(flat);
  const pa = paM?.[1] ?? (fallbackCompetence ? `${fallbackCompetence.slice(5, 7)}/${fallbackCompetence.slice(0, 4)}` : null);
  const regimeTxt = /Regime de Apura[cç][aã]o:?\s*(Compet[eê]ncia|Caixa)/i.exec(flat)?.[1] ?? null;
  const regime = regimeTxt ? (/caixa/i.test(regimeTxt) ? "CAIXA" : "COMPETENCIA") : null;

  const rpaM = new RegExp(`Receita Bruta do PA \\(RPA\\)\\s*-?\\s*(?:Compet[eê]ncia|Caixa)?\\s*${MONEY}\\s+${MONEY}\\s+${MONEY}`, "i").exec(flat);
  const rpa = rpaM ? { internal: brMoney(rpaM[1]!), external: brMoney(rpaM[2]!), total: brMoney(rpaM[3]!) } : null;
  const rbtM = new RegExp(`\\(RBT12\\)\\s*${MONEY}\\s+${MONEY}\\s+${MONEY}`, "i").exec(flat);
  const rbt12 = rbtM ? brMoney(rbtM[3]!) : null;

  const idxInt = flat.search(/2\.2\.1\)?\s*Mercado Interno/i);
  const idxExt = flat.search(/2\.2\.2\)?\s*Mercado Externo/i);
  const idxEnd = flat.search(/2\.3\)/);
  const internal = idxInt >= 0 ? monthPairs(flat.slice(idxInt, idxExt > idxInt ? idxExt : idxEnd > idxInt ? idxEnd : undefined)) : new Map<string, string>();
  const external = idxExt >= 0 ? monthPairs(flat.slice(idxExt, idxEnd > idxExt ? idxEnd : undefined)) : new Map<string, string>();

  const months: DeclaredMonth[] = [];
  const keys = [...new Set([...internal.keys(), ...external.keys()])].sort();
  for (const k of keys) {
    const i = internal.get(k) ?? null;
    const e = external.get(k) ?? null;
    months.push({ competence: k, internal: i, external: e, total: add(i, e), source: "ANTERIOR" });
  }
  if (pa && rpa) {
    const c = comp(pa);
    const at = months.findIndex((m) => m.competence === c);
    const row: DeclaredMonth = { competence: c, internal: rpa.internal, external: rpa.external, total: rpa.total, source: "RPA" };
    if (at >= 0) months[at] = row;
    else months.push(row);
  }
  return { period: pa ? comp(pa) : null, regime, rpa, rbt12, months };
}
