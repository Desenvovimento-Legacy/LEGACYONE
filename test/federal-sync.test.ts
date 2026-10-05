import { describe, expect, it } from "vitest";
import { FakeIntegraContador } from "../src/integrations/integra-contador/fake.js";
import { parsePayments, parsePgdasYear } from "../src/integrations/integra-contador/parsers.js";
import type { FederalPayment } from "../src/integrations/integra-contador/types.js";
import { competenceSummary, dasPaymentsOutsidePgdas, FederalAccessDeniedError, syncFederalData } from "../src/modules/federal/federal-sync.js";
import { verifyAuditChain } from "../src/platform/audit/audit.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const OFFICE = "11222333000181";
const NOW = () => new Date("2026-10-05T15:00:00Z");

describe("interpretação das respostas do Integra Contador", () => {
  it("PGDAS-D: separa declarações e DAS por competência (exemplo oficial, chaves com caixa variável)", () => {
    const dados = JSON.stringify({
      anocalendario: 2018,
      periodos: [
        {
          periodoApuracao: 201802,
          operacoes: [
            { tipoOperacao: "Original", indiceDeclaracao: { numeroDeclaracao: "00000000201802001", dataHoraTransmissao: "20220331032533", malha: "" }, indiceDas: null },
            { tipoOperacao: "Retificadora", indiceDeclaracao: { numeroDeclaracao: "00000000201802002", dataHoraTransmissao: 20220606033046, malha: "Liberada" }, indiceDas: null },
            { tipoOperacao: "Geração de DAS", indiceDeclaracao: null, indiceDas: { numeroDas: "07202215999990940", datahoraEmissaoDas: "20220608111510", dasPago: false } },
          ],
        },
      ],
    });
    const v = parsePgdasYear(dados, { contributor: CNPJ_MATRIZ, year: 2018 });
    expect(v.declarations).toEqual([
      { competence: "2018-02-01", number: "00000000201802001", operation: "ORIGINAL", transmittedAt: "2022-03-31T03:25:33-03:00", malha: null },
      { competence: "2018-02-01", number: "00000000201802002", operation: "RETIFICADORA", transmittedAt: "2022-06-06T03:30:46-03:00", malha: "Liberada" },
    ]);
    expect(v.das).toEqual([
      { competence: "2018-02-01", number: "07202215999990940", operation: "GERACAO_DAS", issuedAt: "2022-06-08T11:15:10-03:00", paid: false },
    ]);
    expect(parsePgdasYear(null, { contributor: CNPJ_MATRIZ, year: 2019 })).toMatchObject({ declarations: [], das: [] });
  });

  it("PagtoWeb: valores viram decimal com 2 casas e a composição é preservada", () => {
    const dados = JSON.stringify([
      {
        numeroDocumento: "7082221013370000",
        tipo: { codigo: "9", descricao: "DOCUMENTO DE ARRECADAÇÃO DO SIMPLES NACIONAL", descricaoAbreviada: "DOCUMENTO DE ARRECADAÇÃO DO SIMPLES NACIONAL" },
        periodoApuracao: "2022-06-01T00:00:00-03:00",
        dataArrecadacao: "2022-07-29T00:00:00-03:00",
        dataVencimento: "2022-07-20T00:00:00-03:00",
        receitaPrincipal: { codigo: "55", descricao: null, extensaoReceita: null },
        valorTotal: 155.94,
        valorPrincipal: 151.44,
        valorMulta: 4.5,
        valorJuros: null,
        desmembramentos: [
          {
            sequencial: "1",
            receitaPrincipal: { codigo: "151", descricao: "INSS - SImples Nacional - MEI", extensaoReceita: { codigo: "11", descricao: "x" } },
            periodoApuracao: "2022-06-01T00:00:00-03:00",
            dataVencimento: "2022-07-20T00:00:00-03:00",
            valorTotal: 148.32,
            valorPrincipal: 145.44,
            valorMulta: 2.88,
            valorJuros: 0,
          },
        ],
      },
    ]);
    const [p] = parsePayments(dados);
    expect(p).toMatchObject({
      documentNumber: "7082221013370000",
      documentTypeCode: "9",
      competence: "2022-06-01",
      collectedOn: "2022-07-29",
      dueOn: "2022-07-20",
      revenueCode: "55",
      total: "155.94",
      principal: "151.44",
      fine: "4.50",
      interest: null,
    });
    expect(p!.breakdown[0]).toMatchObject({ revenueCode: "151", total: "148.32", fine: "2.88", interest: "0.00" });
    expect(parsePayments(null)).toEqual([]);
  });
});

