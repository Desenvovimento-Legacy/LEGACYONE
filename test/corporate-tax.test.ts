import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readEntityNfseTaxes } from "../src/modules/fiscal/withholdings.js";
import { applyStandardChart, postEntry } from "../src/modules/ledger/ledger.js";
import {
  addCreditEntry, addLalurEntry, addLalurOpening, approveCorporateRules, corporateOverview, CorporateTaxError, defineCorporateRegime, definePresumption,
  refreshCorporate, setCorporateOption,
} from "../src/modules/tax/corporate/corporate.js";
import { irpjDue, lc224Limits, presumedBase, quotasFor, realProfit, splitCsrf } from "../src/modules/tax/corporate/engine.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const LUAN: Actor = { kind: "USER", id: "luan@legacy.test" };
const TOMADOR = "60611420000136";
const tag = (n: string, v: string | undefined) => (v === undefined ? "" : `<${n}>${v}</${n}>`);
/** NFS-e prestada pela empresa; retenção código 3 (vRetCSLL = PIS + COFINS + CSLL). */
const issued = (serv: string, day: string, ret?: { irrf: string; csrf: string; pis: string; cofins: string }) =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS1"><nNFSe>1</nNFSe><emit><CNPJ>${CNPJ_MATRIZ}</CNPJ><xNome>NOS</xNome></emit>` +
  `<valores>${ret ? tag("vTotalRet", (Number(ret.irrf) + Number(ret.csrf)).toFixed(2)) : ""}<vLiq>0.00</vLiq></valores>` +
  `<DPS versao="1.01"><infDPS Id="DPS1"><dhEmi>${day}T10:00:00-03:00</dhEmi><dCompet>${day}</dCompet>` +
  `<prest><CNPJ>${CNPJ_MATRIZ}</CNPJ><regTrib><opSimpNac>1</opSimpNac></regTrib></prest><toma><CNPJ>${TOMADOR}</CNPJ></toma>` +
  `<serv><cServ><cTribNac>010501</cTribNac></cServ></serv><valores><vServPrest><vServ>${serv}</vServ></vServPrest><trib><tribMun><tpRetISSQN>1</tpRetISSQN></tribMun>` +
  `<tribFed>${ret ? `<piscofins><CST>01</CST>${tag("vPis", ret.pis)}${tag("vCofins", ret.cofins)}<tpRetPisCofins>3</tpRetPisCofins></piscofins>${tag("vRetIRRF", ret.irrf)}${tag("vRetCSLL", ret.csrf)}` : ""}</tribFed>` +
  `</trib></valores></infDPS></DPS></infNFSe></NFSe>`;

let nsu = 0;
async function putIssued(t: string, entityId: string, serv: string, day: string, ret?: Parameters<typeof issued>[2]) {
  const xml = issued(serv, day, ret);
  const k = ++nsu;
  await withTenant(appPool, t, (tx) =>
    tx.query(
      `INSERT INTO nfse_document (id, tenant_id, entity_id, nsu, access_key, role, number, issued_at, provider_doc, provider_name, taker_doc, taker_name, service_value, xml, sha256)
       VALUES ($1, current_tenant(), $2, $3, $4, 'PRESTADA', $5, $6, $7, 'NOS', $8, 'CLIENTE', $9, $10, $11)`,
      [newId(), entityId, k, `CK${k}${newId().slice(0, 6)}`, String(k), `${day}T10:00:00-03:00`, CNPJ_MATRIZ, TOMADOR, serv, xml, createHash("sha256").update(xml + k).digest()],
    ),
  );
}

