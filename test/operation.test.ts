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
import { AUTH_KEY, session } from "./auth-helpers.js";
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
    // Próximo passo automático: plano de implantação.
    expect(after.plan.checklist).toBeGreaterThan(0);
    expect(after.plan.migrationCaseId).not.toBeNull(); // empresa existia antes de 10/2026
    expect(after.plan.rulesPendingApproval).toBeGreaterThan(0);
    await withTenant(appPool, t, async (tx) => {
      const types = await tx.query("SELECT type, responsible_source FROM pending_item WHERE status = 'OPEN' ORDER BY type");
      expect(types.rows.map((x) => x.type)).toEqual(
        expect.arrayContaining(["CLIENT_CERTIFICATE", "BANK_ACCOUNTS", "PREV_TRIAL_BALANCE", "OBLIGATION_RULES_APPROVAL"]),
      );
      const cases = await tx.query(`SELECT type, status FROM "case" ORDER BY type`);
      expect(cases.rows).toEqual(expect.arrayContaining([
        { type: "ACCOUNTING_FIRM_MIGRATION", status: "WAITING_CLIENT" },
        { type: "DOCUMENT_REQUEST", status: "WAITING_CLIENT" },
      ]));
    });

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
      authKey: AUTH_KEY,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((r) => server.close(() => r()));
    const cookie = await session(base, t);
    const fetch = ((u: string, init?: RequestInit) =>
      globalThis.fetch(u, { ...init, headers: { ...((init?.headers as Record<string, string>) ?? {}), cookie } })) as typeof globalThis.fetch;

    const c = await (await fetch(`${base}/api/central`)).json();
    expect(c.kpis).toMatchObject({ entities: 1, humanQueue: 1 });
    expect(c.human[0]).toMatchObject({ kind: "services", id: pendingId });
    expect(c.events.map((e: { type: string }) => e.type)).toContain("POWER_OF_ATTORNEY_VERIFIED");
    expect(c.pipeline[0].cells[0]).toMatchObject({ kind: "wait", text: "aguardando você" });

    const url = `${base}/api/pendencia/${pendingId}/servicos`;
    const body = JSON.stringify({ services: ["CONTABIL"], startDate: "2026-10-01" });
    expect((await fetch(url, { method: "POST", body })).status).toBe(403);
    const ok = await fetch(url, { method: "POST", body, headers: { "X-IARIS-Acao": "confirmar" } });
    expect(ok.status).toBe(200);

    const c2 = await (await fetch(`${base}/api/central`)).json();
    expect(c2.human.map((h: { kind: string }) => h.kind).sort()).toEqual(["approve", "rules"]);
    const approveItem = c2.human.find((h: { kind: string }) => h.kind === "approve");

    // Regras propostas: aprovar completa o mapa de obrigações da empresa.
    expect((await fetch(`${base}/api/regras/aprovar`, { method: "POST" })).status).toBe(403);
    const rules = await (await fetch(`${base}/api/regras/aprovar`, { method: "POST", headers: { "X-IARIS-Acao": "aprovar" } })).json();
    expect(rules.approved).toBe(6);
    expect(rules.obligationsAdded).toBeGreaterThan(0);
    const det = await (await fetch(`${base}/api/empresa/${c2.human[0].entityId ?? approveItem.entityId}`)).json();
    expect(det.obligations.map((o: { code: string }) => o.code)).toEqual(expect.arrayContaining(["PGDAS_D", "DEFIS"]));
    expect(det.access[0]).toMatchObject({ status: "OK" });

    const ap = await fetch(`${base}/api/case/${approveItem.id}/aprovar`, { method: "POST", headers: { "X-IARIS-Acao": "aprovar" } });
    expect(ap.status).toBe(200);
    const cres = await fetch(`${base}/api/cases`);
    const cases = await cres.json();
    expect(cres.status, JSON.stringify(cases)).toBe(200);
    expect(cases.cases[0]).toMatchObject({ status: "COMPLETED", type: "Implantação" });
  });
});

describe("prazos do mapa de obrigações", () => {
  it("só competências sob responsabilidade do escritório", async () => {
    const { nextDueDates } = await import("../src/modules/onboarding/plan.js");
    expect(nextDueDates({ kind: "next_month_day", day: 20 }, "2026-10-06", 2, "2026-10-01")).toEqual([
      { competence: "2026-10-01", due: "2026-11-20" },
      { competence: "2026-11-01", due: "2026-12-20" },
    ]);
    expect(nextDueDates({ kind: "next_month_day", day: 20 }, "2026-10-06", 1)).toEqual([{ competence: "2026-09-01", due: "2026-10-20" }]);
    expect(nextDueDates({ kind: "annual", month: 3, day: 31 }, "2026-10-06", 1, "2026-10-01")).toEqual([{ competence: "2026-01-01", due: "2027-03-31" }]);
  });
});
