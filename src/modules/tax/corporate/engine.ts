import { Dec } from "../../../shared/decimal.js";

/**
 * Motor dos tributos do lucro (Lucro Presumido e Lucro Real). Funções puras:
 * recebem valores já apurados das fontes (notas, razão, e-LALUR) e as regras
 * aprovadas, devolvem base, tributo, deduções e quotas — com a memória de
 * cálculo em linhas legíveis. IA não participa.
 */

export const CORPORATE_ENGINE = "lucro-1";

const pct = (v: string) => Dec.of(v).div("100");
const z = Dec.ZERO;
const pos = (v: Dec) => (v.cmp("0") > 0 ? v : z);
const min = (a: Dec, b: Dec) => (a.cmp(b) <= 0 ? a : b);
const fx = (v: Dec) => v.toFixed(2);
const brl = (v: Dec | string) => Number(Dec.of(v).toFixed(2)).toLocaleString("pt-BR", { minimumFractionDigits: 2 });

export interface PresumptionGroup { label: string; irpj: string; csll: string }
export interface Lc224 { increase: string; annualLimit: string; quarterLimit: string; irpjFrom: string; csllFrom: string }
export interface IrpjCsllRates { irpj: string; additional: string; additionalMonthly: string; csll: string }

/** Receita do período por grupo de presunção. */
export type RevenueByGroup = Record<string, string>;

export interface PresumedBaseInput {
  revenue: RevenueByGroup;
  groups: Record<string, PresumptionGroup>;
  tax: "IRPJ" | "CSLL";
  /** LC 224/2025: limite disponível no trimestre (R$ 1.250.000 + sobra dos trimestres anteriores). Nulo = não se aplica. */
  lc224?: { increase: string; limit: string } | null;
}

export interface PresumedBase {
  base: string;
  revenue: string;
  excess: string;
  limitUsed: string;
  lines: string[];
}

/**
 * Base presumida do trimestre (ou do mês, na estimativa): receita × percentual
 * de cada atividade. Com a LC 224, a receita acima do limite recebe o
 * percentual × 1,10, repartida entre as atividades na proporção da receita
 * (IN RFB 2.306/2026, art. 15, §§ 3º e 6º).
 */
export function presumedBase(i: PresumedBaseInput): PresumedBase {
  const entries = Object.entries(i.revenue).filter(([, v]) => Dec.of(v).cmp("0") !== 0);
  const total = entries.reduce((s, [, v]) => s.add(v), z);
  const limit = i.lc224 ? Dec.of(i.lc224.limit) : null;
  const excess = limit ? pos(total.sub(limit)) : z;
  const lines: string[] = [];
  let base = z;
  for (const [g, v] of entries) {
    const grp = i.groups[g];
    if (!grp) throw new Error(`Grupo de presunção ${g} sem percentual nas regras`);
    const p = i.tax === "IRPJ" ? grp.irpj : grp.csll;
    const rev = Dec.of(v);
    // parcela desta atividade no excedente, proporcional à receita
    const share = excess.isZero() || total.isZero() ? z : excess.mul(rev).div(total);
    const normal = rev.sub(share);
    const inc = i.lc224 ? Dec.of(p).mul(Dec.of("1").add(pct(i.lc224.increase))) : Dec.of(p);
    const b = normal.mul(pct(p)).add(share.mul(pct(inc.toFixed(4))));
    base = base.add(b);
    lines.push(share.isZero()
      ? `${grp.label}: ${brl(rev)} × ${p}% = ${brl(b)}`
      : `${grp.label}: ${brl(normal)} × ${p}% + ${brl(share)} × ${Number(inc.toFixed(4)).toLocaleString("pt-BR")}% (LC 224) = ${brl(b)}`);
  }
  return { base: fx(base), revenue: fx(total), excess: fx(excess), limitUsed: fx(limit ? min(total, limit) : z), lines };
}

