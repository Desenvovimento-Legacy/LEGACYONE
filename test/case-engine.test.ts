import { describe, expect, it } from "vitest";
import { verifyAuditChain } from "../src/platform/audit/audit.js";
import { getCase, openCase, transitionCase } from "../src/platform/cases/case-engine.js";
import { canTransition, InvalidTransitionError } from "../src/platform/cases/state-machine.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { AGENT, appPool, newEntity, newTenant, SYSTEM } from "./helpers.js";

describe("Case Engine (critério de saída da Fase 0)", () => {
  it("Case percorre o ciclo completo gerando eventos e trilha de auditoria íntegra", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t);

    const { case: c, created } = await withTenant(appPool, t, (tx) =>
      openCase(
        tx,
        {
          type: "ACCOUNTING_CLOSING",
          idempotencyKey: `closing:${entityId}:2026-09`,
          origin: "deadline-engine",
          requester: "system",
          entityId,
          competence: "2026-09",
        },
        SYSTEM,
      ),
    );
    expect(created).toBe(true);
    expect(c.status).toBe("OPEN");
    expect(c.owner_agent).toBe("ledger");
    expect(c.competence).toBe("2026-09-01");

    for (const to of ["IN_PROGRESS", "WAITING_CLIENT", "IN_PROGRESS", "IN_REVIEW", "COMPLETED"] as const) {
      await withTenant(appPool, t, (tx) => transitionCase(tx, { caseId: c.id, to, reason: `teste ${to}` }, AGENT));
    }

    await withTenant(appPool, t, async (tx) => {
      const final = await getCase(tx, c.id);
      expect(final?.status).toBe("COMPLETED");
      expect(final?.closed_at).not.toBeNull();

      const transitions = await tx.query(
        "SELECT from_status, to_status FROM case_transition WHERE case_id = $1 ORDER BY occurred_at",
        [c.id],
      );
      expect(transitions.rows.map((r) => `${r.from_status ?? "-"}>${r.to_status}`)).toEqual([
        "->OPEN",
        "OPEN>IN_PROGRESS",
        "IN_PROGRESS>WAITING_CLIENT",
        "WAITING_CLIENT>IN_PROGRESS",
        "IN_PROGRESS>IN_REVIEW",
        "IN_REVIEW>COMPLETED",
      ]);

      const events = await tx.query(
        "SELECT type, correlation_id FROM outbox WHERE case_id = $1 ORDER BY occurred_at, event_id",
        [c.id],
      );
      expect(events.rows.map((r) => r.type)).toEqual([
        "CASE_CREATED",
        "CASE_STATUS_CHANGED",
        "CASE_STATUS_CHANGED",
        "CASE_STATUS_CHANGED",
        "CASE_STATUS_CHANGED",
        "CASE_STATUS_CHANGED",
        "CASE_COMPLETED",
      ]);
      expect(new Set(events.rows.map((r) => r.correlation_id))).toEqual(new Set([c.id]));

      const trail = await tx.query("SELECT action, actor_kind FROM audit_log WHERE case_id = $1 ORDER BY seq", [c.id]);
      expect(trail.rows).toHaveLength(6);
      expect(trail.rows[0]).toEqual({ action: "case.open", actor_kind: "SYSTEM" });
      expect(await verifyAuditChain(tx)).toBeNull();
    });
  });

  it("abrir o mesmo Case duas vezes devolve o original, sem evento duplicado", async () => {
    const t = await newTenant();
    const input = {
      type: "CLIENT_ONBOARDING" as const,
      idempotencyKey: "onboarding:12ABC34501DE35",
      origin: "portal",
      requester: "cliente@exemplo.com.br",
    };
    const first = await withTenant(appPool, t, (tx) => openCase(tx, input, SYSTEM));
    const second = await withTenant(appPool, t, (tx) => openCase(tx, input, SYSTEM));
    expect(second.created).toBe(false);
    expect(second.case.id).toBe(first.case.id);

    const n = await withTenant(appPool, t, (tx) =>
      tx.query("SELECT count(*)::int AS n FROM outbox WHERE type = 'CASE_CREATED'"),
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("recusa transição fora da máquina de estados, sem efeitos colaterais", async () => {
    const t = await newTenant();
    const { case: c } = await withTenant(appPool, t, (tx) =>
      openCase(tx, { type: "EXCEPTION", idempotencyKey: "exc-1", origin: "reconciliation", requester: "agent" }, AGENT),
    );
    await expect(
      withTenant(appPool, t, (tx) => transitionCase(tx, { caseId: c.id, to: "COMPLETED" }, AGENT)),
    ).rejects.toBeInstanceOf(InvalidTransitionError);

    const events = await withTenant(appPool, t, (tx) =>
      tx.query("SELECT count(*)::int AS n FROM outbox WHERE case_id = $1", [c.id]),
    );
    expect(events.rows[0].n).toBe(1); // só o CASE_CREATED
  });

  it("nada é concluído sem passar pela revisão", () => {
    expect(canTransition("IN_PROGRESS", "COMPLETED")).toBe(false);
    expect(canTransition("IN_REVIEW", "COMPLETED")).toBe(true);
    expect(canTransition("IN_REVIEW", "IN_PROGRESS")).toBe(true);
  });

  it("Case encerrado não muda, nem por SQL direto", async () => {
    const t = await newTenant();
    const { case: c } = await withTenant(appPool, t, (tx) =>
      openCase(tx, { type: "EXCEPTION", idempotencyKey: "exc-2", origin: "x", requester: "y" }, AGENT),
    );
    await withTenant(appPool, t, (tx) => transitionCase(tx, { caseId: c.id, to: "CANCELLED", reason: "duplicado" }, AGENT));
    await expect(
      withTenant(appPool, t, (tx) => tx.query(`UPDATE "case" SET status = 'OPEN', closed_at = NULL WHERE id = $1`, [c.id])),
    ).rejects.toThrow(/já encerrado/);
  });

  it("repetir uma transição já aplicada é no-op (reexecução segura)", async () => {
    const t = await newTenant();
    const { case: c } = await withTenant(appPool, t, (tx) =>
      openCase(tx, { type: "EXCEPTION", idempotencyKey: "exc-3", origin: "x", requester: "y" }, AGENT),
    );
    await withTenant(appPool, t, (tx) => transitionCase(tx, { caseId: c.id, to: "IN_PROGRESS" }, AGENT));
    const again = await withTenant(appPool, t, (tx) => transitionCase(tx, { caseId: c.id, to: "IN_PROGRESS" }, AGENT));
    expect(again.changed).toBe(false);
  });

  it("Case de fechamento exige entidade", async () => {
    const t = await newTenant();
    await expect(
      withTenant(appPool, t, (tx) =>
        openCase(tx, { type: "ACCOUNTING_CLOSING", idempotencyKey: "k", origin: "x", requester: "y" }, SYSTEM),
      ),
    ).rejects.toThrow(/exige entityId/);
  });
});
