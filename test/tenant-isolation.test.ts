import { describe, expect, it } from "vitest";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { adminPool, appPool, newEntity, newTenant } from "./helpers.js";

describe("isolamento entre escritórios (critério de saída da Fase 0)", () => {
  it("cada escritório só enxerga as próprias entidades, mesmo com CNPJ igual", async () => {
    const a = await newTenant("a");
    const b = await newTenant("b");
    const ea = await newEntity(a);
    const eb = await newEntity(b);

    const seenByA = await withTenant(appPool, a, (tx) => tx.query("SELECT id FROM entity"));
    const seenByB = await withTenant(appPool, b, (tx) => tx.query("SELECT id FROM entity"));
    expect(seenByA.rows.map((r) => r.id)).toEqual([ea.entityId]);
    expect(seenByB.rows.map((r) => r.id)).toEqual([eb.entityId]);
  });

  it("sem tenant definido a aplicação não lê nada", async () => {
    const a = await newTenant();
    await newEntity(a);
    const { rows } = await appPool.query("SELECT count(*)::int AS n FROM entity");
    expect(rows[0].n).toBe(0);
    const tenants = await appPool.query("SELECT count(*)::int AS n FROM tenant");
    expect(tenants.rows[0].n).toBe(0);
  });

  it("não grava linha em nome de outro escritório", async () => {
    const a = await newTenant();
    const b = await newTenant();
    await expect(
      withTenant(appPool, b, (tx) =>
        tx.query("INSERT INTO client (id, tenant_id, name) VALUES ($1, $2, 'invasor')", [newId(), a]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("não aponta FK para registro de outro escritório", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const { clientId: clientOfA } = await newEntity(a);
    await expect(
      withTenant(appPool, b, (tx) =>
        tx.query(
          `INSERT INTO entity (id, tenant_id, client_id, person_kind, cnpj, legal_name)
           VALUES ($1, current_tenant(), $2, 'PJ', '11222333000181', 'X')`,
          [newId(), clientOfA],
        ),
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("não altera registro de outro escritório", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const { entityId } = await newEntity(a);
    const res = await withTenant(appPool, b, (tx) =>
      tx.query("UPDATE entity SET legal_name = 'alterado' WHERE id = $1", [entityId]),
    );
    expect(res.rowCount).toBe(0);
  });

  it("a aplicação não cria escritórios", async () => {
    const a = await newTenant();
    await expect(
      withTenant(appPool, a, (tx) => tx.query("INSERT INTO tenant (id, name, slug) VALUES ($1, 'x', 'x-x')", [newId()])),
    ).rejects.toThrow(/permission denied/);
  });

  it("toda tabela com tenant_id tem RLS habilitada e forçada", async () => {
    const { rows } = await adminPool.query<{ table: string; rls: boolean; forced: boolean }>(`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND (EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
              OR c.relname = 'tenant')`);
    expect(rows.length).toBeGreaterThan(10);
    const unprotected = rows.filter((r) => !r.rls || !r.forced).map((r) => r.table);
    expect(unprotected).toEqual([]);
  });

  it("o login da aplicação não tem privilégios de superusuário nem BYPASSRLS", async () => {
    const { rows } = await appPool.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});
