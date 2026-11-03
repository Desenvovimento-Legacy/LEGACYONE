import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FakeIntegraContador } from "../src/integrations/integra-contador/fake.js";
import { parsePgdasDeclarationText } from "../src/integrations/integra-contador/pgdas-pdf.js";
import { fetchLastDeclaration } from "../src/modules/federal/declared-revenue.js";
import { LINKS } from "../src/modules/orchestration/links.js";
import { approveSimplesRules, payrollMonths, refreshSimples, simplesOverview } from "../src/modules/tax/simples/apuracao.js";
import { informPayroll, moneyInput } from "../src/modules/tax/simples/payroll.js";
import { runOrchestrator } from "../src/platform/orchestrator/orchestrator.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const OFFICE = "11222333000181";
const PDF = readFileSync("test/fixtures/pgdas-declaracao-ficticia.pdf");
const LUAN: Actor = { kind: "USER", id: "luan" };
const NOW = new Date("2026-10-07T12:00:00Z");

describe("leitura da folha de salários do PGDAS-D (seção 2.3)", () => {
  it("lê os meses da folha até a próxima seção e a folha do PA quando informada", () => {
    const text = [
      "Período de Apuração (PA): 08/2026",
      "2.2.1) Mercado Interno 07/2026 10.000,00",
      "2.3) Folha de Salários Anteriores (R$)",
      "08/2025 5.000,00 09/2025 5.100,00 10/2025 0,00",
      "2.4) Fator r",
      "07/2026 99.999,99",
      "Folha de Salários do PA (R$): 6.200,00",
    ].join("\n");
    const c = parsePgdasDeclarationText(text);
    expect(c.payroll).toEqual([
      { competence: "2025-08-01", total: "5000.00" },
      { competence: "2025-09-01", total: "5100.00" },
      { competence: "2025-10-01", total: "0.00" },
    ]);
    expect(c.payrollPa).toBe("6200.00");
    expect(c.months.map((m) => m.competence)).toEqual(["2026-07-01"]);
    expect(parsePgdasDeclarationText("2.1) Discriminativo de Receitas").payroll).toEqual([]);
  });
});

describe("valor da folha digitado", () => {
  it("aceita o padrão brasileiro e o ponto decimal, recusa o ambíguo", () => {
    expect(moneyInput("12.345,67")).toBe("12345.67");
    expect(moneyInput("7.000")).toBe("7000");
    expect(moneyInput("7000,5")).toBe("7000.5");
    expect(moneyInput("7000.00")).toBe("7000.00");
    expect(moneyInput("0,00")).toBe("0.00");
    expect(moneyInput("1.2.3")).toBe(null);
    expect(moneyInput("-5")).toBe(null);
  });
});

