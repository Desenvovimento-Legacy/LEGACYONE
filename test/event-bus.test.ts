import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "../src/platform/events/envelope.js";
import { processOnce } from "../src/platform/events/inbox.js";
import { appendEvent } from "../src/platform/events/outbox.js";
import { relayBatch, type EventPublisher } from "../src/platform/events/relay.js";
import { openCase } from "../src/platform/cases/case-engine.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { adminPool, AGENT, appPool, newTenant, relayPool } from "./helpers.js";

class MemoryPublisher implements EventPublisher {
  readonly sent: EventEnvelope[] = [];
  failNext = 0;
  async publish(e: EventEnvelope): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("NATS indisponível");
    }
    this.sent.push(e);
  }
}

async function drain(pub: EventPublisher) {
  let total = 0;
  for (;;) {
    const r = await relayBatch(relayPool, pub, 500);
    total += r.published;
    if (r.published === 0) return total;
  }
}

describe("Event Bus: outbox transacional", () => {
  it("evento só existe se a transação do dado confirmar", async () => {
    const t = await newTenant();
    await expect(
      withTenant(appPool, t, async (tx) => {
        await openCase(tx, { type: "EXCEPTION", idempotencyKey: "rollback-1", origin: "x", requester: "y" }, AGENT);
        throw new Error("falha depois de gravar");
      }),
    ).rejects.toThrow();
    const n = await withTenant(appPool, t, (tx) => tx.query("SELECT count(*)::int AS n FROM outbox"));
    expect(n.rows[0].n).toBe(0);
    const cases = await withTenant(appPool, t, (tx) => tx.query(`SELECT count(*)::int AS n FROM "case"`));
    expect(cases.rows[0].n).toBe(0);
  });

  it("recusa evento fora do registro de contratos ou com payload inválido", async () => {
    const t = await newTenant();
    const base = { schemaVersion: 1, producer: { kind: "engine", name: "x", version: "1" } as const, idempotencyKey: newId() };
    await expect(
      withTenant(appPool, t, (tx) => appendEvent(tx, { ...base, type: "INVENTADO" as never, payload: {} })),
    ).rejects.toThrow(/não registrado/);
    await expect(
      withTenant(appPool, t, (tx) => appendEvent(tx, { ...base, type: "CASE_COMPLETED", payload: { case_id: "x" } })),
    ).rejects.toThrow();
  });

  it("relay publica cada evento pendente e marca como publicado; envelope completo", async () => {
    const pub = new MemoryPublisher();
    await drain(pub); // limpa pendências de outros testes
    pub.sent.length = 0;

    const t = await newTenant();
    const { case: c } = await withTenant(appPool, t, (tx) =>
      openCase(tx, { type: "EXCEPTION", idempotencyKey: "relay-1", origin: "x", requester: "y" }, AGENT),
    );
    expect(await drain(pub)).toBe(1);
    const env = pub.sent[0]!;
    expect(env).toMatchObject({
      type: "CASE_CREATED",
      schema_version: 1,
      tenant_id: t,
      case_id: c.id,
      correlation_id: c.id,
      producer: { kind: "engine", name: "case-engine" },
      payload: { case_id: c.id, case_type: "EXCEPTION", status: "OPEN" },
    });
    expect(await drain(pub)).toBe(0); // nada pendente: não republica
  });

  it("falha de publicação mantém o evento pendente e registra o erro", async () => {
    const pub = new MemoryPublisher();
    await drain(pub);
    const t = await newTenant();
    await withTenant(appPool, t, (tx) =>
      openCase(tx, { type: "EXCEPTION", idempotencyKey: "relay-2", origin: "x", requester: "y" }, AGENT),
    );
    pub.failNext = 1;
    const r = await relayBatch(relayPool, pub);
    expect(r).toEqual({ published: 0, failed: 1 });
    const row = await adminPool.query("SELECT published_at, attempts, last_error FROM outbox WHERE tenant_id = $1", [t]);
    expect(row.rows[0]).toMatchObject({ published_at: null, attempts: 1, last_error: "NATS indisponível" });
    expect(await drain(pub)).toBe(1);
  });

  it("conteúdo do evento é imutável e o relay não altera payload", async () => {
    const t = await newTenant();
    await withTenant(appPool, t, (tx) =>
      openCase(tx, { type: "EXCEPTION", idempotencyKey: "imut-1", origin: "x", requester: "y" }, AGENT),
    );
    await expect(relayPool.query(`UPDATE outbox SET payload = '{}' WHERE tenant_id = $1`, [t])).rejects.toThrow(
      /permission denied/,
    );
    await expect(adminPool.query(`UPDATE outbox SET payload = '{}' WHERE tenant_id = $1`, [t])).rejects.toThrow(
      /imutável/,
    );
    await expect(adminPool.query(`DELETE FROM outbox WHERE tenant_id = $1`, [t])).rejects.toThrow(/excluídos/);
  });

  it("relay não lê nenhuma outra tabela de negócio", async () => {
    await expect(relayPool.query("SELECT * FROM entity LIMIT 1")).rejects.toThrow(/permission denied/);
    await expect(relayPool.query("SELECT * FROM audit_log LIMIT 1")).rejects.toThrow(/permission denied/);
  });
});

describe("Event Bus: inbox idempotente", () => {
  it("consumidor processa cada evento uma única vez", async () => {
    const t = await newTenant();
    const pub = new MemoryPublisher();
    await drain(pub);
    pub.sent.length = 0;
    await withTenant(appPool, t, (tx) =>
      openCase(tx, { type: "EXCEPTION", idempotencyKey: "inbox-1", origin: "x", requester: "y" }, AGENT),
    );
    await drain(pub);
    const env = pub.sent.find((e) => e.tenant_id === t)!;

    let runs = 0;
    const handle = () =>
      withTenant(appPool, env.tenant_id, (tx) =>
        processOnce(tx, "orchestrator", env, async () => {
          runs++;
        }),
      );
    expect(await handle()).toBe(true);
    expect(await handle()).toBe(false); // reentrega do barramento
    expect(runs).toBe(1);
  });
});
