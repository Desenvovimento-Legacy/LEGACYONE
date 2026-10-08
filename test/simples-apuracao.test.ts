import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FakeIntegraContador } from "../src/integrations/integra-contador/fake.js";
import { fetchLastDeclaration } from "../src/modules/federal/declared-revenue.js";
import { approveSimplesRules, refreshSimples, simplesOverview } from "../src/modules/tax/simples/apuracao.js";
import { LINKS } from "../src/modules/orchestration/links.js";
import { runOrchestrator } from "../src/platform/orchestrator/orchestrator.js";
import { storeExternalSnapshot } from "../src/platform/evidence/snapshot.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const OFFICE = "11222333000181";
const PDF = readFileSync("test/fixtures/pgdas-declaracao-ficticia.pdf");
const LUAN: Actor = { kind: "USER", id: "luan" };
const NOW = new Date("2026-10-07T12:00:00Z");

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];
const paid = (tx: Tx, entityId: string, snap: string, doc: string, comp: string, v: Record<string, string>) =>
  tx.query(
    `INSERT INTO federal_payment (id, tenant_id, entity_id, document_number, competence, collected_on, revenue_code, amount_total, breakdown, source, snapshot_id)
     VALUES ($1, current_tenant(), $2, $3, $4, $4::date + 50, '3333', 0, $5, 'teste', $6)`,
    [newId(), entityId, doc, comp, JSON.stringify(Object.entries(v).map(([d, p]) => ({ competence: comp, revenueDescription: `${d} - Simples Nacional`, principal: p, fine: "0.00", interest: "0.00" }))), snap],
  );

describe("apuração do Simples Nacional", () => {
  it("só calcula com tabela aprovada; confere declarado e DAS pago; apura o mês fechado pelas notas", async () => {
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

    await withTenant(appPool, t, async (tx) => {
      // o PDF fictício não tem a seção 2.7 (e seus meses somam RBT12 244.000,00): grava o débito declarado de 08/2026 como viria dela
      const pdf = await tx.query<{ id: string }>("SELECT id FROM pgdas_declaration_pdf WHERE entity_id = $1", [entityId]);
      await tx.query(
        `INSERT INTO pgdas_declared_tax (id, tenant_id, entity_id, competence, declaration_number, pdf_id, seq, activity, annex, local_withheld,
                                         revenue, irpj, csll, cofins, pis, cpp, icms, ipi, iss, total, parser)
         VALUES ($1, current_tenant(), $2, '2026-08-01', '12345678901234567', $3, 1, 'Serviços - Sujeitos ao Anexo IV, sem retenção', 'IV', false,
                 25300.50, 284.56, 218.45, 295.33, 63.95, 0, 0, 0, 574.86, 1437.15, 'pgdas-pdf-2')`,
        [newId(), entityId, pdf.rows[0]!.id],
      );
      const snap = await storeExternalSnapshot(tx, { source: "teste", requestKey: "pagtoweb", payload: { x: 1 }, fetchedAt: new Date(), entityId });
      await paid(tx, entityId, snap.id, "D07", "2026-07-01", { IRPJ: "267.24", CSLL: "205.15", Cofins: "277.36", "PIS/Pasep": "60.06", ISS: "539.88" });
      await paid(tx, entityId, snap.id, "D06", "2026-06-01", { IRPJ: "219.15", CSLL: "168.23", Cofins: "227.45", "PIS/Pasep": "49.25", ISS: "452.72" });
      // 09/2026 (ainda não declarado): 28.000 sem retenção + 2.000 com ISS retido; uma cancelada fica fora
      const nf = (nsu: number, role: string, v: string, key: string, withheld: boolean, ev: string | null = null, issued = "2026-09-15T10:00:00-03:00") =>
        tx.query(
          `INSERT INTO nfse_document (id, tenant_id, entity_id, nsu, access_key, role, event_type, issued_at, service_value, iss_withheld, xml, sha256)
           VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, '<x/>', '\\x00')`,
          [newId(), entityId, nsu, key, role, ev, issued, v, withheld],
        );
      await nf(1, "PRESTADA", "28000.00", "N1", false);
      await nf(2, "PRESTADA", "2000.00", "N2", true);
      await nf(3, "PRESTADA", "999.00", "N3", false);
      await nf(4, "EVENTO", "0", "N3", false, "101101");
      await nf(5, "PRESTADA", "5000.00", "N5", false, null, "2026-10-02T10:00:00-03:00"); // mês corrente: ainda não apura
    });

    // Sem aprovação: nada é calculado com tabela proposta.
    await refreshSimples(appPool, t, entityId, NOW);
    let rows = await withTenant(appPool, t, (tx) => simplesOverview(tx, entityId));
    expect(rows.find((r) => r.competence === "2026-08-01")).toMatchObject({ status: "REGRA_PENDENTE", total: null });

    await expect(approveSimplesRules(appPool, t, { kind: "AGENT", id: "tax" })).rejects.toThrow(/pessoa/);
    const a = await approveSimplesRules(appPool, t, LUAN);
    expect(a.approved).toHaveLength(6);
    expect((await approveSimplesRules(appPool, t, LUAN)).approved).toHaveLength(0);
    // Recalcular é reação ao evento de aprovação (vínculo tabelas-simples).
    await runOrchestrator(appPool, t, LINKS, { today: () => "2026-10-07" });

    rows = await withTenant(appPool, t, (tx) => simplesOverview(tx, entityId));
    const by = Object.fromEntries(rows.map((r) => [r.competence, r]));
    expect(by["2026-08-01"]).toMatchObject({ mode: "CONFERENCIA", status: "CONFERE", total: "1437.15", reference_kind: "DECLARACAO", difference: "0.00" });
    expect(by["2026-07-01"]).toMatchObject({ mode: "CONFERENCIA", status: "CONFERE", total: "1349.69", reference_kind: "DAS_PAGO" });
    expect(by["2026-06-01"]).toMatchObject({ status: "DIVERGE", total: "1106.80", difference: "-10.00" });
    expect(by["2026-06-01"].result.taxDifferences).toEqual({ ISS: "-10.00" });
    expect(by["2026-05-01"]).toMatchObject({ status: "SEM_REFERENCIA" });
    expect(by["2026-09-01"]).toMatchObject({ mode: "APURACAO", status: "CALCULADO", total: "1679.27" });
    expect(by["2026-09-01"].inputs).toMatchObject({ rpa: "30000.00", rbt12: "249300.50", nfseWithheld: "2000.00" });
    expect(by["2026-10-01"]).toBeUndefined();

    // Reprocessar sem mudança não grava nem emite de novo.
    expect(await refreshSimples(appPool, t, entityId, NOW)).toMatchObject({ changed: 0 });
    await withTenant(appPool, t, async (tx) => {
      const e = await tx.query("SELECT count(*)::int AS n FROM outbox WHERE type = 'SIMPLES_CALCULATED'");
      const c = await tx.query("SELECT count(*)::int AS n FROM simples_calculation");
      expect(e.rows[0].n).toBe(c.rows[0].n);
      const au = await tx.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'regulatory.simples_rule_approved'");
      expect(au.rows[0].n).toBe(6);
    });
  });
});
