import { describe, expect, it } from "vitest";
import { parsePgdasDeclarationText } from "../src/integrations/integra-contador/pgdas-pdf.js";
import { calculateSimples, rbt12For } from "../src/modules/tax/simples/engine.js";
import { AnnexDefinition, checkAnnex, ParamsDefinition } from "../src/modules/tax/simples/rules.js";
import { Dec } from "../src/shared/decimal.js";
import { appPool } from "./helpers.js";

/**
 * Valores esperados calculados por uma implementação independente (Python,
 * decimal de 40 dígitos) do mesmo modelo, que reproduziu centavo a centavo
 * 11 declarações reais (Anexo IV, faixas 1 a 6).
 */
async function defs() {
  const { rows } = await appPool.query<{ code: string; definition: unknown }>("SELECT code, definition FROM simples_rule WHERE version = 1");
  const by = Object.fromEntries(rows.map((r) => [r.code, r.definition]));
  return {
    IV: AnnexDefinition.parse(by.ANEXO_IV),
    I: AnnexDefinition.parse(by.ANEXO_I),
    params: ParamsDefinition.parse(by.PARAMETROS),
    all: rows.filter((r) => r.code.startsWith("ANEXO")).map((r) => AnnexDefinition.parse(r.definition)),
  };
}
const base = { rbaa: "0.00" };

describe("decimal exato", () => {
  it("soma, divide e arredonda meio para cima", () => {
    expect(Dec.of("0.1").add("0.2").toFixed(2)).toBe("0.30");
    expect(Dec.of("2.005").toFixed(2)).toBe("2.01");
    expect(Dec.of("-2.005").toFixed(2)).toBe("-2.01");
    expect(Dec.of("1").div("3").mul(3n).toFixed(10)).toBe("1.0000000000");
    expect(() => Dec.of(0.1)).toThrow();
  });
});

