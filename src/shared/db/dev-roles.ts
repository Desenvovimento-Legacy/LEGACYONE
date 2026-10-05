import pg from "pg";
import { isMain } from "../is-main.js";

/**
 * Cria os usuários de login de DESENVOLVIMENTO e TESTE, membros dos papéis
 * legacy_app e legacy_relay. Em produção os usuários são criados pela
 * infraestrutura, com senhas do gerenciador de segredos.
 */
export async function createDevRoles(adminUrl: string, appUrl: string, relayUrl: string): Promise<void> {
  const app = new URL(appUrl);
  const relay = new URL(relayUrl);
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    for (const [login, role] of [
      [app, "legacy_app"],
      [relay, "legacy_relay"],
    ] as const) {
      const user = decodeURIComponent(login.username);
      const password = decodeURIComponent(login.password);
      const ident = client.escapeIdentifier(user);
      const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [user]);
      const verb = exists.rowCount ? "ALTER" : "CREATE";
      await client.query(
        `${verb} ROLE ${ident} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${client.escapeLiteral(password)}`,
      );
      await client.query(`GRANT ${role} TO ${ident}`);
    }
  } finally {
    await client.end();
  }
}

if (isMain(import.meta.url)) {
  const { ADMIN_DATABASE_URL, DATABASE_URL, RELAY_DATABASE_URL } = process.env;
  if (!ADMIN_DATABASE_URL || !DATABASE_URL || !RELAY_DATABASE_URL) {
    throw new Error("Defina ADMIN_DATABASE_URL, DATABASE_URL e RELAY_DATABASE_URL");
  }
  await createDevRoles(ADMIN_DATABASE_URL, DATABASE_URL, RELAY_DATABASE_URL);
  console.log("usuários de desenvolvimento prontos");
}
