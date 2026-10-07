import { connect, headers, JSONCodec, RetentionPolicy, StorageType, type NatsConnection } from "nats";
import { subjectFor, type EventEnvelope } from "./envelope.js";
import type { EventPublisher } from "./relay.js";

export const STREAM = "LEGACY_EVENTS";
const codec = JSONCodec<EventEnvelope>();

/**
 * Publicador JetStream. O header Nats-Msg-Id = event_id faz o JetStream
 * descartar republicações do mesmo evento dentro da janela de duplicidade.
 */
export class NatsPublisher implements EventPublisher {
  private constructor(private readonly nc: NatsConnection) {}

  static async connect(url: string): Promise<NatsPublisher> {
    const nc = await connect({ servers: url, name: "iares-relay" });
    const jsm = await nc.jetstreamManager();
    const existing = await jsm.streams.info(STREAM).catch(() => null);
    if (!existing) {
      await jsm.streams.add({
        name: STREAM,
        subjects: ["legacy.t.>"],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        duplicate_window: 2 * 60 * 60 * 1_000_000_000, // 2 h em nanossegundos
      });
    }
    return new NatsPublisher(nc);
  }

  async publish(envelope: EventEnvelope): Promise<void> {
    const h = headers();
    h.set("Nats-Msg-Id", envelope.event_id);
    h.set("Legacy-Tenant", envelope.tenant_id);
    await this.nc.jetstream().publish(subjectFor(envelope), codec.encode(envelope), { headers: h });
  }

  async close(): Promise<void> {
    await this.nc.drain();
  }
}
