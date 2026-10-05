import { config } from "../../config.js";
import { NatsPublisher } from "./nats-publisher.js";
import { relayBatch } from "./relay.js";
import { createPool } from "../../shared/db/pool.js";

/** Processo do relay: drena o outbox para o NATS em ciclo contínuo. */
const pool = createPool(config.relayDatabaseUrl(), 2);
const publisher = await NatsPublisher.connect(config.natsUrl());
let running = true;

const stop = async () => {
  running = false;
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

console.log("relay do outbox iniciado");
while (running) {
  const { published, failed } = await relayBatch(pool, publisher);
  if (published || failed) console.log(`publicados=${published} falhas=${failed}`);
  if (published === 0) await new Promise((r) => setTimeout(r, 500));
}
await publisher.close();
await pool.end();
