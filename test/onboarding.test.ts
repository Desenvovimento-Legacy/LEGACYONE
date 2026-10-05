import { describe, expect, it } from "vitest";
import { normalizeBrasilApi } from "../src/integrations/cnpj-public/brasilapi.js";
import {
  CnpjNotFoundError,
  type CnpjPublicDataSource,
  type PublicCompanyLookup,
} from "../src/integrations/cnpj-public/types.js";
import { FakeIntegraContador } from "../src/integrations/integra-contador/fake.js";
import { onboardByCnpj, type OnboardingDeps } from "../src/modules/onboarding/onboarding.js";
import { profileAsOf } from "../src/modules/registry/registry.js";
import { consumeGrant, GrantInvalidError, requestAuthorization } from "../src/platform/authorization/authorization.js";
import { verifyAuditChain } from "../src/platform/audit/audit.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { brasilApiResponse, CNPJ_FILIAL, CNPJ_MATRIZ, CNPJ_PRESUMIDO } from "./fixtures/cnpj.js";
import { AGENT, appPool, newTenant } from "./helpers.js";

const OFFICE_CNPJ = "11222333000181";

class FixtureSource implements CnpjPublicDataSource {
  readonly name = "brasilapi-cnpj";
  calls = 0;
  constructor(private readonly responses: Record<string, Record<string, unknown>>) {}
  async lookup(cnpj: string): Promise<PublicCompanyLookup> {
    this.calls++;
    const raw = this.responses[cnpj];
    if (!raw) throw new CnpjNotFoundError(cnpj);
    return { data: normalizeBrasilApi(raw), raw, source: this.name, fetchedAt: new Date("2026-10-05T12:00:00Z") };
  }
}

function deps(over: Partial<OnboardingDeps> = {}): OnboardingDeps {
  return {
    appPool,
    publicData: new FixtureSource({
      [CNPJ_MATRIZ]: brasilApiResponse(),
      [CNPJ_FILIAL]: brasilApiResponse({ cnpj: CNPJ_FILIAL, identificador_matriz_filial: 2 }),
      [CNPJ_PRESUMIDO]: brasilApiResponse({
        cnpj: CNPJ_PRESUMIDO,
        opcao_pelo_simples: false,
        data_opcao_pelo_simples: "2018-01-01",
        data_exclusao_do_simples: "2024-01-01",
      }),
    }),
    integra: new FakeIntegraContador(OFFICE_CNPJ, {
      [CNPJ_MATRIZ]: { services: ["ECAC"], validFrom: "2025-05-10" },
    }),
    ...over,
  };
}

const count = (tenant: string, sql: string, params: unknown[] = []) =>
  withTenant(appPool, tenant, async (tx) => (await tx.query(sql, params)).rows[0].n as number);

describe("normalização da base pública de CNPJ", () => {
  it("preserva zeros à esquerda de CNAE e município", () => {
    const d = normalizeBrasilApi(brasilApiResponse({ codigo_municipio_ibge: 1100015 }));
    expect(d.secondaryCnaes.map((c) => c.code)).toEqual(["6209100", "0111301", "8299799"]);
    expect(d.primaryCnae.code).toBe("6201501");
    expect(d.partners[0]).toMatchObject({ name: "FULANO DE TAL", qualificationCode: 49, since: "2025-04-30" });
    expect(d.simples).toEqual({ optant: true, since: "2025-04-30", excludedAt: null });
  });
});

