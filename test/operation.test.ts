import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeBrasilApi } from "../src/integrations/cnpj-public/brasilapi.js";
import type { CnpjPublicDataSource, PublicCompanyLookup } from "../src/integrations/cnpj-public/types.js";
import { FakeIntegraContador } from "../src/integrations/integra-contador/fake.js";
import { approveCase, defineContractedServices, HumanActionError } from "../src/modules/onboarding/complete.js";
import { onboardByCnpj } from "../src/modules/onboarding/onboarding.js";
import { profileAsOf } from "../src/modules/registry/registry.js";
import { verifyAuditChain } from "../src/platform/audit/audit.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { createWebServer } from "../src/web/server.js";
import { brasilApiResponse, CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { AGENT, appPool, newTenant } from "./helpers.js";

const OFFICE = "11222333000181";
const LUAN: Actor = { kind: "USER", id: "luan" };

const source: CnpjPublicDataSource = {
  name: "brasilapi-cnpj",
  async lookup(): Promise<PublicCompanyLookup> {
    const raw = brasilApiResponse();
    return { data: normalizeBrasilApi(raw), raw, source: "brasilapi-cnpj", fetchedAt: new Date("2026-10-05T12:00:00Z") };
  },
};

async function onboarded() {
  const t = await newTenant();
  const integra = new FakeIntegraContador(OFFICE, { [CNPJ_MATRIZ]: { services: ["TODOS"], validFrom: "2025-05-10" } });
  const r = await onboardByCnpj({ appPool, publicData: source, integra }, t, { cnpj: CNPJ_MATRIZ, requester: "luan" });
  return { t, r, pendingId: r.pending.find((p) => p.type === "CONTRACTED_SERVICES")!.id };
}

describe("Fila humana: decisões que fecham a implantação", () => {
  it("serviços e início da responsabilidade → pendência resolvida, Case em revisão; aprovação conclui", async () => {
    const { t, r, pendingId } = await onboarded();
    expect(r.caseStatus).toBe("WAITING_HUMAN");

    const after = await defineContractedServices(
      appPool,
      t,
      { pendingItemId: pendingId, services: ["CONTABIL", "FISCAL", "FOLHA", "SOCIETARIO"], startDate: "2026-10-01" },
      LUAN,
    );
    expect(after.caseStatus).toBe("IN_REVIEW");

    await withTenant(appPool, t, async (tx) => {
      expect((await profileAsOf(tx, r.entityId!, "2026-10-01")).services).toEqual(["CONTABIL", "FISCAL", "FOLHA", "SOCIETARIO"]);
      expect((await profileAsOf(tx, r.entityId!, "2026-09-30")).services).toEqual([]);
      const ev = await tx.query("SELECT payload FROM outbox WHERE type = 'CONTRACTED_SERVICES_DEFINED'");
      expect(ev.rows[0].payload).toMatchObject({ valid_from: "2026-10-01", defined_by: "luan" });
    });

    // Repetir a mesma decisão não é possível: a pendência já foi resolvida.
    await expect(
      defineContractedServices(appPool, t, { pendingItemId: pendingId, services: ["CONTABIL"], startDate: "2026-10-01" }, LUAN),
    ).rejects.toBeInstanceOf(HumanActionError);

    // Agente não aprova; pessoa aprova.
    await expect(approveCase(appPool, t, r.caseId, AGENT)).rejects.toBeInstanceOf(HumanActionError);
    expect(await approveCase(appPool, t, r.caseId, LUAN)).toBe("COMPLETED");
    await withTenant(appPool, t, async (tx) => {
      const a = await tx.query("SELECT approved_by FROM audit_log WHERE action = 'case.approve'");
      expect(a.rows[0].approved_by).toBe("luan");
      expect(await verifyAuditChain(tx)).toBeNull();
    });
  });

  it("data de início precisa ser dia 1 de uma competência", async () => {
    const { t, pendingId } = await onboarded();
    await expect(
      defineContractedServices(appPool, t, { pendingItemId: pendingId, services: ["CONTABIL"], startDate: "2026-10-15" }, LUAN),
    ).rejects.toThrow(/dia 1/);
  });
});

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

describe("tela: Central e Fila humana", () => {
  it("Central mostra a fila e os eventos reais; ação da fila exige o cabeçalho da tela", async () => {
    const { t, pendingId } = await onboarded();
    const server = createWebServer({
      appPool,
      tenantId: t,
      officeName: "Escritório Teste",
      integra: null,
      metering: { provider: "serpro", dailyLimit: 20 },
      port: 0,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((r) => server.close(() => r()));

    const c = await (await fetch(`${base}/api/central`)).json();
    expect(c.kpis).toMatchObject({ entities: 1, humanQueue: 1 });
    expect(c.human[0]).toMatchObject({ kind: "services", id: pendingId });
    expect(c.events.map((e: { type: string }) => e.type)).toContain("POWER_OF_ATTORNEY_VERIFIED");
    expect(c.pipeline[0].cells[0]).toMatchObject({ kind: "wait", text: "aguardando você" });

    const url = `${base}/api/pendencia/${pendingId}/servicos`;
    const body = JSON.stringify({ services: ["CONTABIL"], startDate: "2026-10-01" });
    expect((await fetch(url, { method: "POST", body })).status).toBe(403);
    const ok = await fetch(url, { method: "POST", body, headers: { "X-AIRES-Acao": "confirmar" } });
    expect(ok.status).toBe(200);

    const c2 = await (await fetch(`${base}/api/central`)).json();
    expect(c2.human).toHaveLength(1);
    expect(c2.human[0].kind).toBe("approve");
    const ap = await fetch(`${base}/api/case/${c2.human[0].id}/aprovar`, { method: "POST", headers: { "X-AIRES-Acao": "aprovar" } });
    expect(ap.status).toBe(200);
    const cres = await fetch(`${base}/api/cases`);
    const cases = await cres.json();
    expect(cres.status, JSON.stringify(cases)).toBe(200);
    expect(cases.cases[0]).toMatchObject({ status: "COMPLETED", type: "Implantação" });
  });
});
