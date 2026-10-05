import type { Pool, PoolClient } from "pg";
import { z } from "zod";

const TenantId = z.uuid();

/**
 * Transação com o tenant definido em `app.tenant_id` (SET LOCAL).
 *
 * É a única forma de a aplicação tocar dados de negócio: a RLS do banco
 * devolve zero linhas para qualquer transação sem tenant. O valor vale só
 * dentro da transação e some no COMMIT/ROLLBACK, então uma conexão devolvida
 * ao pool nunca carrega o tenant de outra requisição.
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const id = TenantId.parse(tenantId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Transação sem tenant (uso de plataforma: relay, administração). */
export async function withTx<T>(pool: Pool, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