describe("One Onboarding: Case CLIENT_ONBOARDING pelo CNPJ", () => {
  it("monta o perfil completo e só pede ao humano o que não pode inferir", async () => {
    const t = await newTenant();
    const r = await onboardByCnpj(deps(), t, { cnpj: "12.abc.345/01de-35", requester: "luan" });

    expect(r.entityCreated).toBe(true);
    expect(r.pending.map((p) => p.type)).toEqual(["CONTRACTED_SERVICES"]);
    expect(r.caseStatus).toBe("WAITING_HUMAN");

    await withTenant(appPool, t, async (tx) => {
      expect(await profileAsOf(tx, r.entityId!, "2026-10-05")).toEqual({
        entity_type: "SOCIEDADE_EMPRESARIA",
        regime: "SIMPLES_NACIONAL",
        services: [],
      });
      expect(await profileAsOf(tx, r.entityId!, "2025-01-01")).toMatchObject({ regime: null });

      const est = await tx.query("SELECT kind, cnpj, uf, municipio_ibge, opened_at FROM establishment WHERE entity_id = $1", [
        r.entityId,
      ]);
      expect(est.rows).toEqual([
        { kind: "MATRIZ", cnpj: CNPJ_MATRIZ, uf: "SC", municipio_ibge: "4202305", opened_at: "2025-04-30" },
      ]);

      const cnaes = await tx.query("SELECT cnae, is_primary FROM activity_history ORDER BY is_primary DESC, cnae");
      expect(cnaes.rows).toEqual([
        { cnae: "6201501", is_primary: true },
        { cnae: "0111301", is_primary: false },
        { cnae: "6209100", is_primary: false },
        { cnae: "8299799", is_primary: false },
      ]);

      const partners = await tx.query("SELECT name, is_administrator FROM partner_history ORDER BY name");
      expect(partners.rows).toEqual([
        { name: "BELTRANA DE TAL", is_administrator: false },
        { name: "FULANO DE TAL", is_administrator: true },
      ]);

      const poa = await tx.query("SELECT system, grantee_document, valid_from, snapshot_id FROM power_of_attorney");
      expect(poa.rows[0]).toMatchObject({ system: "ECAC", grantee_document: OFFICE_CNPJ, valid_from: "2025-05-10" });
      expect(poa.rows[0].snapshot_id).not.toBeNull();

      const snaps = await tx.query("SELECT source, entity_id FROM external_snapshot ORDER BY source");
      expect(snaps.rows).toEqual([
        { source: "brasilapi-cnpj", entity_id: r.entityId },
        { source: "integra-contador-fake", entity_id: r.entityId },
      ]);

      const events = await tx.query("SELECT type FROM outbox WHERE case_id = $1 ORDER BY occurred_at, event_id", [r.caseId]);
      expect(events.rows.map((e) => e.type)).toEqual(
        expect.arrayContaining(["CASE_CREATED", "ENTITY_PROFILE_CREATED", "PENDING_ITEM_CREATED", "POWER_OF_ATTORNEY_VERIFIED"]),
      );
      expect(await verifyAuditChain(tx)).toBeNull();
    });
  });

  it("reexecutar não duplica entidade, pendência, evento nem evidência", async () => {
    const t = await newTenant();
    const d = deps();
    const first = await onboardByCnpj(d, t, { cnpj: CNPJ_MATRIZ, requester: "luan" });
    const second = await onboardByCnpj(d, t, { cnpj: CNPJ_MATRIZ, requester: "luan" });

    expect(second.caseId).toBe(first.caseId);
    expect(second.entityId).toBe(first.entityId);
    expect(second.entityCreated).toBe(false);
    expect(second.caseStatus).toBe("WAITING_HUMAN");
    expect(await count(t, "SELECT count(*)::int AS n FROM entity")).toBe(1);
    expect(await count(t, "SELECT count(*)::int AS n FROM pending_item")).toBe(1);
    expect(await count(t, "SELECT count(*)::int AS n FROM power_of_attorney")).toBe(1);
    expect(await count(t, "SELECT count(*)::int AS n FROM external_snapshot")).toBe(2);
    expect(await count(t, "SELECT count(*)::int AS n FROM outbox WHERE type = 'ENTITY_PROFILE_CREATED'")).toBe(1);
  });

  it("sem procuração: pede ao cliente e o Case aguarda o cliente", async () => {
    const t = await newTenant();
    const r = await onboardByCnpj(deps({ integra: new FakeIntegraContador(OFFICE_CNPJ, {}) }), t, {
      cnpj: CNPJ_MATRIZ,
      requester: "luan",
    });
    expect(r.pending.map((p) => [p.type, p.responsible_source])).toEqual([
      ["CONTRACTED_SERVICES", "OFFICE"],
      ["POWER_OF_ATTORNEY_MISSING", "CLIENT"],
    ]);
    expect(r.caseStatus).toBe("WAITING_CLIENT");
  });

  it("sem conector do Integra Contador: a verificação fica pendente, sem inventar procuração", async () => {
    const t = await newTenant();
    const r = await onboardByCnpj(deps({ integra: null }), t, { cnpj: CNPJ_MATRIZ, requester: "luan" });
    expect(r.pending.map((p) => p.type)).toContain("POWER_OF_ATTORNEY_CHECK");
    expect(await count(t, "SELECT count(*)::int AS n FROM power_of_attorney")).toBe(0);
  });

  it("fora do Simples: registra o período histórico e pede o regime atual", async () => {
    const t = await newTenant();
    const r = await onboardByCnpj(deps(), t, { cnpj: CNPJ_PRESUMIDO, requester: "luan" });
    expect(r.pending.map((p) => p.type)).toContain("TAX_REGIME_UNKNOWN");
    await withTenant(appPool, t, async (tx) => {
      expect((await profileAsOf(tx, r.entityId!, "2023-12-31")).regime).toBe("SIMPLES_NACIONAL");
      expect((await profileAsOf(tx, r.entityId!, "2024-01-01")).regime).toBeNull();
    });
  });

  it("filial não vira entidade: pede o CNPJ da matriz", async () => {
    const t = await newTenant();
    const r = await onboardByCnpj(deps(), t, { cnpj: CNPJ_FILIAL, requester: "luan" });
    expect(r.entityId).toBeNull();
    expect(r.pending.map((p) => p.type)).toEqual(["CNPJ_IS_BRANCH"]);
    expect(await count(t, "SELECT count(*)::int AS n FROM entity")).toBe(0);
  });

  it("CNPJ inexistente na base pública vira pendência do escritório", async () => {
    const t = await newTenant();
    const r = await onboardByCnpj(deps(), t, { cnpj: "11222333000181", requester: "luan" });
    expect(r.caseStatus).toBe("WAITING_HUMAN");
    expect(r.pending.map((p) => p.type)).toEqual(["CNPJ_NOT_FOUND"]);
  });
});