describe("motor dos tributos do lucro", () => {
  it("presunção com a LC 224 (exemplo da IN 2.306), adicional, quotas, trava de 30% e partilha do CSRF", () => {
    const groups = { SERVICOS_GERAIS: { label: "Serviços", irpj: "32.00", csll: "32.00" }, COMERCIO_INDUSTRIA: { label: "Comércio", irpj: "8.00", csll: "12.00" } };
    // 1.500.000 de serviços no trimestre, limite 1.250.000: 400.000 + 250.000 × 35,2% = 488.000
    expect(presumedBase({ revenue: { SERVICOS_GERAIS: "1500000.00" }, groups, tax: "IRPJ", lc224: { increase: "10.00", limit: "1250000.00" } }))
      .toMatchObject({ base: "488000.00", excess: "250000.00" });
    // atividades diversificadas: excedente repartido pela receita (1/3 comércio, 2/3 serviços)
    const d = presumedBase({ revenue: { SERVICOS_GERAIS: "1000000.00", COMERCIO_INDUSTRIA: "500000.00" }, groups, tax: "IRPJ", lc224: { increase: "10.00", limit: "1200000.00" } });
    // serviços: 800.000 × 32% + 200.000 × 35,2% = 326.400; comércio: 400.000 × 8% + 100.000 × 8,8% = 40.800
    expect(d.base).toBe("367200.00");
    expect(presumedBase({ revenue: { SERVICOS_GERAIS: "100000.00" }, groups, tax: "CSLL", lc224: null }).base).toBe("32000.00");
    // sobra do limite passa para o trimestre seguinte
    expect(lc224Limits({ 1: "1000000.00", 2: "1600000.00", 3: "2000000.00" }, "1250000.00")).toEqual({ 1: "1250000.00", 2: "1500000.00", 3: "1250000.00", 4: "1250000.00" });
    const rates = { irpj: "15.00", additional: "10.00", additionalMonthly: "20000.00", csll: "9.00" };
    expect(irpjDue("99200.00", 3, rates)).toEqual({ normal: "14880.00", additional: "3920.00", total: "18800.00", threshold: "60000.00" });
    expect(irpjDue("50000.00", 3, rates).additional).toBe("0.00");
    expect(quotasFor("18650.00", "TRES", "1000.00", "2000.00")).toEqual(["6216.67", "6216.67", "6216.66"]);
    expect(quotasFor("2500.00", "TRES", "1000.00", "2000.00")).toEqual(["1250.00", "1250.00"]);
    expect(quotasFor("1900.00", "TRES", "1000.00", "2000.00")).toEqual(["1900.00"]);
    expect(realProfit({ result: "70000.00", additions: "5000.00", exclusions: "0.00", lossBalance: "50000.00", limitPct: "30.00" }))
      .toEqual({ adjusted: "75000.00", compensated: "22500.00", taxable: "52500.00", newLoss: "0.00", lossAfter: "27500.00" });
    expect(realProfit({ result: "-10000.00", additions: "0.00", exclusions: "0.00", lossBalance: "1000.00", limitPct: "30.00" }))
      .toMatchObject({ taxable: "0.00", newLoss: "10000.00", lossAfter: "11000.00" });
    expect(splitCsrf("465.00")).toEqual({ csll: "100.00", pis: "65.00", cofins: "300.00" });
  });

  it("Lucro Presumido: regras aprovadas, regime e presunção por pessoa, PIS/COFINS mensais e IRPJ/CSLL trimestral com retenções e quotas", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    await expect(defineCorporateRegime(appPool, t, { entityId, regime: "LUCRO_PRESUMIDO", validFrom: "2026-01-01" }, { kind: "AGENT", id: "x" })).rejects.toThrow(CorporateTaxError);
    await defineCorporateRegime(appPool, t, { entityId, regime: "LUCRO_PRESUMIDO", validFrom: "2026-01-01" }, LUAN);
    await putIssued(t, entityId, "100000.00", "2026-01-10");
    await putIssued(t, entityId, "100000.00", "2026-02-10");
    await putIssued(t, entityId, "100000.00", "2026-03-10");
    await putIssued(t, entityId, "10000.00", "2026-03-20", { irrf: "150.00", csrf: "465.00", pis: "65.00", cofins: "300.00" });
    await readEntityNfseTaxes(appPool, t, entityId);

    // sem regras aprovadas: nada calculado
    await refreshCorporate(appPool, t, entityId, "2026-04-15");
    let ov = await withTenant(appPool, t, (tx) => corporateOverview(tx, entityId, "2026-04-15"));
    expect(ov.rows.every((r) => r.status === "REGRA_PENDENTE")).toBe(true);
    expect(ov.rulesPending).toContain("PRESUNCAO_LC224");

    await approveCorporateRules(appPool, t, LUAN);
    await refreshCorporate(appPool, t, entityId, "2026-04-15");
    ov = await withTenant(appPool, t, (tx) => corporateOverview(tx, entityId, "2026-04-15"));
    const q1 = (tax: string) => ov.rows.find((r) => r.period_kind === "TRIMESTRAL" && r.period_start === "2026-01-01" && r.tax === tax)!;
    expect(q1("IRPJ")).toMatchObject({ status: "BLOQUEADO", blockers: [expect.stringMatching(/Confirmar a atividade dos serviços/)] });
    // PIS/COFINS não dependem da presunção
    const pis = (m: string) => ov.rows.find((r) => r.period_kind === "MENSAL" && r.period_start === m && r.tax === "PIS")!;
    const cof = (m: string) => ov.rows.find((r) => r.period_kind === "MENSAL" && r.period_start === m && r.tax === "COFINS")!;
    expect(pis("2026-01-01")).toMatchObject({ status: "CALCULADO", base: "100000.00", amount: "650.00", darf_code: "8109", due_on: "2026-02-25" });
    expect(cof("2026-03-01")).toMatchObject({ base: "110000.00", gross: "3300.00", amount: "3000.00", darf_code: "2172" });
    expect(pis("2026-03-01").amount).toBe("650.00");

    await expect(definePresumption(appPool, t, { entityId, scope: "NFSE", group: "XYZ", validFrom: "2026-01-01", reason: "teste" }, LUAN)).rejects.toThrow(/desconhecido/);
    await definePresumption(appPool, t, { entityId, scope: "NFSE", group: "SERVICOS_GERAIS", validFrom: "2026-01-01", reason: "Licenciamento de software (LC 116, item 1.05)" }, LUAN);
    await setCorporateOption(appPool, t, { entityId, year: 2026, quotas: "TRES", revenueBasis: "COMPETENCIA" }, LUAN);
    expect((await refreshCorporate(appPool, t, entityId, "2026-04-15")).changed).toBeGreaterThan(0);
    ov = await withTenant(appPool, t, (tx) => corporateOverview(tx, entityId, "2026-04-15"));
    // 310.000 × 32% = 99.200; IRPJ 14.880 + adicional 3.920 − IRRF 150 = 18.650 em 3 quotas
    expect(q1("IRPJ")).toMatchObject({ status: "CALCULADO", base: "99200.00", gross: "18800.00", deductions: "150.00", amount: "18650.00", darf_code: "2089", due_on: "2026-04-30", payment: "A_VENCER" });
    expect(q1("IRPJ").quotas).toEqual([{ n: 1, amount: "6216.67", due: "2026-04-30" }, { n: 2, amount: "6216.67", due: "2026-05-29" }, { n: 3, amount: "6216.66", due: "2026-06-30" }]);
    // CSLL: 99.200 × 9% = 8.928 − 100 retida
    expect(q1("CSLL")).toMatchObject({ amount: "8828.00", darf_code: "2372" });
    // nada muda: nenhuma fotografia nova
    expect((await refreshCorporate(appPool, t, entityId, "2026-04-15")).changed).toBe(0);
    // vencido sem pagamento: "ainda não identificado"
    ov = await withTenant(appPool, t, (tx) => corporateOverview(tx, entityId, "2026-05-05"));
    expect(q1("IRPJ").payment).toBe("PAGAMENTO_NAO_IDENTIFICADO");
    await withTenant(appPool, t, async (tx) => {
      expect((await tx.query("SELECT 1 FROM outbox WHERE type = 'CORPORATE_TAX_CALCULATED' AND entity_id = $1", [entityId])).rowCount).toBeGreaterThan(0);
      expect((await tx.query("SELECT 1 FROM audit_log WHERE action = 'tax.presumption_defined' AND entity_id = $1", [entityId])).rowCount).toBe(1);
    });
  });

  it("Lucro Real trimestral: resultado do razão + e-LALUR, compensação com trava, PIS/COFINS não cumulativos com crédito", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    await approveCorporateRules(appPool, t, LUAN);
    await defineCorporateRegime(appPool, t, { entityId, regime: "LUCRO_REAL_TRIMESTRAL", validFrom: "2026-01-01" }, LUAN);
    await applyStandardChart(appPool, t, entityId, "2026-01-01", LUAN);
    await putIssued(t, entityId, "100000.00", "2026-01-15");
    await readEntityNfseTaxes(appPool, t, entityId);
    const ENG: Actor = { kind: "AGENT", id: "ledger" };
    await withTenant(appPool, t, async (tx) => {
      await postEntry(tx, { entityId, date: "2026-01-15", history: "Receita", origin: "FISCAL", rule: "teste@1", idempotencyKey: "r1", evidence: [{ kind: "x", id: "1" }],
        lines: [{ account: "1.1.2.01", debit: "100000.00" }, { account: "3.1.1.01", credit: "100000.00" }] }, ENG);
      await postEntry(tx, { entityId, date: "2026-02-10", history: "Energia", origin: "FISCAL", rule: "teste@1", idempotencyKey: "r2", evidence: [{ kind: "x", id: "2" }],
        lines: [{ account: "4.3.1.02", debit: "30000.00" }, { account: "2.1.1.01", credit: "30000.00" }] }, ENG);
    });
    await addLalurEntry(appPool, t, { entityId, periodStart: "2026-01-01", periodEnd: "2026-03-31", tax: "AMBOS", kind: "ADICAO", description: "Multas indedutíveis",
      amount: "5000.00", legalBasis: "RIR/2018, art. 311" }, LUAN);
    await addLalurOpening(appPool, t, { entityId, kind: "PREJUIZO_FISCAL", amount: "50000.00", asOf: "2025-12-31", evidence: "ECF 2025, M410" }, LUAN);
    await addCreditEntry(appPool, t, { entityId, competence: "2026-02-01", kind: "ENERGIA", base: "10000.00", description: "Energia da fábrica", legalBasis: "Lei 10.833/2003, art. 3º, III" }, LUAN);

    await refreshCorporate(appPool, t, entityId, "2026-04-15");
    const ov = await withTenant(appPool, t, (tx) => corporateOverview(tx, entityId, "2026-04-15"));
    const q = (tax: string) => ov.rows.find((r) => r.period_kind === "TRIMESTRAL" && r.tax === tax)!;
    // 70.000 + 5.000 = 75.000; compensa 22.500 (30%); lucro real 52.500 × 15% = 7.875 (sem adicional)
    expect(q("IRPJ")).toMatchObject({ status: "CALCULADO", base: "52500.00", amount: "7875.00", darf_code: "3373" });
    // CSLL: sem base negativa, 75.000 × 9%
    expect(q("CSLL")).toMatchObject({ base: "75000.00", amount: "6750.00" });
    const m = (month: string, tax: string) => ov.rows.find((r) => r.period_kind === "MENSAL" && r.period_start === month && r.tax === tax)!;
    expect(m("2026-01-01", "PIS")).toMatchObject({ amount: "1650.00", darf_code: "6912" });
    expect(m("2026-01-01", "COFINS")).toMatchObject({ amount: "7600.00", darf_code: "5856" });
    // fevereiro sem receita: crédito da energia vira saldo credor e abate março (sem receita também)
    expect(m("2026-02-01", "PIS")).toMatchObject({ amount: "0.00" });
    expect((m("2026-02-01", "PIS").details as { lines: string[] }).lines.join(" ")).toMatch(/Saldo credor para o mês seguinte: 165,00/);
    expect((m("2026-03-01", "COFINS").details as { lines: string[] }).lines.join(" ")).toMatch(/saldo credor anterior 760,00/);
  });
});

