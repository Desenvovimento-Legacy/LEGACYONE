import { Dec, sumDec } from "../../../shared/decimal.js";
import { TAXES, type AnnexDefinition, type ParamsDefinition, type Tax } from "./rules.js";

/**
 * Motor determinístico do Simples Nacional (sem IA).
 *
 * Alíquota efetiva = (RBT12 × alíquota nominal − parcela a deduzir) / RBT12; com
 * RBT12 zero (início de atividade sem receita anterior) vale a nominal da 1ª faixa.
 * Cada tributo = base × alíquota efetiva × repartição da faixa.
 *
 * Teto do tributo local (ISS 5%): quando o percentual efetivo do ISS passa do
 * teto, o ISS fica no teto e a diferença vai aos tributos federais pelos
 * percentuais da nota do Anexo, somada à repartição normal da faixa.
 *
 * 6ª faixa (RBT12 acima do sublimite) sem impedimento: tributos federais pela
 * 6ª faixa; ICMS/ISS pela 5ª faixa (Res. CGSN 140, art. 21). A receita do mês é
 * dividida no ponto em que a receita acumulada no ano passa o sublimite:
 *   - parcela até o sublimite: percentual local com a RBT12 do contribuinte;
 *   - parcela acima do sublimite: percentual local da 5ª faixa no próprio sublimite.
 * Os dois tratamentos foram conferidos centavo a centavo contra declarações reais.
 *
 * Receita do ano acima do sublimite em qualquer faixa, ainda sem impedimento
 * (Res. CGSN 140, art. 24, I): tributos federais pelo art. 21; a parcela da
 * receita do mês que passa o sublimite paga ICMS/ISS pela 5ª faixa no próprio
 * sublimite, e a parcela até o sublimite pelo cálculo normal da faixa.
 *
 * Impedimento de recolher ICMS/ISS no DAS (Res. CGSN 140, art. 12): receita do
 * ano anterior acima do sublimite; receita do ano, antes do PA, acima do
 * sublimite em mais de 20% (efeito no mês seguinte ao excesso); ou, no ano de
 * início de atividade, excesso de mais de 20% (efeito retroativo ao início).
 * Impedido: o DAS leva só os tributos federais, pela faixa da RBT12; ICMS/ISS
 * são recolhidos fora do Simples.
 *
 * Arredondamento: cada tributo de cada parcela em centavos (meio para cima).
 * O que o motor não cobre (excesso do limite, impedimento com teto do ISS,
 * retenção no mês em que a receita passa o sublimite) volta como `ok: false`
 * com o motivo: nunca um valor inventado.
 */

export interface RevenueSegment {
  value: string;
  /** ISS/ICMS retido ou recolhido por substituição: fora do DAS */
  localWithheld?: boolean;
}

export interface SimplesInput {
  annex: AnnexDefinition;
  params: ParamsDefinition;
  rpa: RevenueSegment[];
  /** RBT12 (já proporcionalizada no início de atividade) */
  rbt12: string;
  /** receita bruta do ano-calendário antes do PA */
  rbaBefore: string;
  /** receita bruta do ano-calendário anterior */
  rbaa: string;
  /** meses de atividade no ano do PA e no ano anterior (limites proporcionais no início) */
  monthsInYear?: number;
  monthsPrevYear?: number;
  /**
   * Receita total do ano de início de atividade, quando o ano é o de início e a
   * receita do ano inteiro já é conhecida (impedimento retroativo, art. 12, § 4º).
   */
  startYearRevenue?: string;
}

export type ParcelKind = "NORMAL" | "ATE_SUBLIMITE" | "ACIMA_SUBLIMITE";

export interface Parcel {
  kind: ParcelKind;
  base: string;
  localWithheld: boolean;
  /** percentual efetivo do tributo local antes do teto, em % */
  localRate: string;
  /** percentual efetivo de cada tributo, em % */
  rates: Partial<Record<Tax, string>>;
  taxes: Partial<Record<Tax, string>>;
}

export type SimplesResult =
  | {
      ok: true;
      bracket: number;
      /** alíquota efetiva da faixa, em % com 6 casas */
      effectiveRate: string;
      parcels: Parcel[];
      taxes: Record<Tax, string>;
      total: string;
      notes: string[];
      /** impedido de recolher o ICMS/ISS no DAS, com o motivo */
      localImpeded: string | null;
    }
  | { ok: false; reason: string; bracket: number | null };

export const ENGINE_VERSION = "simples-1.1.0";

const prop = (v: string, months: number | undefined) =>
  months && months < 12 ? Dec.of(v).mul(BigInt(months)).div(12n) : Dec.of(v);

function effective(annex: AnnexDefinition, n: number, rbt12: Dec): Dec {
  const b = annex.brackets[n - 1]!;
  if (rbt12.isZero()) return Dec.pct(b.rate);
  return rbt12.mul(Dec.pct(b.rate)).sub(b.deduction).div(rbt12);
}

function bracketOf(annex: AnnexDefinition, rbt12: Dec): number | null {
  for (const b of annex.brackets) if (rbt12.lte(b.upTo)) return b.n;
  return null;
}

