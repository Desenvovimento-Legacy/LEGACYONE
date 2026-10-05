import { isMain } from "../shared/is-main.js";
import { createPool } from "../shared/db/pool.js";
import { config } from "../config.js";
import { createTenant } from "../platform/tenancy/tenants.js";

/** Cria um escritório (tenant). Uso: pnpm tenant:create "Nome do Escritório" slug */
if (isMain(import.meta.url)) {
  const [name, slug] = process.argv.slice(2);
  if (!name || !slug) {
    console.error('Uso: pnpm tenant:create "Nome do Escritório" slug-do-escritorio');
    process.exit(1);
  }
  const admin = createPool(config.adminDatabaseUrl(), 1);
  try {
    const existing = await admin.query<{ id: string }>("SELECT id FROM tenant WHERE slug = $1", [slug]);
    if (existing.rows[0]) {
      console.log(`Escritório já existe: ${slug} (${existing.rows[0].id})`);
    } else {
      const id = await createTenant(admin, { name, slug });
      console.log(`Escritório criado: ${name} — ${slug} (${id})`);
    }
  } finally {
    await admin.end();
  }
}