describe("regime pela evidência da Receita", () => {
  it("DARF pagos decidem o ano; ECF dos dados abertos cobre o resto; anos seguidos viram uma vigência", async () => {
    const { decideYears, spansFrom, detectTaxRegime } = await import("../src/modules/registry/regime-detect.js");
    const ys = decideYears({
      publicYears: [{ year: 2024, regime: "LUCRO PRESUMIDO" }],
      paymentCodes: [{ year: 2025, code: "2089" }, { year: 2025, code: "2372" }, { year: 2026, code: "8109" }, { year: 2026, code: "2172" }],
      currentYear: 2026,
    });
    expect(ys.map((y) => [y.year, y.regime])).toEqual([[2024, "LUCRO_PRESUMIDO"], [2025, "LUCRO_PRESUMIDO"], [2026, "LUCRO_PRESUMIDO"]]);
    expect(spansFrom(ys, 2026)).toMatchObject([{ regime: "LUCRO_PRESUMIDO", validFrom: "2024-01-01", validTo: null }]);
    // conflito entre ECF e DARF: não decide
    expect(decideYears({ publicYears: [{ year: 2025, regime: "LUCRO PRESUMIDO" }], paymentCodes: [{ year: 2025, code: "3373" }], currentYear: 2026 })[0]!.regime).toBeNull();
    // ECF diz Lucro Real; DARF de estimativa em outro ano mostra que é anual
    expect(decideYears({ publicYears: [{ year: 2024, regime: "LUCRO REAL" }], paymentCodes: [{ year: 2025, code: "5993" }], currentYear: 2026 }).map((y) => y.regime))
      .toEqual(["LUCRO_REAL_ANUAL", "LUCRO_REAL_ANUAL"]);
    // ano sem evidência interrompe; o corrente sem evidência não fica em aberto
    expect(spansFrom(decideYears({ publicYears: [{ year: 2023, regime: "LUCRO PRESUMIDO" }], paymentCodes: [], currentYear: 2026 }), 2026))
      .toMatchObject([{ validFrom: "2023-01-01", validTo: "2023-12-31" }]);

    // no banco: snapshot público + pagamento → regime registrado pelo agente, pendência resolvida, presunção sugerida pela CNAE
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    await withTenant(appPool, t, async (tx) => {
      const payload = { cnpj: CNPJ_MATRIZ, razao_social: "X", descricao_situacao_cadastral: "ATIVA", codigo_natureza_juridica: 2062, natureza_juridica: "LTDA",
        identificador_matriz_filial: 1, uf: "PR", municipio: "PINHAIS", codigo_municipio_ibge: 4119152, cnae_fiscal: 6203100, regime_tributario: [{ ano: 2025, forma_de_tributacao: "LUCRO PRESUMIDO" }] };
      const snap = newId();
      await tx.query("INSERT INTO external_snapshot (id, tenant_id, entity_id, source, request_key, fetched_at, sha256, payload) VALUES ($1, current_tenant(), $2, 'brasilapi-cnpj', $3, now(), $4, $5)",
        [snap, entityId, `cnpj:${CNPJ_MATRIZ}`, createHash("sha256").update("p").digest(), JSON.stringify(payload)]);
      await tx.query(
        `INSERT INTO federal_payment (id, tenant_id, entity_id, document_number, competence, collected_on, revenue_code, amount_total, breakdown, source, snapshot_id)
         VALUES ($1, current_tenant(), $2, 'D1', '2026-03-01', '2026-04-30', '2089', 100, '[{"revenueCode":"2089","total":"100.00","principal":"100.00"}]', 'teste', $3)`,
        [newId(), entityId, snap],
      );
      await tx.query(
        `INSERT INTO pending_item (id, tenant_id, entity_id, type, responsible_source, required_information, impact, status)
         VALUES ($1, current_tenant(), $2, 'TAX_REGIME_UNKNOWN', 'OFFICE', 'Informar o regime', 'x', 'OPEN')`,
        [newId(), entityId],
      );
      const est = newId();
      await tx.query("INSERT INTO establishment (id, tenant_id, entity_id, kind, cnpj, uf, municipio_ibge, opened_at) VALUES ($1, current_tenant(), $2, 'MATRIZ', $3, 'PR', '4119152', '2020-01-01')", [est, entityId, CNPJ_MATRIZ]);
      await tx.query("INSERT INTO activity_history (id, tenant_id, establishment_id, cnae, is_primary, valid_from, source) VALUES ($1, current_tenant(), $2, '6203100', true, '2020-01-01', 'teste')", [newId(), est]);
    });
    expect(await detectTaxRegime(appPool, t, entityId, "2026-10-13")).toMatchObject({ added: 1, resolved: 1 });
    await withTenant(appPool, t, async (tx) => {
      const r = await tx.query("SELECT regime, valid_from::text, valid_to FROM tax_regime_history WHERE entity_id = $1", [entityId]);
      expect(r.rows).toEqual([{ regime: "LUCRO_PRESUMIDO", valid_from: "2025-01-01", valid_to: null }]);
    });
    // de novo: nada muda (nunca sobrescreve)
    expect(await detectTaxRegime(appPool, t, entityId, "2026-10-13")).toMatchObject({ added: 0 });
    await putIssued(t, entityId, "1000.00", "2026-01-10");
    await approveCorporateRules(appPool, t, LUAN);
    await refreshCorporate(appPool, t, entityId, "2026-04-15");
    await withTenant(appPool, t, async (tx) => {
      const p = await tx.query("SELECT scope, grp, set_by FROM entity_presumption WHERE entity_id = $1", [entityId]);
      expect(p.rows).toEqual([{ scope: "NFSE", grp: "SERVICOS_GERAIS", set_by: "agente:tax" }]);
    });
  });
});