describe("motor do Simples Nacional", () => {
  it("tabelas propostas são coerentes (faixas crescentes, repartição soma 100%)", async () => {
    const d = await defs();
    expect(d.all).toHaveLength(5);
    for (const a of d.all) expect(checkAnnex(a)).toEqual([]);
  });

  it("início de atividade: RBT12 proporcional; sem receita anterior vale a alíquota nominal", async () => {
    const d = await defs();
    expect(rbt12For([], "1000.00")).toEqual({ rbt12: "12000.00", proportional: true });
    expect(Dec.of(rbt12For(["0.00", "70000.00"], "1.00").rbt12).toFixed(2)).toBe("420000.00");
    expect(rbt12For(Array(12).fill("1000.00"), "5.00")).toEqual({ rbt12: "12000.00", proportional: false });
    const r = calculateSimples({ ...base, annex: d.IV, params: d.params, rpa: [{ value: "50000.00" }], rbt12: rbt12For(Array(6).fill("0.00"), "50000.00").rbt12, rbaBefore: "0.00", monthsInYear: 9 });
    expect(r).toMatchObject({ ok: true, bracket: 1, effectiveRate: "4.500000", total: "2250.01" });
    expect(r.ok && r.taxes).toMatchObject({ IRPJ: "423.00", CSLL: "342.00", COFINS: "397.58", PIS: "86.18", ISS: "1001.25", CPP: "0.00" });
  });

  it("faixa 4 normal e faixa 5 com teto de 5% do ISS (diferença aos federais)", async () => {
    const d = await defs();
    const f4 = calculateSimples({ ...base, annex: d.IV, params: d.params, rpa: [{ value: "80000.00" }], rbt12: "1000000.00", rbaBefore: "100000.00" });
    expect(f4).toMatchObject({ ok: true, bracket: 4, effectiveRate: "10.022000", total: "8017.60" });
    expect(f4.ok && f4.taxes).toMatchObject({ IRPJ: "1427.13", CSLL: "1539.38", COFINS: "1515.33", PIS: "328.72", ISS: "3207.04" });
    const f5 = calculateSimples({ ...base, annex: d.IV, params: d.params, rpa: [{ value: "300000.00" }], rbt12: "2500000.00", rbaBefore: "900000.00" });
    expect(f5).toMatchObject({ ok: true, bracket: 5, effectiveRate: "14.648800", total: "43946.41" });
    expect(f5.ok && f5.taxes).toMatchObject({ IRPJ: "9069.79", CSLL: "9262.85", COFINS: "8722.43", PIS: "1891.34", ISS: "15000.00" });
    expect(f5.ok && f5.notes.join()).toMatch(/Teto/);
  });

  it("6ª faixa: mês em que a receita do ano passa o sublimite vira duas parcelas", async () => {
    const d = await defs();
    const r = calculateSimples({ ...base, annex: d.IV, params: d.params, rpa: [{ value: "400000.00" }], rbt12: "3900000.00", rbaBefore: "3450000.00" });
    expect(r).toMatchObject({ ok: true, bracket: 6, total: "74344.54" });
    if (!r.ok) throw new Error();
    expect(r.taxes).toMatchObject({ IRPJ: "27463.10", CSLL: "12447.17", COFINS: "11864.04", PIS: "2570.23", ISS: "20000.00" });
    expect(r.parcels.map((p) => [p.kind, p.base])).toEqual([["ATE_SUBLIMITE", "150000.00"], ["ACIMA_SUBLIMITE", "250000.00"]]);
  });

  it("Anexo I (ICMS, CPP) na 3ª faixa", async () => {
    const d = await defs();
    const r = calculateSimples({ ...base, annex: d.I, params: d.params, rpa: [{ value: "40000.00" }], rbt12: "500000.00", rbaBefore: "0.00" });
    expect(r).toMatchObject({ ok: true, bracket: 3, effectiveRate: "6.728000", total: "2691.20" });
    expect(r.ok && r.taxes).toMatchObject({ IRPJ: "148.02", CSLL: "94.19", COFINS: "342.86", PIS: "74.28", CPP: "1130.30", ICMS: "901.55", ISS: "0.00" });
  });

  it("ISS retido sai do DAS só na parcela retida", async () => {
    const d = await defs();
    const r = calculateSimples({ ...base, annex: d.IV, params: d.params, rpa: [{ value: "28000.00" }, { value: "2000.00", localWithheld: true }], rbt12: "269300.50", rbaBefore: "0.00" });
    expect(r).toMatchObject({ ok: true, total: "1749.73" });
    expect(r.ok && r.taxes.ISS).toBe("671.13");
  });

  it("o que o motor não cobre volta com o motivo, nunca com valor inventado", async () => {
    const d = await defs();
    const p = { ...base, annex: d.IV, params: d.params, rpa: [{ value: "1000.00" }] };
    expect(calculateSimples({ ...p, rbt12: "5000000.00", rbaBefore: "0.00" })).toMatchObject({ ok: false, reason: expect.stringMatching(/limite/) });
    expect(calculateSimples({ ...p, rbt12: "4000000.00", rbaBefore: "4400000.00" })).toMatchObject({ ok: false, reason: expect.stringMatching(/Impedido/) });
    expect(calculateSimples({ ...p, rbt12: "1000000.00", rbaBefore: "0.00", rbaa: "3700000.00" })).toMatchObject({ ok: false, reason: expect.stringMatching(/Impedido/) });
    expect(calculateSimples({ ...p, rbt12: "3000000.00", rbaBefore: "3600000.00" })).toMatchObject({ ok: false, reason: expect.stringMatching(/sublimite fora da 6ª/) });
  });
});

