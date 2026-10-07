import { z } from "zod";

/**
 * Tabelas do Simples Nacional (LC 123/2006, Anexos I a V, redação da LC 155/2016)
 * como regra versionada. Ficam em `simples_rule` e só valem para um escritório
 * depois da aprovação do responsável técnico. Percentuais em texto ("53.50"),
 * valores em reais com 2 casas.
 */
export const TAXES = ["IRPJ", "CSLL", "COFINS", "PIS", "CPP", "ICMS", "IPI", "ISS"] as const;
export type Tax = (typeof TAXES)[number];

const Pct = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/);
const Money = z.string().regex(/^\d+\.\d{2}$/);
const Shares = z.partialRecord(z.enum(TAXES), Pct);

export const Bracket = z.object({
  n: z.number().int().min(1).max(6),
  upTo: Money,
  /** alíquota nominal, em % */
  rate: Pct,
  deduction: Money,
  /** repartição da alíquota efetiva entre os tributos, em % (soma 100) */
  shares: Shares,
});

export const AnnexDefinition = z.object({
  kind: z.literal("ANEXO"),
  annex: z.enum(["I", "II", "III", "IV", "V"]),
  /** tributo local cobrado no DAS (ICMS ou ISS) */
  localTax: z.enum(["ICMS", "ISS"]),
  brackets: z.array(Bracket).length(6),
  /**
   * Teto do percentual efetivo do tributo local (ISS 5%): a diferença é
   * transferida aos tributos federais pelos percentuais da nota do Anexo.
   */
  localCap: z.object({ rate: Pct, transfer: Shares }).optional(),
});
export type AnnexDefinition = z.infer<typeof AnnexDefinition>;

export const ParamsDefinition = z.object({
  kind: z.literal("PARAMETROS"),
  /** limite de receita bruta anual do Simples */
  limit: Money,
  /** sublimite estadual/municipal para ICMS e ISS no DAS */
  sublimit: Money,
  /** tolerância de excesso no ano antes do impedimento (20%) */
  excessTolerance: Pct,
});
export type ParamsDefinition = z.infer<typeof ParamsDefinition>;

export const RuleDefinition = z.discriminatedUnion("kind", [AnnexDefinition, ParamsDefinition]);
export type RuleDefinition = z.infer<typeof RuleDefinition>;

/** Confere a coerência interna de um anexo (faixas crescentes, repartição soma 100). */
export function checkAnnex(def: AnnexDefinition): string[] {
  const errs: string[] = [];
  let prev = -1;
  for (const b of def.brackets) {
    if (Number(b.upTo) <= prev) errs.push(`faixa ${b.n}: limite não crescente`);
    prev = Number(b.upTo);
    const cents = Object.values(b.shares).reduce((a, v) => a + Math.round(Number(v) * 100), 0);
    if (cents !== 10000) errs.push(`faixa ${b.n}: repartição soma ${(cents / 100).toFixed(2)}%`);
  }
  if (def.localCap) {
    const cents = Object.values(def.localCap.transfer).reduce((a, v) => a + Math.round(Number(v) * 100), 0);
    if (cents !== 10000) errs.push(`transferência do teto soma ${(cents / 100).toFixed(2)}%`);
  }
  return errs;
}