describe("Authorization Service", () => {
  it("libera consulta ao e-CAC só com procuração vigente, uma única vez", async () => {
    const t = await newTenant();
    const withPoa = await onboardByCnpj(deps(), t, { cnpj: CNPJ_MATRIZ, requester: "luan" });

    await withTenant(appPool, t, async (tx) => {
      const allow = await requestAuthorization(tx, { action: "integra.read", entityId: withPoa.entityId! }, AGENT);
      expect(allow.decision).toBe("ALLOW");
      if (allow.decision !== "ALLOW") return;
      await consumeGrant(tx, allow.grantId, "integra.read");
      await expect(consumeGrant(tx, allow.grantId, "integra.read")).rejects.toBeInstanceOf(GrantInvalidError);

      const before = await requestAuthorization(tx, { action: "integra.read", entityId: withPoa.entityId!, onDate: "2025-05-01" }, AGENT);
      expect(before).toMatchObject({ decision: "DENY" });

      const transmit = await requestAuthorization(tx, { action: "obligation.transmit", entityId: withPoa.entityId! }, AGENT);
      expect(transmit).toMatchObject({ decision: "DENY", policy: "transmit.requires-l4@1" });

      const decisions = await tx.query(
        "SELECT action FROM audit_log WHERE action LIKE 'authorization.%' ORDER BY seq",
      );
      expect(decisions.rows.map((r) => r.action)).toEqual(["authorization.allow", "authorization.deny", "authorization.deny"]);
    });
  });

  it("autorização não serve para outra ação", async () => {
    const t = await newTenant();
    const r = await onboardByCnpj(deps(), t, { cnpj: CNPJ_MATRIZ, requester: "luan" });
    await withTenant(appPool, t, async (tx) => {
      const allow = await requestAuthorization(tx, { action: "integra.read", entityId: r.entityId! }, AGENT);
      if (allow.decision !== "ALLOW") throw new Error("esperava ALLOW");
      await expect(consumeGrant(tx, allow.grantId, "obligation.transmit")).rejects.toBeInstanceOf(GrantInvalidError);
    });
  });
});