describe("leitura do débito declarado (seção 2.7 do PDF)", () => {
  it("atividade, anexo, retenção, receita e tributos; RBA, RBAA, sublimite e impedimento", () => {
    const text = [
      "Receita Bruta do PA (RPA) - Competência 10.000,00 0,00 10.000,00",
      "Receita bruta acumulada nos doze meses anteriores ao PA (RBT12) 120.000,00 0,00 120.000,00",
      "Receita bruta acumulada no ano-calendário corrente (RBA) 90.000,00 0,00 90.000,00",
      "Receita bruta acumulada no ano-calendário anterior (RBAA) 100.000,00 0,00 100.000,00",
      "2.7) Informações da Declaração por Estabelecimento CNPJ Estabelecimento: 00.000.000/0001-00",
      "Sublimite de Receita Anual (R$): 3.600.000,00 Impedido de recolher ICMS/ISS no DAS: Não",
      "Valor do Débito por Tributo para a Atividade (R$):",
      "Prestação de Serviços, exceto para o exterior - Sujeitos ao Anexo IV, sem",
      "retenção/substituição tributária de ISS, com ISS devido ao próprio Município do",
      "estabelecimento",
      "Receita Bruta Informada: R$ 8.000,00",
      "IRPJ CSLL COFINS PIS/Pasep INSS/CPP ICMS IPI ISS Total",
      "67,68 54,72 63,61 13,79 0,00 0,00 0,00 160,20 360,00",
      "Valor do Débito por Tributo para a Atividade (R$):",
      "Prestação de Serviços - Sujeitos ao Anexo III, com retenção/substituição tributária de ISS",
      "Receita Bruta Informada: R$ 2.000,00",
      "IRPJ CSLL COFINS PIS/Pasep INSS/CPP ICMS IPI ISS Total",
      "4,80 4,20 15,38 3,34 52,08 0,00 0,00 0,00 79,80",
    ].join("\n");
    const c = parsePgdasDeclarationText(text, "2026-08-01");
    expect(c).toMatchObject({ rba: "90000.00", rbaa: "100000.00", sublimit: "3600000.00", localImpeded: false });
    expect(c.activities).toHaveLength(2);
    expect(c.activities[0]).toMatchObject({ seq: 1, annex: "IV", localWithheld: false, factorR: false, revenue: "8000.00", total: "360.00", taxes: { IRPJ: "67.68", ISS: "160.20", CPP: "0.00" } });
    expect(c.activities[1]).toMatchObject({ seq: 2, annex: "III", localWithheld: true, revenue: "2000.00", total: "79.80", taxes: { CPP: "52.08", ISS: "0.00" } });
  });

  it("comércio e indústria: anexo pela atividade (revenda → I; industrializada pelo contribuinte → II) e ICMS-ST", () => {
    const text = [
      "Valor do Débito por Tributo para a Atividade (R$):",
      "Revenda de mercadorias, exceto para o exterior - Sem substituição tributária/tributação monofásica/antecipação com",
      "encerramento de tributação (o substituto tributário do ICMS deve utilizar essa opção)",
      "Receita Bruta Informada: R$ 277.055,63",
      "IRPJ CSLL COFINS PIS/Pasep INSS/CPP ICMS IPI ISS Total",
      "1.781,55 1.133,71 4.126,71 894,01 13.604,53 10.851,23 0,00 0,00 32.391,74",
      "Valor do Débito por Tributo para a Atividade (R$):",
      "Revenda de mercadorias, exceto para o exterior - Com substituição tributária/tributação monofásica/antecipação com",
      "encerramento de tributação (o substituído tributário do ICMS deve utilizar essa opção)",
      "Receita Bruta Informada: R$ 33.812,16",
      "IRPJ CSLL COFINS PIS/Pasep INSS/CPP ICMS IPI ISS Total",
      "217,42 138,36 503,63 109,11 1.660,31 0,00 0,00 0,00 2.628,83",
      "Valor do Débito por Tributo para a Atividade (R$):",
      "Venda de mercadorias industrializadas pelo contribuinte, exceto para o exterior - Sem substituição tributária",
      "Receita Bruta Informada: R$ 4.191,55",
      "IRPJ CSLL COFINS PIS/Pasep INSS/CPP ICMS IPI ISS Total",
      "28,00 17,82 58,59 12,68 190,90 162,90 38,18 0,00 509,07",
    ].join("\n");
    const c = parsePgdasDeclarationText(text, "2026-08-01");
    expect(c.activities.map((a) => [a.annex, a.localWithheld])).toEqual([["I", false], ["I", true], ["II", false]]);
  });
});
