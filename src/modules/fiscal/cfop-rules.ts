import { Dec } from "../../shared/decimal.js";
import type { NfeHeader, NfeItem } from "../../integrations/sefaz/nfe-items.js";

/**
 * Regras determinísticas de CFOP, CST e créditos (sem IA). Versionadas: mudar
 * a regra é mudar a versão, e a releitura grava linhas novas (nada é sobrescrito).
 *
 * Conferências de cada item (do ponto de vista de quem emitiu a nota):
 *   CFOP_SENTIDO    tpNF 1 (saída) pede CFOP 5/6/7; tpNF 0 (entrada) pede 1/2/3
 *   CFOP_DESTINO    idDest 1 (interna) pede 5/1; 2 (interestadual) 6/2; 3 (exterior) 7/3
 *   CST_REGIME      emitente do Simples/MEI (CRT 1, 2, 4) usa CSOSN; regime normal (CRT 3) usa CST
 *   CFOP_ST_SEM_CST CFOP de mercadoria com ST (54xx/64xx) sem CST/CSOSN de ST
 *
 * CFOP de entrada (escrituração de quem recebeu): o CFOP do fornecedor vira o
 * de entrada pela destinação da compra na empresa (revenda, industrialização
 * ou uso e consumo), pela tabela de correspondência abaixo. Sem destinação
 * conhecida ou CFOP fora da tabela: fica sem proposta (nunca chutado).
 */

export const CFOP_RULES_VERSION = "cfop-1";
export const CREDIT_RULES_VERSION = "creditos-1";

export type Destination = "REVENDA" | "INDUSTRIALIZACAO" | "USO_CONSUMO";
export interface ItemCheck { code: string; text: string }

const ST_CST = new Set(["10", "30", "60", "70"]);
const ST_CSOSN = new Set(["201", "202", "203", "500"]);
/** CFOP de venda/remessa com substituição tributária do ICMS. */
const ST_CFOP = /^[56]40[1-5]$/;
const SIMPLES_CRT = new Set(["1", "2", "4"]);

export const hasSt = (i: Pick<NfeItem, "icmsCst" | "icmsCsosn" | "stValue" | "stRetained">) =>
  ST_CST.has(i.icmsCst ?? "") || ST_CSOSN.has(i.icmsCsosn ?? "") || Dec.of(i.stValue).gt("0") || Dec.of(i.stRetained).gt("0");
/** PIS monofásico na nota: CST 02 (alíquota diferenciada, fabricante/importador) ou 04 (revenda a alíquota zero). */
export const isMonophasic = (i: Pick<NfeItem, "pisCst">) => i.pisCst === "02" || i.pisCst === "04";

export function itemChecks(h: NfeHeader, i: NfeItem): ItemCheck[] {
  const out: ItemCheck[] = [];
  const c = i.cfop ?? "";
  const first = c.charAt(0);
  if (!/^\d{4}$/.test(c)) out.push({ code: "CFOP_INVALIDO", text: `CFOP "${c}" inválido` });
  else {
    if (h.nfType === "1" && !"567".includes(first)) out.push({ code: "CFOP_SENTIDO", text: `Nota de saída com CFOP de entrada (${c})` });
    if (h.nfType === "0" && !"123".includes(first)) out.push({ code: "CFOP_SENTIDO", text: `Nota de entrada com CFOP de saída (${c})` });
    const want = h.idDest === "1" ? "15" : h.idDest === "2" ? "26" : h.idDest === "3" ? "37" : null;
    if (want && !want.includes(first)) out.push({ code: "CFOP_DESTINO", text: `CFOP ${c} não corresponde ao destino da operação (${h.idDest === "1" ? "interna" : h.idDest === "2" ? "interestadual" : "exterior"})` });
    if (h.idDest === "1" && h.issuerUf && h.recipientUf && h.issuerUf !== h.recipientUf) out.push({ code: "CFOP_DESTINO", text: `Operação marcada como interna, mas UF do emitente ${h.issuerUf} e do destinatário ${h.recipientUf}` });
  }
  if (h.issuerCrt && SIMPLES_CRT.has(h.issuerCrt) && !i.icmsCsosn) out.push({ code: "CST_REGIME", text: "Emitente do Simples Nacional sem CSOSN no item" });
  if (h.issuerCrt === "3" && !i.icmsCst) out.push({ code: "CST_REGIME", text: "Emitente do regime normal sem CST de ICMS no item" });
  if (ST_CFOP.test(c) && !hasSt(i)) out.push({ code: "CFOP_ST_SEM_CST", text: `CFOP ${c} (com ST) sem CST/CSOSN de substituição tributária` });
  return out;
}

