import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FakeIntegraContador } from "../src/integrations/integra-contador/fake.js";
import { parsePgdasDeclarationText, pdfText } from "../src/integrations/integra-contador/pgdas-pdf.js";
import { fetchLastDeclaration, reparseDeclarations, revenueCrossCheck } from "../src/modules/federal/declared-revenue.js";
import { billedCallsToday } from "../src/platform/metering/metering.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const OFFICE = "11222333000181";
const PDF = readFileSync("test/fixtures/pgdas-declaracao-ficticia.pdf");

describe("receita declarada no PGDAS-D (PDF oficial)", () => {
  it("lê RPA, RBT12, regime e os 12 meses anteriores do PDF", async () => {
    const c = parsePgdasDeclarationText(await pdfText(PDF));
    expect(c).toMatchObject({ period: "2026-08-01", regime: "COMPETENCIA", rbt12: "264000.00", rpa: { total: "25300.50" } });
    expect(c.months).toHaveLength(13);
    expect(c.months.find((m) => m.competence === "2026-05-01")).toMatchObject({ total: "1234.56", source: "ANTERIOR" });
    expect(c.months.at(-1)).toMatchObject({ competence: "2026-08-01", source: "RPA" });
  });

  it("1 consulta cobrada guarda o PDF, a receita mês a mês e cruza com as NFS-e prestadas", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
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
      const nf = (nsu: number, role: string, issued: string, v: string, key: string, ev: string | null = null) =>
        tx.query(
          `INSERT INTO nfse_document (id, tenant_id, entity_id, nsu, access_key, role, event_type, issued_at, service_value, xml, sha256)
           VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, '<x/>', '\\x00')`,
          [newId(), entityId, nsu, key, role, ev, issued, v],
        );
      await nf(1, "PRESTADA", "2026-08-10T10:00:00-03:00", "25000.00", "A1");
      await nf(2, "PRESTADA", "2026-08-31T23:30:00-03:00", "300.50", "A2"); // 31/08 em Brasília (já é 01/09 em UTC)
      await nf(3, "PRESTADA", "2026-07-05T10:00:00-03:00", "25000.00", "A3");
      await nf(4, "PRESTADA", "2026-07-06T10:00:00-03:00", "800.00", "A4");
      await nf(5, "EVENTO", "2026-07-07T10:00:00-03:00", "0", "A4", "101101");
      await nf(6, "TOMADA", "2026-08-02T10:00:00-03:00", "999.00", "B1");
    });
    const integra = new FakeIntegraContador(OFFICE, {}, { [CNPJ_MATRIZ]: { lastDeclarations: { "202608": { number: "12345678901234567", pdf: PDF } } } });
    const deps = { appPool, integra, metering: { provider: "serpro", dailyLimit: 20 } };
    const r = await fetchLastDeclaration(deps, t, { entityId, competence: "2026-08-01" });
    expect(r).toMatchObject({ found: true, months: 13, regime: "COMPETENCIA", calls: 1 });
    expect(integra.calls).toEqual([`pgdas-ultima:${CNPJ_MATRIZ}:202608`]);
    expect(await billedCallsToday(appPool, t, "serpro")).toBe(1);

    await withTenant(appPool, t, async (tx) => {
      // reler o PDF guardado não consulta nem duplica
      expect(await reparseDeclarations(tx, entityId)).toEqual({ pdfs: 1, months: 0 });
      const rows = await revenueCrossCheck(tx, entityId);
      const aug = rows.find((x) => x.competence === "2026-08-01")!;
      expect(aug).toMatchObject({ declared: "25300.50", nfsePrestadas: "25300.50", nfseCount: 2, difference: "0.00", status: "OK", responsibility: "LEGACY" });
      const jul = rows.find((x) => x.competence === "2026-07-01")!;
      expect(jul).toMatchObject({ declared: "25500.00", nfsePrestadas: "25000.00", cancelled: 1, difference: "-500.00", status: "DIVERGENTE", responsibility: "LEGACY" });
      const may = rows.find((x) => x.competence === "2026-05-01")!;
      expect(may).toMatchObject({ declared: "1234.56", nfsePrestadas: "0.00", status: "DIVERGENTE", responsibility: "ANTERIOR" });
    });
    expect(integra.calls).toHaveLength(1);
  });
});
