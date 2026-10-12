import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FakeIntegraContador } from "../src/integrations/integra-contador/fake.js";
import { fetchLastDeclaration } from "../src/modules/federal/declared-revenue.js";
import { PGDAS_ACTIVITIES } from "../src/modules/tax/simples/pgdas-activities.js";
import { checkPgdasDraft, PgdasDraftError, pgdasDraftView, preparePgdasDrafts } from "../src/modules/tax/simples/pgdas-draft.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const OFFICE = "11222333000181";
const PDF = readFileSync("test/fixtures/pgdas-declaracao-ficticia.pdf");
const LUAN: Actor = { kind: "USER", id: "luan" };
const metering = { provider: "serpro", dailyLimit: 20 };

describe("PGDAS-D pronta para transmitir (nada é transmitido)", () => {
  it("monta pelas NFS-e e pela atividade declarada; confere com a Receita sem transmitir; guarda o pedido pronto", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    await withTenant(appPool, t, async (tx) => {
      await tx.query(
        `INSERT INTO power_of_attorney (id, tenant_id, entity_id, system, grantee_document, scopes, valid_from, valid_to, source, verified_at)
         VALUES ($1, current_tenant(), $2, 'ECAC', $3, '{TODOS}', '2025-01-01', '2030-12-31', 'teste', now())`,
        [newId(), entityId, OFFICE],
      );
      await tx.query(
        `INSERT INTO establishment (id, tenant_id, entity_id, kind, cnpj, uf, municipio_ibge, opened_at)
         VALUES ($1, current_tenant(), $2, 'MATRIZ', $3, 'SC', '4202305', '2020-01-01')`,
        [newId(), entityId, CNPJ_MATRIZ],
      );
    });
    const integra = new FakeIntegraContador(OFFICE, {}, {
      [CNPJ_MATRIZ]: {
        lastDeclarations: { "202608": { number: "12345678901234567", pdf: PDF } },
        simulations: { "202609": [{ code: 1001, value: "300.00" }, { code: 1010, value: "600.00" }, { code: 1006, value: "0.00" }] },
      },
    });
    await fetchLastDeclaration({ appPool, integra, metering }, t, { entityId, competence: "2026-08-01" });
    await withTenant(appPool, t, async (tx) => {
      const pdf = await tx.query<{ id: string }>("SELECT id FROM pgdas_declaration_pdf WHERE entity_id = $1", [entityId]);
      await tx.query(
        `INSERT INTO pgdas_declared_tax (id, tenant_id, entity_id, competence, declaration_number, pdf_id, seq, activity, annex, local_withheld,
                                         revenue, irpj, csll, cofins, pis, cpp, icms, ipi, iss, total, parser)
         VALUES ($1, current_tenant(), $2, '2026-08-01', '12345678901234567', $3, 1, $4, 'IV', false, 25300.50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'pgdas-pdf-2')`,
        [newId(), entityId, pdf.rows[0]!.id, PGDAS_ACTIVITIES[17]],
      );
      const nf = (nsu: number, v: string, withheld: boolean, key: string, ev: string | null = null) =>
        tx.query(
          `INSERT INTO nfse_document (id, tenant_id, entity_id, nsu, access_key, role, event_type, issued_at, service_value, iss_withheld, provider_doc, xml, sha256)
           VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, '2026-09-15T10:00:00-03:00', $7, $8, $9, '<x/>', '\\x00')`,
          [newId(), entityId, nsu, key, ev ? "EVENTO" : "PRESTADA", ev, v, withheld, CNPJ_MATRIZ],
        );
      await nf(1, "28000.00", false, "N1");
      await nf(2, "2000.00", true, "N2");
      await nf(3, "999.00", false, "N3");
      await nf(4, "0", false, "N3", "101101"); // cancelada: fora
    });

    const p = await preparePgdasDrafts(appPool, t, entityId, "2026-10-12");
    expect(p).toMatchObject({ prepared: 1, competences: ["2026-09-01"] });
    expect((await preparePgdasDrafts(appPool, t, entityId, "2026-10-12")).prepared).toBe(0); // sem mudança, sem versão nova
    let view = await withTenant(appPool, t, (tx) => pgdasDraftView(tx, entityId));
    expect(view[0]).toMatchObject({ competence: "2026-09-01", status: "MONTADA", declaration_type: 1, revenue: "30000.00", readiness: "FALTA_CONFERIR" });
    const est = (view[0]!.payload.declaracao.estabelecimentos as { atividades?: { idAtividade: number; valorAtividade: number }[] }[])[0]!;
    // receita na variante certa da atividade: própria cidade (17) e com ISS retido (18)
    expect(est.atividades!.map((a) => [a.idAtividade, a.valorAtividade])).toEqual([[17, 28000], [18, 2000]]);

    // conferir com a Receita é pedido de pessoa
    await expect(checkPgdasDraft({ appPool, integra, metering }, t, view[0]!.id, { kind: "AGENT", id: "tax" })).rejects.toThrow(PgdasDraftError);
    const c = await checkPgdasDraft({ appPool, integra, metering }, t, view[0]!.id, LUAN);
    expect(c).toMatchObject({ status: "SO_RECEITA", total: "900.00" });
    expect(integra.calls).toContain(`pgdas-simulacao:${CNPJ_MATRIZ}:202609`);
    view = await withTenant(appPool, t, (tx) => pgdasDraftView(tx, entityId));
    expect(view[0]!.readiness).toBe("PRONTA_SO_RECEITA");
    await withTenant(appPool, t, async (tx) => {
      const r = await tx.query("SELECT ready_payload FROM pgdas_draft_check WHERE draft_id = $1", [view[0]!.id]);
      // o pedido de transmissão fica guardado, com os valores da Receita para comparação; a IARIS não envia
      expect(r.rows[0].ready_payload).toMatchObject({ indicadorTransmissao: true, indicadorComparacao: true, valoresParaComparacao: [{ codigoTributo: 1001, valor: 300 }, { codigoTributo: 1010, valor: 600 }] });
      const a = await tx.query("SELECT data FROM audit_log WHERE action = 'tax.pgdas_draft_checked'");
      expect(a.rows[0].data).toMatchObject({ transmitted: false });
    });
  });

  it("vendas de mercadorias e fator r bloqueiam com o motivo (nada inventado)", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    await withTenant(appPool, t, (tx) =>
      tx.query(
        `INSERT INTO establishment (id, tenant_id, entity_id, kind, cnpj, uf, municipio_ibge, opened_at)
         VALUES ($1, current_tenant(), $2, 'MATRIZ', $3, 'MG', '3105608', '2020-01-01')`,
        [newId(), entityId, CNPJ_MATRIZ],
      ));
    const integra = new FakeIntegraContador(OFFICE, {}, { [CNPJ_MATRIZ]: { lastDeclarations: { "202608": { number: "12345678901234567", pdf: PDF } } } });
    await withTenant(appPool, t, (tx) =>
      tx.query(
        `INSERT INTO power_of_attorney (id, tenant_id, entity_id, system, grantee_document, scopes, valid_from, valid_to, source, verified_at)
         VALUES ($1, current_tenant(), $2, 'ECAC', $3, '{TODOS}', '2025-01-01', '2030-12-31', 'teste', now())`,
        [newId(), entityId, OFFICE],
      ));
    await fetchLastDeclaration({ appPool, integra, metering }, t, { entityId, competence: "2026-08-01" });
    await withTenant(appPool, t, async (tx) => {
      const pdf = await tx.query<{ id: string }>("SELECT id FROM pgdas_declaration_pdf WHERE entity_id = $1", [entityId]);
      for (const [seq, id] of [[1, 2], [2, 11]] as const) {
        await tx.query(
          `INSERT INTO pgdas_declared_tax (id, tenant_id, entity_id, competence, declaration_number, pdf_id, seq, activity, annex, local_withheld,
                                           revenue, irpj, csll, cofins, pis, cpp, icms, ipi, iss, total, parser)
           VALUES ($1, current_tenant(), $2, '2026-08-01', '12345678901234567', $3, $4, $5, 'I', false, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'pgdas-pdf-2')`,
          [newId(), entityId, pdf.rows[0]!.id, seq, PGDAS_ACTIVITIES[id]],
        );
      }
    });
    await preparePgdasDrafts(appPool, t, entityId, "2026-10-12");
    const view = await withTenant(appPool, t, (tx) => pgdasDraftView(tx, entityId));
    expect(view[0]).toMatchObject({ status: "BLOQUEADA", readiness: "BLOQUEADA" });
    expect(view[0]!.blockers.join(" | ")).toMatch(/fator r/);
    expect(view[0]!.blockers.join(" | ")).toMatch(/Vendas de mercadorias/);
    await expect(checkPgdasDraft({ appPool, integra, metering }, t, view[0]!.id, LUAN)).rejects.toThrow(/bloqueada/);
  });
});
