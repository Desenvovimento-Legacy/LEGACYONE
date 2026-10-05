import type { Pool } from "pg";
import type { Actor } from "../../shared/actor.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";

/**
 * Medição de consultas cobradas. Antes de cada chamada cobrada, o chamador
 * reserva a chamada: o registro é gravado e o teto diário do escritório é
 * conferido na mesma transação (com trava por escritório, para duas buscas
 * simultâneas não furarem o teto).
 */

export class DailyLimitExceededError extends Error {
  constructor(
    readonly used: number,
    readonly limit: number,
  ) {
    super(`Teto diário de consultas cobradas atingido (${used} de ${limit}). Nenhuma consulta foi feita.`);
    this.name = "DailyLimitExceededError";
  }
}

export interface MeteringPolicy {
  provider: string;
  /** Máximo de consultas cobradas por dia (horário de Brasília) no escritório. */
  dailyLimit: number;
}

export function brazilDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(now);
}

export async function billedCallsToday(pool: Pool, tenantId: string, provider: string, now = new Date()): Promise<number> {
  return withTenant(pool, tenantId, async (tx) => {
    const { rows } = await tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM integration_call WHERE provider = $1 AND call_day = $2 AND billed",
      [provider, brazilDay(now)],
    );
    return rows[0]!.n;
  });
}

/** Reserva N chamadas cobradas de uma vez: ou cabem todas no teto, ou nenhuma é feita. */
export async function reserveBilledCalls(
  pool: Pool,
  tenantId: string,
  policy: MeteringPolicy,
  calls: { entityId: string | null; system: string; service: string; requestRef?: Record<string, unknown> }[],
  actor: Actor,
  now = new Date(),
): Promise<void> {
  if (!calls.length) return;
  const day = brazilDay(now);
  await withTenant(pool, tenantId, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('integration_call:' || current_tenant()::text || $1))", [
      policy.provider,
    ]);
    const { rows } = await tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM integration_call WHERE provider = $1 AND call_day = $2 AND billed",
      [policy.provider, day],
    );
    const used = rows[0]!.n;
    if (used + calls.length > policy.dailyLimit) throw new DailyLimitExceededError(used, policy.dailyLimit);
    for (const c of calls) {
      await tx.query(
        `INSERT INTO integration_call (id, tenant_id, entity_id, provider, system, service, billed, call_day,
                                       actor_kind, actor_id, request_ref)
         VALUES ($1, current_tenant(), $2, $3, $4, $5, true, $6, $7, $8, $9)`,
        [newId(), c.entityId, policy.provider, c.system, c.service, day, actor.kind, actor.id, JSON.stringify(c.requestRef ?? {})],
      );
    }
  });
}
