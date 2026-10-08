import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FakeIntegraContador } from "../src/integrations/integra-contador/fake.js";
import { fetchLastDeclaration } from "../src/modules/federal/declared-revenue.js";
import { LINKS } from "../src/modules/orchestration/links.js";
import { appendEvent } from "../src/platform/events/outbox.js";
import { MAX_ATTEMPTS, runOrchestrator, type Link } from "../src/platform/orchestrator/orchestrator.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { humanQueue, linksData } from "../src/web/ops.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const OFFICE = "11222333000181";
const PDF = readFileSync("test/fixtures/pgdas-declaracao-ficticia.pdf");
const DEPS = { today: () => "2026-10-07" };

describe("orquestrador: vínculos entre agentes por evento", () => {
  it("declaração lida dispara conferência, Simples e guias sozinhos; a cadeia aponta para a causa; não repete", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    await withTenant(appPool, t, (tx) =>
      tx.query(
        `INSERT INTO power_of_attorney (id, tenant_id, entity_id, system, grantee_document, scopes, valid_from, valid_to, source, verified_at)
         VALUES ($1, current_tenant(), $2, 'ECAC', $3, '{TODOS}', '2025-01-01', '2030-12-31', 'teste', now())`,
        [newId(), entityId, OFFICE],
      ),
    );
    const integra = new FakeIntegraContador(OFFICE, {}, { [CNPJ_MATRIZ]: { lastDeclarations: { "202608": { number: "12345678901234567", pdf: PDF } } } });
    await fetchLastDeclaration({ appPool, integra, metering: { provider: "serpro", dailyLimit: 20 } }, t, { entityId, competence: "2026-08-01" });

    const r1 = await runOrchestrator(appPool, t, LINKS, DEPS);
    expect(r1.errors).toBe(0);
    await withTenant(appPool, t, async (tx) => {
      const reac = await tx.query<{ link_id: string; status: string }>("SELECT link_id, status FROM agent_reaction ORDER BY link_id");
      expect(reac.rows.map((r) => r.link_id)).toEqual(["contabil-automatico", "declaracao-conferencia", "declaracao-simples", "receita-guias"]);
      const errs = await tx.query("SELECT link_id, error FROM agent_reaction WHERE status = 'ERRO'");
      expect(errs.rows).toEqual([]);
      const decl = await tx.query<{ event_id: string; correlation_id: string }>("SELECT event_id, correlation_id FROM outbox WHERE type = 'PGDAS_DECLARATION_READ'");
      const caused = await tx.query<{ type: string; correlation_id: string }>("SELECT type, correlation_id FROM outbox WHERE causation_id = $1", [decl.rows[0]!.event_id]);
      // Exceções de receita (meses sem NFS-e) e situação das guias nasceram da declaração lida.
      expect(caused.rows.map((c) => c.type)).toEqual(expect.arrayContaining(["REVENUE_DIVERGENCE_DETECTED", "GUIDE_STATUS_CHANGED"]));
      const own = caused.rows.filter((c) => c.type === "REVENUE_DIVERGENCE_DETECTED" || c.type === "GUIDE_STATUS_CHANGED");
      expect(own.every((c) => c.correlation_id === decl.rows[0]!.correlation_id)).toBe(true);
    });
    expect(await runOrchestrator(appPool, t, LINKS, DEPS)).toMatchObject({ reactions: 0, errors: 0 });

    const view = await withTenant(appPool, t, (tx) => linksData(tx));
    expect(view.links.find((l) => l.id === "declaracao-simples")).toMatchObject({ agentName: "Tributos", ok7d: 1 });
    expect(view.recent[0]).toMatchObject({ status: "OK", event: "Declaração do PGDAS-D lida" });
  });

  it("eventos da mesma empresa viram uma reação; erro refaz até o limite e vai para a Fila humana", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    await withTenant(appPool, t, async (tx) => {
      for (let i = 0; i < 3; i++) {
        await appendEvent(tx, {
          type: "NFSE_BATCH_RECEIVED",
          schemaVersion: 1,
          producer: { kind: "agent", name: "docs", version: "test" },
          idempotencyKey: `teste:${i}`,
          entityId,
          payload: { entity_id: entityId, documents: 1, roles: { PRESTADA: 1 }, from_nsu: i, to_nsu: i },
        });
      }
    });
    const seen: number[] = [];
    let fail = true;
    const links: Link<object>[] = [
      { id: "teste-conta", on: ["NFSE_BATCH_RECEIVED"], agent: "review", does: "conta", run: async ({ events }) => { seen.push(events.length); return { n: events.length }; } },
      { id: "teste-falha", on: ["NFSE_BATCH_RECEIVED"], agent: "tax", does: "falha de propósito", run: async () => { if (fail) throw new Error("serviço indisponível"); return {}; } },
    ];
    for (let i = 0; i < MAX_ATTEMPTS; i++) await runOrchestrator(appPool, t, links, {});
    expect(seen).toEqual([3]); // uma reação para os 3 eventos; não repete
    await withTenant(appPool, t, async (tx) => {
      const n = await tx.query("SELECT count(*)::int AS n FROM agent_reaction WHERE link_id = 'teste-falha' AND status = 'ERRO'");
      expect(n.rows[0].n).toBe(MAX_ATTEMPTS);
      const q = (await humanQueue(tx)).filter((x) => x.kind === "link");
      expect(q).toHaveLength(1);
      expect(q[0]!.impact).toMatch(/serviço indisponível/);
    });
    // Depois do limite, não tenta mais sozinho.
    fail = false;
    expect(await runOrchestrator(appPool, t, links, {})).toMatchObject({ reactions: 0, errors: 0 });
  });
});