export function calculateSimples(input: SimplesInput): SimplesResult {
  const { annex, params } = input;
  const rbt12 = Dec.of(input.rbt12);
  const rpa = sumDec(input.rpa.map((s) => Dec.of(s.value)));
  const rbaBefore = Dec.of(input.rbaBefore);
  const rbaAfter = rbaBefore.add(rpa);
  const limitYear = prop(params.limit, input.monthsInYear);
  const sublimitYear = prop(params.sublimit, input.monthsInYear);
  const sublimitPrev = prop(params.sublimit, input.monthsPrevYear);
  const tolerance = Dec.pct(params.excessTolerance).add("1");

  const n = bracketOf(annex, rbt12);
  if (n === null) return { ok: false, reason: "RBT12 acima do limite do Simples Nacional", bracket: null };
  if (rbaAfter.gt(limitYear)) return { ok: false, reason: "Receita do ano acima do limite do Simples (excesso não coberto pelo motor)", bracket: n };

  const local = annex.localTax;
  const cap = annex.localCap ? Dec.pct(annex.localCap.rate) : null;
  const transfer = annex.localCap?.transfer ?? {};
  const eff = effective(annex, n, rbt12);
  const shares = annex.brackets[n - 1]!.shares;
  const notes: string[] = [];

  // Impedimento de recolher ICMS/ISS no DAS (Res. CGSN 140, art. 12)
  const startYear = input.monthsInYear !== undefined && input.monthsInYear < 12;
  let impeded: string | null = null;
  if (Dec.of(input.rbaa).gt(sublimitPrev)) impeded = "receita do ano anterior acima do sublimite";
  else if (rbaBefore.gt(sublimitYear.mul(tolerance))) impeded = "receita do ano acima do sublimite em mais de 20% em mês anterior";
  else if (startYear && input.startYearRevenue && Dec.of(input.startYearRevenue).gt(sublimitYear.mul(tolerance)))
    impeded = "ano de início de atividade com receita acima do sublimite proporcional em mais de 20% (efeito retroativo)";

  // Percentual local antes do teto, por tipo de parcela.
  type Plan = { kind: ParcelKind; base: Dec; withheld: boolean; localPre: Dec };
  const plans: Plan[] = [];
  const share = (b: number) => Dec.pct(annex.brackets[b - 1]!.shares[local] ?? "0");
  if (impeded) {
    // só tributos federais, pela faixa da RBT12; nada de ICMS/ISS no DAS
    const localPre = n < 6 ? eff.mul(share(n)) : Dec.ZERO;
    if (cap && localPre.gt(cap))
      return { ok: false, reason: `Impedido de recolher ${local} no DAS com o ${local} da faixa acima do teto de ${annex.localCap!.rate}%: transferência aos tributos federais não conferida`, bracket: n };
    for (const s of input.rpa) plans.push({ kind: "NORMAL", base: Dec.of(s.value), withheld: true, localPre: Dec.ZERO });
    notes.push(`Impedido de recolher ${local} no DAS (${impeded}): ${local} recolhido fora do Simples, pelas regras do ${local === "ISS" ? "município" : "estado"}`);
  } else {
    const share5 = share(5);
    const sub = Dec.of(params.sublimit);
    const within = Dec.max(Dec.ZERO, Dec.min(rpa, sublimitYear.sub(rbaBefore)));
    const above = rpa.sub(within);
    if (above.gt("0") && input.rpa.some((s) => s.localWithheld))
      return { ok: false, reason: "Retenção de ISS/ICMS no mês em que a receita passa o sublimite (regra ainda não implantada)", bracket: n };
    // até o sublimite: faixa da RBT12 (na 6ª faixa, o local pela 5ª faixa, art. 21)
    const withinPre = n < 6 ? eff.mul(share(n)) : effective(annex, 5, rbt12).mul(share5);
    const kindWithin: ParcelKind = n < 6 && above.isZero() ? "NORMAL" : "ATE_SUBLIMITE";
    if (within.gt("0") || above.isZero()) {
      if (above.isZero()) for (const s of input.rpa) plans.push({ kind: kindWithin, base: Dec.of(s.value), withheld: Boolean(s.localWithheld), localPre: withinPre });
      else plans.push({ kind: kindWithin, base: within, withheld: false, localPre: withinPre });
    }
    // acima do sublimite: local pela 5ª faixa no próprio sublimite (art. 24, I, b)
    if (above.gt("0")) plans.push({ kind: "ACIMA_SUBLIMITE", base: above, withheld: false, localPre: effective(annex, 5, sub).mul(share5) });
    if (n === 6) notes.push(`6ª faixa: tributos federais pela 6ª faixa; ${local} pela 5ª faixa`);
    else if (above.gt("0")) notes.push(`Receita do ano passou o sublimite: parcela acima com ${local} pela 5ª faixa (Res. CGSN 140, art. 24)`);
    if (rbaAfter.gt(sublimitYear.mul(tolerance))) notes.push(`Excesso do sublimite acima de 20%: ${local} fora do DAS a partir do mês seguinte (Res. CGSN 140, art. 12, § 1º, I)`);
    else if (rbaAfter.gt(sublimitYear)) notes.push(`Excesso do sublimite até 20%: ${local} fora do DAS a partir de janeiro do ano seguinte (art. 12, § 1º, II)`);
  }

  const totals = Object.fromEntries(TAXES.map((t) => [t, Dec.ZERO])) as Record<Tax, Dec>;
  const parcels: Parcel[] = [];
  for (const p of plans) {
    const excess = cap && p.localPre.gt(cap) ? p.localPre.sub(cap) : Dec.ZERO;
    if (!cap && p.localPre.gt("0.05")) return { ok: false, reason: `${local} acima de 5% sem regra de transferência no Anexo ${annex.annex}`, bracket: n };
    const rates: Partial<Record<Tax, Dec>> = {};
    for (const t of TAXES) {
      if (t === local) continue;
      const base = eff.mul(Dec.pct(shares[t] ?? "0"));
      const extra = excess.mul(Dec.pct(transfer[t] ?? "0"));
      if (shares[t] || transfer[t]) rates[t] = base.add(extra);
    }
    if (!p.withheld && (shares[local] || n === 6)) rates[local] = cap ? Dec.min(p.localPre, cap) : p.localPre;
    if (excess.gt("0") && !notes.some((x) => x.startsWith("Teto"))) notes.push(`Teto de ${annex.localCap!.rate}% do ${local}: diferença transferida aos tributos federais`);
    if (p.withheld && !impeded && !notes.some((x) => x.startsWith("Retenção"))) notes.push(`Retenção: ${local} fora do DAS nessa parcela (sem declaração real conferida)`);
    const taxes: Partial<Record<Tax, string>> = {};
    const rateStr: Partial<Record<Tax, string>> = {};
    for (const [t, r] of Object.entries(rates) as [Tax, Dec][]) {
      const v = p.base.mul(r).round(2);
      taxes[t] = v.toFixed(2);
      rateStr[t] = r.mul(100n).toFixed(8);
      totals[t] = totals[t].add(v);
    }
    parcels.push({ kind: p.kind, base: p.base.toFixed(2), localWithheld: p.withheld, localRate: p.localPre.mul(100n).toFixed(8), rates: rateStr, taxes });
  }

  const taxes = Object.fromEntries(TAXES.map((t) => [t, totals[t].toFixed(2)])) as Record<Tax, string>;
  return {
    ok: true,
    bracket: n,
    effectiveRate: eff.mul(100n).toFixed(6),
    parcels,
    taxes,
    total: sumDec(Object.values(totals)).toFixed(2),
    notes,
    localImpeded: impeded,
  };
}