/** Correspondência CFOP do fornecedor (venda) → CFOP de entrada, por destinação. */
const NORMAL_SALE = /^[56](10[1-9]|11[0-9]|12[0-4])$/;
const ST_SALE = /^[56]40[1-5]$/;
const FIXED: Record<string, string> = {
  "910": "910", "911": "911", "915": "915", "916": "916", "920": "920", "921": "921", "949": "949", "901": "901", "902": "902",
  "201": "201", "202": "202", "411": "411", "410": "410", "152": "152", "151": "151", "409": "409", "408": "408",
};

/** CFOP de entrada proposto (nulo = sem regra ou sem destinação conhecida). */
export function entryCfop(supplierCfop: string | null, dest: Destination | null): { cfop: string | null; why: string } {
  const c = supplierCfop ?? "";
  if (!/^[567]\d{3}$/.test(c)) return { cfop: null, why: "CFOP do fornecedor não é de saída" };
  const prefix = c[0] === "5" ? "1" : c[0] === "6" ? "2" : "3";
  const tail = c.slice(1);
  if (FIXED[tail]) return { cfop: prefix + FIXED[tail], why: "correspondência direta" };
  if (!dest) return { cfop: null, why: "destinação da compra desconhecida (revenda, industrialização ou uso e consumo)" };
  if (ST_SALE.test(c)) return { cfop: prefix + (dest === "REVENDA" ? "403" : dest === "INDUSTRIALIZACAO" ? "401" : "407"), why: "compra com ST" };
  if (NORMAL_SALE.test(c)) return { cfop: prefix + (dest === "REVENDA" ? "102" : dest === "INDUSTRIALIZACAO" ? "101" : "556"), why: "compra sem ST" };
  return { cfop: null, why: `CFOP ${c} sem correspondência na tabela` };
}

// ------------------------------------------------------------------ créditos

export type CreditTax = "ICMS" | "IPI" | "PIS" | "COFINS";
export interface CreditDecision {
  tax: CreditTax;
  status: "APROPRIAVEL" | "NAO_SE_APLICA" | "A_CONFERIR";
  base: string | null;
  rate: string | null;
  value: string;
  reason: string;
}

const ICMS_CREDIT_CFOP = /^[123](10[12]|12[2-4]|65[13]|35[2-6])$/;
const ASSET_CFOP = /^[123]55[01]$/;
const USE_CFOP = /^[123](556|407)$/;

/**
 * Crédito de cada tributo na entrada, pelo regime da empresa na data da nota.
 * Simples/MEI: não apropria crédito (LC 123/2006, art. 23). Presumido: PIS e
 * COFINS cumulativos (sem crédito). Real: PIS/COFINS não cumulativos sobre
 * revenda e insumo, exceto monofásico e ST de PIS/COFINS na revenda.
 */