/** IRPJ: 15% + adicional de 10% sobre o que passar de R$ 20.000 × meses. */
export function irpjDue(base: string, months: number, r: IrpjCsllRates) {
  const b = pos(Dec.of(base));
  const normal = b.mul(pct(r.irpj));
  const threshold = Dec.of(r.additionalMonthly).mul(String(months));
  const add = pos(b.sub(threshold)).mul(pct(r.additional));
  return { normal: fx(normal), additional: fx(add), total: fx(normal.add(add)), threshold: fx(threshold) };
}

export const csllDue = (base: string, r: IrpjCsllRates) => fx(pos(Dec.of(base)).mul(pct(r.csll)));

/**
 * Quotas do IRPJ/CSLL trimestral: única, ou até 3 mensais iguais sem nenhuma
 * abaixo de R$ 1.000,00; abaixo de R$ 2.000,00 só em quota única. Juros da 2ª e
 * 3ª quota (Selic) são calculados na emissão do DARF.
 */
export function quotasFor(amount: string, option: "UNICA" | "TRES", minQuota: string, singleBelow: string, maxQuotas = 3): string[] {
  const a = Dec.of(amount);
  if (!a.gt("0")) return [];
  if (option === "UNICA" || a.cmp(singleBelow) < 0) return [fx(a)];
  let n = maxQuotas;
  while (n > 1 && a.div(String(n)).cmp(minQuota) < 0) n--;
  const q = Dec.of(a.div(String(n)).toFixed(2));
  const out = Array.from({ length: n }, () => q);
  out[n - 1] = a.sub(q.mul(String(n - 1)));
  return out.map(fx);
}

/** Lucro real do período: resultado contábil + adições − exclusões − compensação (trava de 30%). */
export function realProfit(i: { result: string; additions: string; exclusions: string; lossBalance: string; limitPct: string }) {
  const adjusted = Dec.of(i.result).add(i.additions).sub(i.exclusions);
  if (adjusted.cmp("0") <= 0) {
    return { adjusted: fx(adjusted), compensated: "0.00", taxable: "0.00", newLoss: fx(adjusted.mul("-1")), lossAfter: fx(Dec.of(i.lossBalance).sub(adjusted)) };
  }
  const cap = adjusted.mul(pct(i.limitPct));
  const comp = min(Dec.of(i.lossBalance), cap);
  return { adjusted: fx(adjusted), compensated: fx(comp), taxable: fx(adjusted.sub(comp)), newLoss: "0.00", lossAfter: fx(Dec.of(i.lossBalance).sub(comp)) };
}

/** Partilha do CSRF retido (4,65%) entre CSLL 1%, PIS 0,65% e COFINS 3%. */
export function splitCsrf(csrf: string) {
  const c = Dec.of(csrf);
  const csll = Dec.of(c.mul("1").div("4.65").toFixed(2));
  const pis = Dec.of(c.mul("0.65").div("4.65").toFixed(2));
  return { csll: fx(csll), pis: fx(pis), cofins: fx(c.sub(csll).sub(pis)) };
}

/** Trimestre de uma competência: 1 a 4. */
export const quarterOf = (comp: string) => Math.floor((Number(comp.slice(5, 7)) - 1) / 3) + 1;
export const quarterStart = (year: number, q: number) => `${year}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`;

/**
 * Limite da LC 224 por trimestre com a sobra dos anteriores do mesmo ano
 * (IN RFB 2.306/2026, art. 15, §§ 2º a 4º e 9º). `revenues[q]` = receita bruta
 * do trimestre q (1..4) já apurado; `active[q]` = trimestre em atividade.
 */
export function lc224Limits(revenues: Record<number, string>, quarterLimit: string, active: Record<number, boolean> = {}): Record<number, string> {
  const out: Record<number, string> = {};
  let carry = z;
  for (let q = 1; q <= 4; q++) {
    if (active[q] === false) { out[q] = "0.00"; continue; }
    const lim = Dec.of(quarterLimit).add(carry);
    out[q] = fx(lim);
    const rev = Dec.of(revenues[q] ?? "0");
    carry = pos(lim.sub(rev));
  }
  return out;
}

export { brl as brlCorporate };
