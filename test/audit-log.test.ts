import { describe, expect, it } from "vitest";
import { audit, verifyAuditChain } from "../src/platform/audit/audit.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { adminPool, AGENT, appPool, newTenant } from "./helpers.js";

async function writeEntries(tenant: string, n: number) {
  for (let i = 0; i < n; i++) {
    await withTenant(appPool, tenant, (tx) =>
      audit(tx, { actor: AGENT, action: "test.step", resourceType: "test", data: { i }, confidence: 0.97 }),
    );
  }
}

describe("audit log imutável", () => {
  it("encadeia hash e sequência por escritório", async () => {
    const a = await newTenant();
    const b = await newTenant();
    await writeEntries(a, 3);
    await writeEntries(b, 2);

    const rows = await withTenant(appPool, a, (tx) =>
      tx.query("SELECT seq, encode(prev_hash, 'hex') AS prev, encode(hash, 'hex') AS hash FROM audit_log ORDER BY seq"),
    );
    expect(rows.rows.map((r) => Number(r.seq))).toEqual([1, 2, 3]);
    expect(rows.rows[0].prev).toBe("00");
    expect(rows.rows[1].prev).toBe(rows.rows[0].hash);
    expect(rows.rows[2].prev).toBe(rows.rows[1].hash);

    expect(await withTenant(appPool, a, verifyAuditChain)).toBeNull();
    expect(await withTenant(appPool, b, verifyAuditChain)).toBeNull();
  });

  it("a aplicação não consegue forjar seq nem hash", async () => {
    const t = await newTenant();
    await withTenant(appPool, t, (tx) =>
      tx.query(
        `INSERT INTO audit_log (tenant_id, seq, actor_kind, actor_id, action, resource_type, prev_hash, hash)
         VALUES (current_tenant(), 999, 'USER', 'x', 'forjado', 'x', '\\xdead', '\\xbeef')`,
      ),
    );
    const r = await withTenant(appPool, t, (tx) => tx.query("SELECT seq, encode(prev_hash,'hex') AS prev FROM audit_log"));
    expect(Number(r.rows[0].seq)).toBe(1);
    expect(r.rows[0].prev).toBe("00");
    expect(await withTenant(appPool, t, verifyAuditChain)).toBeNull();
  });

  it("UPDATE, DELETE e TRUNCATE são bloqueados, inclusive para o dono do schema", async () => {
    const t = await newTenant();
    await writeEntries(t, 1);
    await expect(
      withTenant(appPool, t, (tx) => tx.query("UPDATE audit_log SET action = 'x'")),
    ).rejects.toThrow(/permission denied|imutável/);
    await expect(adminPool.query("UPDATE audit_log SET action = 'x' WHERE tenant_id = $1", [t])).rejects.toThrow(
      /imutável/,
    );
    await expect(adminPool.query("DELETE FROM audit_log WHERE tenant_id = $1", [t])).rejects.toThrow(/imutável/);
    await expect(adminPool.query("TRUNCATE audit_log")).rejects.toThrow(/imutável/);
  });

  it("adulteração direta no banco é detectada pela verificação da cadeia", async () => {
    const t = await newTenant();
    await writeEntries(t, 4);
    // Simula um superusuário que desliga a proteção e altera um registro.
    const client = await adminPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE audit_log DISABLE TRIGGER audit_immutable");
      await client.query(`UPDATE audit_log SET data = '{"i": 42}' WHERE tenant_id = $1 AND seq = 3`, [t]);
      await client.query("ALTER TABLE audit_log ENABLE TRIGGER audit_immutable");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(await withTenant(appPool, t, verifyAuditChain)).toBe(3);
  });
});
