import { describe, expect, it } from "vitest";
import { normalizeBrasilApi } from "../src/integrations/cnpj-public/brasilapi.js";
import type { CnpjPublicDataSource, PublicCompanyLookup } from "../src/integrations/cnpj-public/types.js";
import { FakeIntegraContador } from "../src/integrations/integra-contador/fake.js";
import { approveRules, defineContractedServices } from "../src/modules/onboarding/complete.js";
import { onboardByCnpj } from "../src/modules/onboarding/onboarding.js";
import { nextDueDates } from "../src/modules/onboarding/plan.js";
import { BusinessCalendar, loadCalendar } from "../src/modules/regulatory/calendar.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { entityDetail, humanQueue, rulesList } from "../src/web/ops.js";
import { brasilApiResponse, CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newTenant } from "./helpers.js";

const LUAN: Actor = { kind: "USER", id: "luan" };

async function calendar(): Promise<BusinessCalendar> {
  const c = await appPool.connect();
  try {
    return await loadCalendar(c);
  } finally {
    c.release();
  }
}

describe("calendário de dias úteis", () => {
  it("feriados nacionais e dias sem expediente bancário de 2026 estão na base", async () => {
    const cal = await calendar();
    expect(cal.dayOff("2026-11-20")).toMatchObject({ kind: "FERIADO_NACIONAL" });
    expect(cal.dayOff("2026-11-15")).toMatchObject({ kind: "FERIADO_NACIONAL" });
    expect(cal.dayOff("2026-02-17")).toMatchObject({ kind: "SEM_EXPEDIENTE_BANCARIO", name: "Carnaval (terça-feira)" });
    expect(cal.dayOff("2026-04-03")).toMatchObject({ name: "Sexta-feira da Paixão" });
    expect(cal.dayOff("2026-10-06")).toBeNull();
  });

  it("prorroga e antecipa pela regra conservadora", async () => {
    const cal = await calendar();
    // 15/11/2026: domingo e feriado → prorroga para segunda 16/11.
    expect(cal.adjust("2026-11-15", "NEXT_BUSINESS_DAY")).toEqual({ due: "2026-11-16", reason: "15/11 é Proclamação da República: prorrogado" });
    // 20/11/2026: sexta, feriado → FGTS antecipa para quinta 19/11; DAS prorroga para segunda 23/11.
    expect(cal.adjust("2026-11-20", "PREVIOUS_BUSINESS_DAY").due).toBe("2026-11-19");
    expect(cal.adjust("2026-11-20", "NEXT_BUSINESS_DAY").due).toBe("2026-11-23");
    // Dia só sem expediente bancário: antecipa, mas não prorroga (data mais cedo).
    expect(cal.adjust("2026-02-17", "PREVIOUS_BUSINESS_DAY").due).toBe("2026-02-13");
    expect(cal.adjust("2026-02-17", "NEXT_BUSINESS_DAY").due).toBe("2026-02-17");
    // Sábado comum.
    expect(cal.adjust("2026-12-19", "PREVIOUS_BUSINESS_DAY")).toEqual({ due: "2026-12-18", reason: "19/12 é sábado: antecipado" });
    expect(cal.adjust("2026-10-20", "NEXT_BUSINESS_DAY")).toEqual({ due: "2026-10-20", reason: null });
    expect(cal.adjust("2026-11-15", "NONE").due).toBe("2026-11-15");
  });

  it("próximos vencimentos já saem ajustados, com o motivo", async () => {
    const cal = await calendar();
    expect(nextDueDates({ kind: "next_month_day", day: 15, adjust: "NEXT_BUSINESS_DAY" }, "2026-10-06", 2, "2026-01-01", cal)).toEqual([
      { competence: "2026-09-01", due: "2026-10-15" },
      { competence: "2026-10-01", due: "2026-11-16", nominal: "2026-11-15", adjustReason: "15/11 é Proclamação da República: prorrogado" },
    ]);
    expect(nextDueDates({ kind: "next_month_day", day: 20, adjust: "PREVIOUS_BUSINESS_DAY" }, "2026-10-06", 2, "2026-01-01", cal)[1]).toMatchObject({
      competence: "2026-10-01",
      due: "2026-11-19",
    });
  });
});

describe("versão nova de regra: vale a anterior até o responsável técnico aprovar", () => {
  it("empresa segue na v1 aprovada; a Fila mostra a atualização; aprovar passa a v2 com ajuste", async () => {
    const t = await newTenant();
    const source: CnpjPublicDataSource = {
      name: "brasilapi-cnpj",
      async lookup(): Promise<PublicCompanyLookup> {
        const raw = brasilApiResponse();
        return { data: normalizeBrasilApi(raw), raw, source: "brasilapi-cnpj", fetchedAt: new Date("2026-10-05T12:00:00Z") };
      },
    };
    const integra = new FakeIntegraContador("11222333000181", { [CNPJ_MATRIZ]: { services: ["TODOS"], validFrom: "2025-05-10" } });
    const r = await onboardByCnpj({ appPool, publicData: source, integra }, t, { cnpj: CNPJ_MATRIZ, requester: "luan" });
    const pendingId = r.pending.find((p) => p.type === "CONTRACTED_SERVICES")!.id;

    // O escritório aprovou o catálogo antigo (v1) antes da atualização.
    await withTenant(appPool, t, async (tx) => {
      await tx.query(
        `INSERT INTO obligation_rule_approval (id, tenant_id, rule_id, approved_by)
         SELECT gen_random_uuid(), current_tenant(), id, 'luan' FROM obligation_rule WHERE version = 1`,
      );
    });
    const after = await defineContractedServices(
      appPool,
      t,
      { pendingItemId: pendingId, services: ["CONTABIL", "FISCAL", "FOLHA"], startDate: "2026-01-01" },
      LUAN,
    );
    const entityId = r.entityId!;
    expect(after.plan.rulesPendingApproval).toBeGreaterThan(0);

    await withTenant(appPool, t, async (tx) => {
      const d = (await entityDetail(tx, entityId))!;
      const defis = d.obligations.find((o) => o.code === "DEFIS");
      expect(defis).toMatchObject({ version: 1, newer_pending: false });
      const rules = await rulesList(tx);
      const pg = rules.find((x) => x.code === "PGDAS_D")!;
      expect(pg).toMatchObject({ version: 2, approved_by: null, in_use_version: 1 });
    });

    await approveRules(appPool, t, LUAN);
    await withTenant(appPool, t, async (tx) => {
      expect((await humanQueue(tx)).filter((h) => h.kind === "rules")).toEqual([]);
      const d = (await entityDetail(tx, entityId))!;
      const pg = d.obligations.find((o) => o.code === "PGDAS_D")!;
      expect(pg).toMatchObject({ version: 2, newer_pending: false });
      expect(pg.due).toMatchObject({ adjust: "NEXT_BUSINESS_DAY" });
    });
  });
});