/**
 * RBT12 de início de atividade (Res. CGSN 140, art. 22): no 1º mês, RPA × 12;
 * do 2º ao 12º mês, média dos meses anteriores desde o início × 12; depois, a soma
 * dos 12 meses anteriores. `before` = receitas dos meses anteriores ao PA, do mais
 * antigo ao mais recente, a partir do mês de início (inclusive).
 */
export function rbt12For(before: string[], rpa: string): { rbt12: string; proportional: boolean } {
  const k = before.length;
  if (k === 0) return { rbt12: Dec.of(rpa).mul(12n).toFixed(2), proportional: true };
  const last = before.slice(-12).map((v) => Dec.of(v));
  // sem arredondar: a média pode ser dízima e só a exibição vai a centavos
  if (k < 12) return { rbt12: sumDec(last).div(BigInt(k)).mul(12n).toFixed(12), proportional: true };
  return { rbt12: sumDec(last).toFixed(2), proportional: false };
}

/**
 * Fator r (Res. CGSN 140/2018, art. 26): folha de salários dos 12 meses
 * anteriores ao PA (com encargos) ÷ RBT12. Proporcionalizar folha e receita no
 * início de atividade pelo mesmo número de meses não muda a razão, então basta
 * a soma dos meses anteriores desde o início. No 1º mês de atividade (sem meses
 * anteriores), folha do PA ÷ receita do PA. Sem folha: r adotado `withoutPayroll`;
 * com folha e sem receita: `withoutRevenue`.
 */
export function factorR(
  payroll: string,
  revenue: string,
  rule: { threshold: string; withoutPayroll: string; withoutRevenue: string },
): { r: string; annex: "III" | "V"; convention: "CALCULADO" | "SEM_FOLHA" | "SEM_RECEITA" } {
  const fs = Dec.of(payroll);
  const rb = Dec.of(revenue);
  let r: Dec;
  let convention: "CALCULADO" | "SEM_FOLHA" | "SEM_RECEITA" = "CALCULADO";
  if (fs.lte("0")) { r = Dec.pct(rule.withoutPayroll); convention = "SEM_FOLHA"; }
  else if (rb.lte("0")) { r = Dec.pct(rule.withoutRevenue); convention = "SEM_RECEITA"; }
  else r = fs.div(rb);
  return { r: r.mul(100n).toFixed(4), annex: r.cmp(Dec.pct(rule.threshold)) >= 0 ? "III" : "V", convention };
}