describe("fator r na apuração do Simples", () => {
  it("anexo III ou V pela folha ÷ receita dos 12 meses anteriores; mês sem folha não calcula", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    await withTenant(appPool, t, async (tx) => {
      await tx.query(
        `INSERT INTO power_of_attorney (id, tenant_id, entity_id, system, grantee_document, scopes, valid_from, valid_to, source, verified_at)
         VALUES ($1, current_tenant(), $2, 'ECAC', $3, '{TODOS}', '2025-01-01', '2030-12-31', 'teste', now())`,
        [newId(), entityId, OFFICE],
      );
    });
    const integra = new FakeIntegraContador(OFFICE, {}, { [CNPJ_MATRIZ]: { lastDeclarations: { "202608": { number: "12345678901234567", pdf: PDF } } } });
    await fetchLastDeclaration({ appPool, integra, metering: { provider: "serpro", dailyLimit: 20 } }, t, { entityId, competence: "2026-08-01" });

    // a folha da seção 2.3 do PDF entra como declarada
    let payroll = await withTenant(appPool, t, (tx) => payrollMonths(tx, entityId));
    expect(payroll.get("2025-08-01")).toEqual({ total: "5000.00", source: "DECLARADA" });

    await withTenant(appPool, t, async (tx) => {
      // atividade sujeita ao fator r, sem anexo no texto (como vem no PGDAS-D)
      const pdf = await tx.query<{ id: string }>("SELECT id FROM pgdas_declaration_pdf WHERE entity_id = $1", [entityId]);
      await tx.query(
        `INSERT INTO pgdas_declared_tax (id, tenant_id, entity_id, competence, declaration_number, pdf_id, seq, activity, annex, local_withheld, factor_r,
                                         revenue, irpj, csll, cofins, pis, cpp, icms, ipi, iss, total, local_impeded, parser)
         VALUES ($1, current_tenant(), $2, '2026-08-01', '12345678901234567', $3, 1,
                 'Prestação de Serviços - Sujeitos ao fator r, sem retenção/substituição tributária de ISS', NULL, false, true,
                 25300.50, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, 'pgdas-pdf-3')`,
        [newId(), entityId, pdf.rows[0]!.id],
      );
    });
    await approveSimplesRules(appPool, t, LUAN);
    await runOrchestrator(appPool, t, LINKS, { today: () => "2026-10-07" });

    const aug = async () => (await withTenant(appPool, t, (tx) => simplesOverview(tx, entityId))).find((r) => r.competence === "2026-08-01");
    // só 08/2025 tem folha: os outros 11 meses faltam
    let r = await aug();
    expect(r).toMatchObject({ status: "NAO_SUPORTADO" });
    expect(r.result.reason).toMatch(/Fator r: folha de salários sem valor em 09\/2025, .*07\/2026/);

    // pessoa informa a folha; a mudança é reação ao evento PAYROLL_INFORMED
    await expect(informPayroll(appPool, t, { entityId, competence: "2025-09-01", total: "7.000,00", reason: "resumo" }, { kind: "AGENT", id: "tax" })).rejects.toThrow(/pessoa/);
    await expect(informPayroll(appPool, t, { entityId, competence: "2025-09-01", total: "abc", reason: "resumo" }, LUAN)).rejects.toThrow(/inválido/);
    for (const c of ["2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"])
      await informPayroll(appPool, t, { entityId, competence: `${c}-01`, total: "7.000,00", reason: "resumo da folha" }, LUAN);
    expect((await informPayroll(appPool, t, { entityId, competence: "2026-07-01", total: "7000.00", reason: "de novo" }, LUAN)).changed).toBe(false);
    await runOrchestrator(appPool, t, LINKS, { today: () => "2026-10-07" });

    // 82.000 ÷ 244.000 = 33,61% → Anexo III
    r = await aug();
    expect(r.inputs.factorR).toMatchObject({ payroll: "82000.00", revenue: "244000.00", r: "33.6066", annex: "III", convention: "CALCULADO", firstMonth: false });
    expect(r.rule_refs).toContain("ANEXO_III@1");
    expect(r.result.activities[0]).toMatchObject({ annex: "III", declaredAnnex: null, factorR: true });
    expect(Number(r.total)).toBeGreaterThan(0);

    // folha de 06 e 07/2026 corrigida para zero: 68.000 ÷ 244.000 = 27,87% → Anexo V
    await informPayroll(appPool, t, { entityId, competence: "2026-06-01", total: "0,00", reason: "sem empregados" }, LUAN);
    await informPayroll(appPool, t, { entityId, competence: "2026-07-01", total: "0,00", reason: "sem empregados" }, LUAN);
    await runOrchestrator(appPool, t, LINKS, { today: () => "2026-10-07" });
    r = await aug();
    expect(r.inputs.factorR).toMatchObject({ payroll: "68000.00", r: "27.8689", annex: "V" });
    expect(r.inputs.factorR.payrollSources).toMatchObject({ "2025-08": "DECLARADA", "2026-07": "INFORMADA" });
    expect(r.rule_refs).toContain("ANEXO_V@1");

    payroll = await withTenant(appPool, t, (tx) => payrollMonths(tx, entityId));
    expect(payroll.get("2026-07-01")).toEqual({ total: "0.00", source: "INFORMADA" });
    const audit = await withTenant(appPool, t, (tx) => tx.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'tax.payroll_informed'"));
    expect(audit.rows[0].n).toBe(13);
  });

  it("sem o parâmetro do fator r aprovado, a atividade fica com a regra pendente", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    const integra = new FakeIntegraContador(OFFICE, {}, { [CNPJ_MATRIZ]: { lastDeclarations: { "202608": { number: "12345678901234567", pdf: PDF } } } });
    await withTenant(appPool, t, async (tx) => {
      await tx.query(
        `INSERT INTO power_of_attorney (id, tenant_id, entity_id, system, grantee_document, scopes, valid_from, valid_to, source, verified_at)
         VALUES ($1, current_tenant(), $2, 'ECAC', $3, '{TODOS}', '2025-01-01', '2030-12-31', 'teste', now())`,
        [newId(), entityId, OFFICE],
      );
    });
    await fetchLastDeclaration({ appPool, integra, metering: { provider: "serpro", dailyLimit: 20 } }, t, { entityId, competence: "2026-08-01" });
    await withTenant(appPool, t, async (tx) => {
      const pdf = await tx.query<{ id: string }>("SELECT id FROM pgdas_declaration_pdf WHERE entity_id = $1", [entityId]);
      await tx.query(
        `INSERT INTO pgdas_declared_tax (id, tenant_id, entity_id, competence, pdf_id, seq, activity, annex, factor_r, revenue, irpj, csll, cofins, pis, cpp, icms, ipi, iss, total, parser)
         VALUES ($1, current_tenant(), $2, '2026-08-01', $3, 1, 'Serviços sujeitos ao fator r', NULL, true, 25300.50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'pgdas-pdf-3')`,
        [newId(), entityId, pdf.rows[0]!.id],
      );
      // aprova só a v1 dos parâmetros (sem fator r) e os anexos, como num escritório que ainda não aprovou a v2
      await tx.query(
        `INSERT INTO simples_rule_approval (id, tenant_id, rule_id, approved_by)
         SELECT gen_random_uuid(), current_tenant(), id, 'luan' FROM simples_rule WHERE version = 1`,
      );
    });
    await refreshSimples(appPool, t, entityId, NOW);
    const rows = await withTenant(appPool, t, (tx) => simplesOverview(tx, entityId));
    const aug = rows.find((r) => r.competence === "2026-08-01");
    expect(aug).toMatchObject({ status: "REGRA_PENDENTE" });
    expect(aug.result.reason).toMatch(/fator r/);
  });
});