function das(competence: string, number: string, paid: boolean) {
  return { competence, number, operation: "GERACAO_DAS" as const, issuedAt: `${competence.slice(0, 7)}-15T10:00:00-03:00`, paid };
}
function declaration(competence: string, number: string, operation: "ORIGINAL" | "RETIFICADORA" = "ORIGINAL") {
  return { competence, number, operation, transmittedAt: `${competence.slice(0, 7)}-15T09:00:00-03:00`, malha: null };
}
function payment(n: string, competence: string, collectedOn: string, total: string, typeCode = "9"): FederalPayment {
  return {
    documentNumber: n,
    documentTypeCode: typeCode,
    documentType: typeCode === "9" ? "DAS" : "DARF",
    competence,
    collectedOn,
    dueOn: collectedOn,
    revenueCode: typeCode === "9" ? "55" : "1082",
    revenueDescription: null,
    total,
    principal: total,
    fine: null,
    interest: null,
    breakdown: [],
  };
}

async function entityWithPoa(scopes: string[] = ["TODOS"]) {
  const t = await newTenant();
  const { entityId } = await newEntity(t, CNPJ_MATRIZ);
  await withTenant(appPool, t, async (tx) => {
    await tx.query("UPDATE entity SET activity_started_at = '2025-04-30' WHERE id = $1", [entityId]);
    await tx.query(
      `INSERT INTO power_of_attorney (id, tenant_id, entity_id, system, grantee_document, scopes, valid_from, valid_to, source, verified_at)
       VALUES ($1, current_tenant(), $2, 'ECAC', $3, $4, '2025-01-01', '2030-12-31', 'teste', now())`,
      [newId(), entityId, OFFICE, scopes],
    );
  });
  return { t, entityId };
}

const count = (t: string, sql: string) => withTenant(appPool, t, async (tx) => (await tx.query(sql)).rows[0].n as number);

