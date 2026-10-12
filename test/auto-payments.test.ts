import { describe, expect, it } from "vitest";
import { FakeIntegraContador } from "../src/integrations/integra-contador/fake.js";
import { approveAutoPayments, paymentsToRefresh, runAutoPayments } from "../src/modules/federal/auto-payments.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const OFFICE = "11222333000181";
const metering = { provider: "serpro", dailyLimit: 20 };

describe("pagamentos na Receita atualizados sozinhos depois do vencimento", () => {
  it("só com autorização; 5 dias depois do vencimento; uma vez por empresa (não repete depois de consultado)", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    await withTenant(appPool, t, async (tx) => {
      await tx.query(
        `INSERT INTO power_of_attorney (id, tenant_id, entity_id, system, grantee_document, scopes, valid_from, valid_to, source, verified_at)
         VALUES ($1, current_tenant(), $2, 'ECAC', $3, '{TODOS}', '2025-01-01', '2030-12-31', 'teste', now())`,
        [newId(), entityId, OFFICE],
      );
      await tx.query(
        `INSERT INTO withholding_observation (id, tenant_id, entity_id, competence, tax, status, withheld, paid, due_on, details, fingerprint)
         VALUES ($1, current_tenant(), $2, '2026-08-01', 'CSRF', 'GUIA_NAO_ENVIADA', 2626.00, NULL, '2026-09-18', '{"responsibility":"LEGACY"}', 'f1')`,
        [newId(), entityId],
      );
    });
    const integra = new FakeIntegraContador(OFFICE, {}, { [CNPJ_MATRIZ]: { payments: [] } });
    const deps = { appPool, integra, metering, now: () => new Date("2026-09-25T12:00:00Z") };

    expect(await runAutoPayments(deps, t, "2026-09-25")).toMatchObject({ skipped: "não autorizada", calls: 0 });
    await expect(approveAutoPayments(appPool, t, { kind: "AGENT", id: "search" }, "x")).rejects.toThrow(/pessoa/);
    await approveAutoPayments(appPool, t, { kind: "USER", id: "luan" }, "Sim, automático");

    expect(await paymentsToRefresh(appPool, t, "2026-09-21")).toEqual([]); // ainda dentro dos 5 dias
    expect(await paymentsToRefresh(appPool, t, "2026-09-25")).toEqual([{ entityId, from: "2026-08-01", to: "2026-09-25", reason: expect.stringMatching(/CSRF 08\/2026 venceu em 18\/09\/2026/) }]);
    const r = await runAutoPayments(deps, t, "2026-09-25");
    expect(r).toMatchObject({ skipped: null, entities: 1, calls: 1 });
    expect(integra.calls.filter((c) => c.startsWith("pagamentos"))).toHaveLength(1);
    // consultado depois de vencimento + 5: não consulta de novo
    expect(await paymentsToRefresh(appPool, t, "2026-09-30")).toEqual([]);
    // vencida há mais de 60 dias: fica para pessoa
    expect(await paymentsToRefresh(appPool, t, "2026-12-30")).toEqual([]);
  });
});
