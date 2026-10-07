import { extractText, getDocumentProxy } from "unpdf";

/**
 * Leitura determinística do PDF oficial da declaração PGDAS-D (sem IA):
 *   2.1) Discriminativo de Receitas → RPA (mercado interno, externo, total) e RBT12
 *   2.2) Receitas Brutas Anteriores → 2.2.1 Mercado Interno / 2.2.2 Mercado Externo, mês a mês
 *   Regime de Apuração: Competência | Caixa
 *   2.7) débito por atividade (anexo, retenção) e por tributo; sublimite e impedimento
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

/** Débito declarado de uma atividade (seção 2.7), valores com 2 casas. */
export interface DeclaredActivity {
  seq: number;
  activity: string;
  annex: "I" | "II" | "III" | "IV" | "V" | null;
  /** true = com retenção/substituição do ICMS/ISS; false = sem; null = não informado */
  localWithheld: boolean | null;
  factorR: boolean;
  revenue: string;
  taxes: { IRPJ: string; CSLL: string; COFINS: string; PIS: string; CPP: string; ICMS: string; IPI: string; ISS: string };
  total: string;
}

export interface PgdasDeclarationContent {
  period: string | null;
  regime: "COMPETENCIA" | "CAIXA" | null;
  rpa: { internal: string; external: string; total: string } | null;
  rbt12: string | null;
  rba: string | null;
  rbaa: string | null;
  sublimit: string | null;
  localImpeded: boolean | null;
  activities: DeclaredActivity[];
  months: DeclaredMonth[];
}

const TAX_HEADER = "IRPJ CSLL COFINS PIS\\/Pasep INSS\\/CPP ICMS IPI ISS Total";

function parseActivities(flat: string): DeclaredActivity[] {
  const nine = Array.from({ length: 9 }, () => MONEY).join("\\s+");
  const re = new RegExp(
    `Valor do D[ée]bito por Tributo para a Atividade \\(R\\$\\):\\s*(.+?)\\s*Receita Bruta Informada:\\s*R\\$\\s*${MONEY}\\s*${TAX_HEADER}\\s*${nine}`,
    "gi",
  );
  const out: DeclaredActivity[] = [];
  for (const m of flat.matchAll(re)) {
    const text = m[1]!.trim();
    const v = m.slice(3, 12).map((x) => brMoney(x!));
    const annex = (/Anexo (V|IV|III|II|I)\b/.exec(text)?.[1] ?? null) as DeclaredActivity["annex"];
    const withheld = /sem reten[cç][aã]o/i.test(text) ? false : /com (reten[cç][aã]o|substitui[cç][aã]o)/i.test(text) ? true : null;
    out.push({
      seq: out.length + 1,
      activity: text,
      annex,
      localWithheld: withheld,
      factorR: /fator r/i.test(text),
      revenue: brMoney(m[2]!),
      taxes: { IRPJ: v[0]!, CSLL: v[1]!, COFINS: v[2]!, PIS: v[3]!, CPP: v[4]!, ICMS: v[5]!, IPI: v[6]!, ISS: v[7]! },
      total: v[8]!,
    });
  }
  return out;
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
  const rbaM = new RegExp(`\\(RBA\\)\\s*${MONEY}\\s+${MONEY}\\s+${MONEY}`, "i").exec(flat);
  const rbaaM = new RegExp(`\\(RBAA\\)\\s*${MONEY}\\s+${MONEY}\\s+${MONEY}`, "i").exec(flat);
  const subM = new RegExp(`Sublimite de Receita Anual \\(R\\$\\):?\\s*${MONEY}`, "i").exec(flat);
  const impM = /Impedido de recolher ICMS\/ISS no DAS:?\s*(Sim|N[aã]o)/i.exec(flat);

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
  return {
    period: pa ? comp(pa) : null,
    regime,
    rpa,
    rbt12,
    rba: rbaM ? brMoney(rbaM[3]!) : null,
    rbaa: rbaaM ? brMoney(rbaaM[3]!) : null,
    sublimit: subM ? brMoney(subM[1]!) : null,
    localImpeded: impM ? /sim/i.test(impM[1]!) : null,
    activities: parseActivities(flat),
    months,
  };
}