export function credits(regime: string | null, i: NfeItem, entry: string | null): CreditDecision[] {
  const none = (tax: CreditTax, reason: string): CreditDecision => ({ tax, status: "NAO_SE_APLICA", base: null, rate: null, value: "0.00", reason });
  const all = (reason: string) => (["ICMS", "IPI", "PIS", "COFINS"] as CreditTax[]).map((t) => none(t, reason));
  if (!regime) return (["ICMS", "IPI", "PIS", "COFINS"] as CreditTax[]).map((tax) => ({ tax, status: "A_CONFERIR", base: null, rate: null, value: "0.00", reason: "Regime da empresa na data da nota não cadastrado" }));
  if (regime === "SIMPLES_NACIONAL" || regime === "MEI") return all("Optante do Simples Nacional não apropria crédito de ICMS, IPI, PIS e COFINS (LC 123/2006, art. 23)");
  if (regime === "IMUNE" || regime === "ISENTA") return all("Entidade imune/isenta: sem apuração não cumulativa");
  const out: CreditDecision[] = [];
  // ICMS (regime normal do imposto)
  if (!entry) out.push({ tax: "ICMS", status: "A_CONFERIR", base: null, rate: null, value: "0.00", reason: "Sem CFOP de entrada: falta a destinação da compra" });
  else if (USE_CFOP.test(entry)) out.push(none("ICMS", "Uso e consumo: sem crédito até 2033 (LC 87/1996, art. 33, I)"));
  else if (ASSET_CFOP.test(entry)) out.push({ tax: "ICMS", status: "APROPRIAVEL", base: i.icmsBase, rate: i.icmsRate, value: Dec.of(i.icmsValue).add(i.snCreditValue).toFixed(2), reason: "Ativo imobilizado: crédito em 48 parcelas no CIAP (LC 87/1996, art. 20, § 5º)" });
  else if (hasSt(i)) out.push(none("ICMS", "Mercadoria com ICMS-ST: imposto já encerrado, sem crédito"));
  else if (ICMS_CREDIT_CFOP.test(entry)) {
    const v = Dec.of(i.icmsValue).add(i.snCreditValue);
    out.push(v.gt("0")
      ? { tax: "ICMS", status: "APROPRIAVEL", base: Dec.of(i.icmsValue).gt("0") ? i.icmsBase : null, rate: i.icmsRate ?? i.snCreditRate, value: v.toFixed(2), reason: Dec.of(i.snCreditValue).gt("0") ? "Crédito informado pelo fornecedor do Simples (LC 123/2006, art. 23, § 1º)" : "ICMS destacado na nota (LC 87/1996, art. 20)" }
      : none("ICMS", "Nota sem ICMS destacado nem crédito do Simples"));
  } else out.push({ tax: "ICMS", status: "A_CONFERIR", base: null, rate: null, value: "0.00", reason: `CFOP de entrada ${entry}: crédito a conferir` });
  // IPI: só na industrialização
  if (entry && /^[123]101$/.test(entry) && Dec.of(i.ipiValue).gt("0")) out.push({ tax: "IPI", status: "APROPRIAVEL", base: null, rate: null, value: i.ipiValue, reason: "Insumo para industrialização com IPI destacado (RIPI, art. 226)" });
  else out.push(none("IPI", Dec.of(i.ipiValue).gt("0") ? "IPI só gera crédito para estabelecimento industrial na compra de insumo" : "Sem IPI destacado"));
  // PIS/COFINS
  if (regime === "LUCRO_PRESUMIDO" || regime === "LUCRO_ARBITRADO") {
    out.push(none("PIS", "Lucro Presumido: PIS cumulativo, sem crédito (Lei 9.718/1998)"), none("COFINS", "Lucro Presumido: COFINS cumulativa, sem crédito (Lei 9.718/1998)"));
  } else if (!entry || !/^[123](10[12]|40[13]|12[2-4])$/.test(entry)) {
    out.push(none("PIS", "Lucro Real: crédito só sobre revenda e insumo (Leis 10.637/2002 e 10.833/2003, art. 3º)"), none("COFINS", "Lucro Real: crédito só sobre revenda e insumo (Leis 10.637/2002 e 10.833/2003, art. 3º)"));
  } else if (isMonophasic(i) && /^[123](102|403)$/.test(entry)) {
    out.push(none("PIS", "Revenda de produto monofásico: crédito vedado (Lei 10.637/2002, art. 3º, I, b)"), none("COFINS", "Revenda de produto monofásico: crédito vedado (Lei 10.833/2003, art. 3º, I, b)"));
  } else {
    const base = Dec.of(i.total).sub(i.discount).add(i.freight).add(i.other).add(i.ipiValue);
    out.push(
      { tax: "PIS", status: "APROPRIAVEL", base: base.toFixed(2), rate: "1.6500", value: base.mul("0.0165").round(2).toFixed(2), reason: "Não cumulativo: 1,65% sobre o custo de aquisição (Lei 10.637/2002, art. 3º)" },
      { tax: "COFINS", status: "APROPRIAVEL", base: base.toFixed(2), rate: "7.6000", value: base.mul("0.076").round(2).toFixed(2), reason: "Não cumulativa: 7,6% sobre o custo de aquisição (Lei 10.833/2003, art. 3º)" },
    );
  }
  return out;
}
