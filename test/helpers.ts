import { existsSync } from "node:fs";
import { afterAll } from "vitest";
import type { Actor } from "../src/shared/actor.js";
import { createPool } from "../src/shared/db/pool.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { createClient, createEntity } from "../src/modules/registry/registry.js";
import { createTenant } from "../src/platform/tenancy/tenants.js";

if (existsSync(".env")) process.loadEnvFile(".env");

export const adminPool = createPool(process.env.ADMIN_DATABASE_URL!, 2);
export const appPool = createPool(process.env.DATABASE_URL!, 5);
export const relayPool = createPool(process.env.RELAY_DATABASE_URL!, 2);

afterAll(async () => {
  await Promise.all([adminPool.end(), appPool.end(), relayPool.end()]);
});

export const SYSTEM: Actor = { kind: "SYSTEM", id: "test-suite" };
export const AGENT: Actor = { kind: "AGENT", id: "one-orchestrator", model: "test-model" };

/** Escritório novo e isolado para cada teste. */
export async function newTenant(label = "escritorio"): Promise<string> {
  return createTenant(adminPool, { name: `${label} ${Date.now()}`, slug: `${label}-${newId().slice(-12)}` });
}

/** Cliente + entidade PJ válida dentro do tenant. */
export async function newEntity(tenantId: string, cnpj = "12ABC34501DE35"): Promise<{ clientId: string; entityId: string }> {
  return withTenant(appPool, tenantId, async (tx) => {
    const clientId = await createClient(tx, "Cliente Teste", SYSTEM);
    const entityId = await createEntity(tx, { personKind: "PJ", clientId, cnpj, legalName: "ALPHA INDÚSTRIA LTDA" }, SYSTEM);
    return { clientId, entityId };
  });
}
