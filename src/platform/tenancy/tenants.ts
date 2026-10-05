import type { Pool } from "pg";
import { newId } from "../../shared/ids.js";

/**
 * Criação de escritório (tenant). Operação de plataforma, fora do alcance do
 * papel legacy_app: roda com o pool administrativo.
 */
export async function createTenant(adminPool: Pool, input: { name: string; slug: string }): Promise<string> {
  const id = newId();
  await adminPool.query("INSERT INTO tenant (id, name, slug) VALUES ($1, $2, $3)", [id, input.name, input.slug]);
  return id;
}
