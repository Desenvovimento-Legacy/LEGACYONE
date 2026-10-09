import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../../config.js";
import { isMain } from "../is-main.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

/**
 * Aplica as migrações SQL pendentes, em ordem, cada uma em sua transação.
 * Executa com o papel dono do schema (ADMIN_DATABASE_URL).
 */
export async function migrate(connectionString: string, log = console.log): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )`);
    const done = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Falha na migração ${file}: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`aplicada: ${file}`);
    }
    if (applied.length === 0) log("nenhuma migração pendente");
    return applied;
  } finally {
    await client.end();
  }
}

if (isMain(import.meta.url)) {
  await migrate(config.adminDatabaseUrl());
}
