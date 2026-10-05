import type { PoolClient } from "pg";
import type { EventEnvelope } from "./envelope.js";

/**
 * Executa o handler de um consumidor no máximo uma vez por evento.
 * Deve rodar dentro de withTenant(envelope.tenant_id): o registro no inbox e
 * os efeitos do handler commitam juntos ou não commitam.
 *
 * @returns true se processou; false se o evento já tinha sido processado.
 */
export async function processOnce(
  tx: PoolClient,
  consumer: string,
  envelope: EventEnvelope,
  handler: () => Promise<void>,
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `INSERT INTO inbox (consumer, event_id, tenant_id) VALUES ($1, $2, current_tenant())
     ON CONFLICT DO NOTHING`,
    [consumer, envelope.event_id],
  );
  if (!rowCount) return false;
  await handler();
  return true;
}
