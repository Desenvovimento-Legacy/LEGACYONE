import type { Pool } from "pg";
import { withTx } from "../../shared/db/tenant-tx.js";
import { toEnvelope, type EventEnvelope } from "./envelope.js";
import type { StoredEvent } from "./outbox.js";

/** Destino do relay. A implementação de produção é o NATS JetStream. */
export interface EventPublisher {
  /** Deve ser idempotente por event_id (JetStream: header Nats-Msg-Id). */
  publish(envelope: EventEnvelope): Promise<void>;
}

export interface RelayResult {
  published: number;
  failed: number;
}

/**
 * Publica um lote de eventos pendentes do outbox. Roda com o papel
 * legacy_relay. Usa FOR UPDATE SKIP LOCKED: várias instâncias do relay podem
 * rodar em paralelo sem publicar o mesmo evento duas vezes no mesmo ciclo.
 * Entrega é "pelo menos uma vez"; a deduplicação final é do JetStream e do
 * inbox de cada consumidor.
 */
export async function relayBatch(relayPool: Pool, publisher: EventPublisher, batchSize = 100): Promise<RelayResult> {
  return withTx(relayPool, async (tx) => {
    const { rows } = await tx.query<StoredEvent>(
      `SELECT * FROM outbox
        WHERE published_at IS NULL
        ORDER BY occurred_at, event_id
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );

    let published = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await publisher.publish(toEnvelope(row));
        await tx.query("UPDATE outbox SET published_at = clock_timestamp(), attempts = attempts + 1 WHERE event_id = $1", [
          row.event_id,
        ]);
        published++;
      } catch (err) {
        await tx.query("UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE event_id = $1", [
          row.event_id,
          String((err as Error).message ?? err).slice(0, 2000),
        ]);
        failed++;
      }
    }
    return { published, failed };
  });
}
