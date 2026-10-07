import { describe, expect, it } from "vitest";
import { guidesOverview, refreshGuides } from "../src/modules/tax/guides.js";
import { storeExternalSnapshot } from "../src/platform/evidence/snapshot.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { humanQueue } from "../src/web/ops.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const TODAY = "2026-10-07";

describe("guias: DAS do Simples por competência", () => {
  it("prazo com dia útil, pagamento identificado pelo número do DAS, nunca 'inadimplente'", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    await withTenant(appPool, t, async (tx) => {
      const rule = await tx.query<{ id: string }>("SELECT id FROM obligation_rule WHERE code = 'PGDAS_D' AND superseded_at IS NULL ORDER BY version DESC LIMIT 1");
      await tx.query("INSERT INTO obligation_rule_approval (id, tenant_id, rule_id, approved_by) VALUES ($1, current_tenant(), $2, 'luan')", [newId(), rule.rows[0]!.id]);
      await tx.query(
        "INSERT INTO contracted_service_history (id, tenant_id, entity_id, service, valid_from, source) VALUES ($1, current_tenant(), $2, 'FISCAL', '2026-05-01', 'teste')",
        [newId(), entityId],
      );
      const snap = (await storeExternalSnapshot(tx, { source: "teste", requestKey: "pgdas", payload: { a: 1 }, fetchedAt: new Date(), entityId })).id;
      const decl = (comp: string, n: string) =>
        tx.query(
          `INSERT INTO pgdas_declaration (id, tenant_id, entity_id, competence, declaration_number, operation, transmitted_at, source, snapshot_id)
           VALUES ($1, current_tenant(), $2, $3, $4, 'ORIGINAL', $3::date + 45, 'teste', $5)`,
          [newId(), entityId, comp, n, snap],
        );
      const das = async (comp: string, n: string, paid: boolean | null) => {
        const id = newId();
        await tx.query(
          `INSERT INTO pgdas_das (id, tenant_id, entity_id, competence, das_number, operation, issued_at, source, snapshot_id)
           VALUES ($1, current_tenant(), $2, $3, $4, 'GERACAO_DAS', $3::date + 45, 'teste', $5)`,
          [id, entityId, comp, n, snap],
        );
        if (paid !== null) await tx.query("INSERT INTO pgdas_das_status (id, tenant_id, das_id, paid, observed_at, snapshot_id) VALUES ($1, current_tenant(), $2, $3, '2026-10-05', $4)", [newId(), id, paid, snap]);
      };
      const pay = (doc: string, comp: string, on: string) =>
        tx.query(
          `INSERT INTO federal_payment (id, tenant_id, entity_id, document_number, competence, collected_on, due_on, revenue_code, amount_total, breakdown, source, snapshot_id)
           VALUES ($1, current_tenant(), $2, $3, $4, $5, $5, '3333', 100.00, $6, 'teste', $7)`,
          [newId(), entityId, doc, comp, on, JSON.stringify([{ competence: comp, principal: "100.00", revenueDescription: "IRPJ - Simples Nacional" }]), snap],
        );
      await decl("2026-08-01", "11222333202608001"); await das("2026-08-01", "07202626189218745", false); await pay("7202626189218745", "2026-08-01", "2026-09-21");
      await decl("2026-07-01", "11222333202607001"); await das("2026-07-01", "07202623025156122", null); await pay("7202623025156122", "2026-07-01", "2026-08-25");
      await decl("2026-06-01", "11222333202606001"); await das("2026-06-01", "07202618735830752", true);
      await decl("2026-05-01", "11222333202605001"); await das("2026-05-01", "07202615933436789", false);
      // 04/2026 declarado com receita zero
      await decl("2026-04-01", "11222333202604001");
      const pdf = newId();
      await tx.query("INSERT INTO pgdas_declaration_pdf (id, tenant_id, entity_id, competence, kind, pdf, sha256) VALUES ($1, current_tenant(), $2, '2026-04-01', 'DECLARACAO', '\\x00', '\\x01')", [pdf, entityId]);
      await tx.query(
        "INSERT INTO pgdas_declared_revenue (id, tenant_id, entity_id, competence, declared_in, pdf_id, source, total) VALUES ($1, current_tenant(), $2, '2026-04-01', '2026-04-01', $3, 'RPA', 0)",
        [newId(), entityId, pdf],
      );
    });

    const { rows } = await withTenant(appPool, t, (tx) => guidesOverview(tx, entityId, TODAY));
    const by = Object.fromEntries(rows.map((r) => [r.competence, r]));
    expect(rows[0]!.competence).toBe("2026-09-01");
    expect(by["2026-09-01"]).toMatchObject({ status: "A_DECLARAR", due: "2026-10-20" });
    expect(by["2026-08-01"]).toMatchObject({ status: "PAGO", due: "2026-09-21", dueReason: expect.stringMatching(/domingo/) });
    expect(by["2026-08-01"]!.payment).toMatchObject({ collectedOn: "2026-09-21", principal: "100.00", source: "PAGTOWEB" });
    expect(by["2026-07-01"]).toMatchObject({ status: "PAGO_EM_ATRASO", due: "2026-08-20" });
    expect(by["2026-06-01"]).toMatchObject({ status: "PAGO", payment: { source: "PGDAS", collectedOn: null } });
    expect(by["2026-05-01"]).toMatchObject({ status: "PAGAMENTO_NAO_IDENTIFICADO", responsibility: "LEGACY" });
    expect(by["2026-04-01"]).toMatchObject({ status: "SEM_DEBITO", responsibility: "ANTERIOR" });
    expect(by["2026-03-01"]).toMatchObject({ status: "DECLARACAO_NAO_IDENTIFICADA", responsibility: "ANTERIOR" });

    const r1 = await refreshGuides(appPool, t, entityId, TODAY);
    expect(r1.changed).toBe(r1.guides);
    expect(await refreshGuides(appPool, t, entityId, TODAY)).toMatchObject({ changed: 0 });
    // O prazo de 09/2026 passa: muda de situação e vira item da Fila humana.
    expect(await refreshGuides(appPool, t, entityId, "2026-10-21")).toMatchObject({ changed: 1 });

    await withTenant(appPool, t, async (tx) => {
      const q = (await humanQueue(tx)).filter((x) => x.kind === "guide");
      expect(q.map((x) => x.title)).toEqual([
        "DAS 05/2026: pagamento ainda não identificado (vencimento 22/06/2026)",
        "PGDAS-D 09/2026: declaração ainda não identificada (prazo 20/10/2026)",
      ]);
      expect(JSON.stringify(q)).not.toMatch(/inadimpl/i);
      const ev = await tx.query("SELECT count(*)::int AS n FROM outbox WHERE type = 'GUIDE_STATUS_CHANGED'");
      expect(ev.rows[0].n).toBe(r1.guides + 1);
    });
  });
});