describe("One Search: dados federais do Simples e pagamentos", () => {
  const data = () => ({
    [CNPJ_MATRIZ]: {
      declarations: [declaration("2025-05-01", "00000000202505001"), declaration("2025-06-01", "00000000202506001"), declaration("2025-06-01", "00000000202506002", "RETIFICADORA")],
      das: [das("2025-05-01", "07202500000000001", true), das("2025-06-01", "07202500000000002", false)],
      payments: [
        payment("7202500000000001", "2025-05-01", "2025-06-20", "812.45"),
        payment("7182500000000009", "2025-06-01", "2025-07-01", "300.00"),
        payment("7000000000000002", "2025-06-01", "2025-07-18", "15.00", "4"),
      ],
    },
  });

  it("autoriza cada consulta, grava com evidência e resume por competência", async () => {
    const { t, entityId } = await entityWithPoa();
    const integra = new FakeIntegraContador(OFFICE, {}, data());
    const r = await syncFederalData({ appPool, integra, now: NOW }, t, { entityId });

    // Início de atividade em 2025: não consulta anos anteriores.
    expect(r.years.map((y) => y.year)).toEqual([2025, 2026]);
    expect(integra.calls).toEqual([
      `pgdas:${CNPJ_MATRIZ}:2025`,
      `pgdas:${CNPJ_MATRIZ}:2026`,
      `pagamentos:${CNPJ_MATRIZ}:2025-01-01:2025-12-31:0`,
      `pagamentos:${CNPJ_MATRIZ}:2026-01-01:2026-10-05:0`,
    ]);
    expect(r.payments).toMatchObject({ total: 3, created: 3 });

    await withTenant(appPool, t, async (tx) => {
      const s = await competenceSummary(tx, entityId, "2025-01-01");
      expect(s).toEqual([
        expect.objectContaining({ competence: "2025-05-01", declarations: 1, rectifications: 0, das: 1, dasPaidFlag: true, dasPayments: 1, dasPaidAmount: "812.45", dasPaidOn: "2025-06-20" }),
        expect.objectContaining({ competence: "2025-06-01", declarations: 2, rectifications: 1, das: 1, dasPaidFlag: false, dasPayments: 0, dasPaidAmount: null }),
      ]);
      // DAS pago que não saiu do PGDAS-D (ex.: parcela) não é confundido com o DAS da competência.
      const outside = await dasPaymentsOutsidePgdas(tx, entityId, "2025-01-01");
      expect(outside.map((o) => o.document_number)).toEqual(["7182500000000009"]);
      const grants = await tx.query("SELECT count(*)::int AS n FROM authorization_grant WHERE consumed_at IS NOT NULL");
      expect(grants.rows[0].n).toBe(4);
      const noEvidence = await tx.query(
        "SELECT count(*)::int AS n FROM federal_payment p LEFT JOIN external_snapshot s ON s.id = p.snapshot_id WHERE s.id IS NULL",
      );
      expect(noEvidence.rows[0].n).toBe(0);
      expect(await verifyAuditChain(tx)).toBeNull();
    });
  });

  it("reexecutar não duplica; DAS que passou a constar como pago ganha nova observação", async () => {
    const { t, entityId } = await entityWithPoa();
    const d = data();
    const integra = new FakeIntegraContador(OFFICE, {}, d);
    await syncFederalData({ appPool, integra, now: NOW }, t, { entityId });
    await syncFederalData({ appPool, integra, now: NOW }, t, { entityId });
    expect(await count(t, "SELECT count(*)::int AS n FROM pgdas_declaration")).toBe(3);
    expect(await count(t, "SELECT count(*)::int AS n FROM pgdas_das")).toBe(2);
    expect(await count(t, "SELECT count(*)::int AS n FROM federal_payment")).toBe(3);
    expect(await count(t, "SELECT count(*)::int AS n FROM pgdas_das_status")).toBe(2);
    expect(await count(t, "SELECT count(*)::int AS n FROM outbox WHERE type IN ('PGDAS_INDEX_SYNCED','FEDERAL_PAYMENTS_SYNCED')")).toBe(4);

    d[CNPJ_MATRIZ].das[1] = das("2025-06-01", "07202500000000002", true);
    await syncFederalData({ appPool, integra, now: NOW }, t, { entityId });
    expect(await count(t, "SELECT count(*)::int AS n FROM pgdas_das_status")).toBe(3);
    await withTenant(appPool, t, async (tx) => {
      const s = await competenceSummary(tx, entityId, "2025-06-01");
      expect(s[0]).toMatchObject({ competence: "2025-06-01", dasPaidFlag: true });
    });
  });

  it("pagina os pagamentos de 100 em 100", async () => {
    const { t, entityId } = await entityWithPoa();
    const many = Array.from({ length: 150 }, (_, i) =>
      payment(`7100000000000${String(i).padStart(3, "0")}`, "2025-05-01", "2025-06-20", "1.00", "4"),
    );
    const integra = new FakeIntegraContador(OFFICE, {}, { [CNPJ_MATRIZ]: { payments: many } });
    const r = await syncFederalData({ appPool, integra, now: NOW }, t, { entityId });
    expect(r.payments).toMatchObject({ total: 150, created: 150, calls: 3 });
    expect(integra.calls.filter((c) => c.startsWith("pagamentos:") && c.includes("2025-01-01"))).toHaveLength(2);
  });

  it("sem procuração para o serviço, não consulta nada", async () => {
    const { t, entityId } = await entityWithPoa(["Caixa Postal - Mensagens"]);
    const integra = new FakeIntegraContador(OFFICE, {}, data());
    await expect(syncFederalData({ appPool, integra, now: NOW }, t, { entityId })).rejects.toBeInstanceOf(FederalAccessDeniedError);
    expect(integra.calls).toEqual([]);
    expect(await count(t, "SELECT count(*)::int AS n FROM audit_log WHERE action = 'authorization.deny'")).toBe(1);
  });
});
