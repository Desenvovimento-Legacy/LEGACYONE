import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FakeIntegraContador } from "../src/integrations/integra-contador/fake.js";
import { fetchLastDeclaration } from "../src/modules/federal/declared-revenue.js";
import { decideRevenueException, openRevenueExceptions, refreshRevenueExceptions } from "../src/modules/federal/revenue-exceptions.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { humanQueue } from "../src/web/ops.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const OFFICE = "11222333000181";
const PDF = readFileSync("test/fixtures/pgdas-declaracao-ficticia.pdf");
const LUAN: Actor = { kind: "USER", id: "luan" };

async function setup() {
  const t = await newTenant();
  const { entityId } = await newEntity(t, CNPJ_MATRIZ);
  const nf = (tx: Parameters<Parameters<typeof withTenant>[2]>[0], nsu: number, role: string, issued: string, v: string, key: string, ev: string | null = null, number: string | null = null) =>
    tx.query(
      `INSERT INTO nfse_document (id, tenant_id, entity_id, nsu, access_key, role, event_type, issued_at, service_value, number, xml, sha256)
       VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, '<x/>', '\\x00')`,
      [newId(), entityId, nsu, key, role, ev, issued, v, number],
    );
  await withTenant(appPool, t, async (tx) => {
    await tx.query(
      `INSERT INTO power_of_attorney (id, tenant_id, entity_id, system, grantee_document, scopes, valid_from, valid_to, source, verified_at)
       VALUES ($1, current_tenant(), $2, 'ECAC', $3, '{TODOS}', '2025-01-01', '2030-12-31', 'teste', now())`,
      [newId(), entityId, OFFICE],
    );
    await tx.query(
      "INSERT INTO contracted_service_history (id, tenant_id, entity_id, service, valid_from, source) VALUES ($1, current_tenant(), $2, 'FISCAL', '2026-07-01', 'teste')",
      [newId(), entityId],
    );
    // 08/2026 confere (25.300,50); 07/2026: 25.000 válidas + 500 cancelada = 25.500 declarado.
    await nf(tx, 1, "PRESTADA", "2026-08-10T10:00:00-03:00", "25300.50", "A1");
    await nf(tx, 2, "PRESTADA", "2026-07-05T10:00:00-03:00", "25000.00", "A2");
    await nf(tx, 3, "PRESTADA", "2026-07-06T10:00:00-03:00", "500.00", "A3", null, "77");
    await nf(tx, 4, "EVENTO", "2026-07-08T10:00:00-03:00", "0", "A3", "CANCELAMENTO");
  });
  const integra = new FakeIntegraContador(OFFICE, {}, { [CNPJ_MATRIZ]: { lastDeclarations: { "202608": { number: "12345678901234567", pdf: PDF } } } });
  await fetchLastDeclaration({ appPool, integra, metering: { provider: "serpro", dailyLimit: 20 } }, t, { entityId, competence: "2026-08-01" });
  return { t, entityId, nf };
}

describe("exceções da conferência de receita", () => {
  it("divergência vira exceção com hipótese; decisão humana; fecha sozinha quando passa a bater", async () => {
    const { t, entityId, nf } = await setup();
    const r1 = await refreshRevenueExceptions(appPool, t, entityId);
    expect(r1.opened).toBeGreaterThan(1); // 07/2026 + meses do escritório anterior sem NFS-e
    expect(await refreshRevenueExceptions(appPool, t, entityId)).toEqual({ opened: 0, updated: 0, closed: 0 });

    const all = await withTenant(appPool, t, (tx) => openRevenueExceptions(tx));
    const jul = all.find((x) => x.competence === "2026-07-01")!;
    expect(jul).toMatchObject({ declared: "25500.00", nfse: "25000.00", difference: "-500.00", responsibility: "LEGACY", hypothesis_code: "CANCELADAS_TOTAL", status: "WAITING_HUMAN" });
    expect(jul.notes).toEqual([expect.objectContaining({ number: "77", value: "500.00", cancelledOn: "2026-07-08" })]);
    const may = all.find((x) => x.competence === "2026-05-01")!;
    expect(may).toMatchObject({ hypothesis_code: "SEM_EXPLICACAO", responsibility: "ANTERIOR" });
    expect(all.find((x) => x.competence === "2026-08-01")).toBeUndefined();

    const q = await withTenant(appPool, t, (tx) => humanQueue(tx));
    const qi = q.find((x) => x.kind === "divergence" && x.caseId === jul.case_id)!;
    expect((qi as { divergence?: unknown }).divergence).toMatchObject({ hypothesis_code: "CANCELADAS_TOTAL" });

    // Decisões
    await expect(decideRevenueException(appPool, t, may.case_id, { decision: "MANTER", note: "" }, LUAN)).rejects.toThrow(/justificativa/);
    await expect(decideRevenueException(appPool, t, jul.case_id, { decision: "RETIFICAR" }, { kind: "AGENT", id: "review" })).rejects.toThrow(/pessoa/);
    await decideRevenueException(appPool, t, may.case_id, { decision: "MANTER", note: "Receita de aluguel, fora de NFS-e" }, LUAN);
    await decideRevenueException(appPool, t, jul.case_id, { decision: "RETIFICAR" }, LUAN);
    await withTenant(appPool, t, async (tx) => {
      const c = await tx.query(`SELECT id, status FROM "case" WHERE id = ANY($1)`, [[may.case_id, jul.case_id]]);
      const st = Object.fromEntries(c.rows.map((r) => [r.id, r.status]));
      expect(st[may.case_id]).toBe("COMPLETED");
      expect(st[jul.case_id]).toBe("WAITING_EXTERNAL");
      const p = await tx.query("SELECT count(*)::int AS n FROM pending_item WHERE status = 'OPEN' AND case_id = ANY($1)", [[may.case_id, jul.case_id]]);
      expect(p.rows[0].n).toBe(0);
      const a = await tx.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'review.exception_decided'");
      expect(a.rows[0].n).toBe(2);
    });
    // Reprocessar não reabre a pendência de quem já decidiu.
    await refreshRevenueExceptions(appPool, t, entityId);
    await withTenant(appPool, t, async (tx) => {
      const p = await tx.query("SELECT count(*)::int AS n FROM pending_item WHERE status = 'OPEN' AND case_id = $1", [jul.case_id]);
      expect(p.rows[0].n).toBe(0);
    });

    // Chega a nota que faltava em 07/2026: conferência bate e a exceção fecha sozinha.
    await withTenant(appPool, t, (tx) => nf(tx, 5, "PRESTADA", "2026-07-20T10:00:00-03:00", "500.00", "A5"));
    const r3 = await refreshRevenueExceptions(appPool, t, entityId);
    expect(r3.closed).toBe(1);
    await withTenant(appPool, t, async (tx) => {
      const c = await tx.query(`SELECT status FROM "case" WHERE id = $1`, [jul.case_id]);
      expect(c.rows[0].status).toBe("COMPLETED");
    });
  });
});
