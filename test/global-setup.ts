import { existsSync } from "node:fs";
import { createDevRoles } from "../src/shared/db/dev-roles.js";
import { migrate } from "../src/shared/db/migrate.js";

export default async function setup(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const { ADMIN_DATABASE_URL, DATABASE_URL, RELAY_DATABASE_URL } = process.env;
  if (!ADMIN_DATABASE_URL || !DATABASE_URL || !RELAY_DATABASE_URL) {
    throw new Error("Testes de integração exigem ADMIN_DATABASE_URL, DATABASE_URL e RELAY_DATABASE_URL");
  }
  await migrate(ADMIN_DATABASE_URL, () => undefined);
  await createDevRoles(ADMIN_DATABASE_URL, DATABASE_URL, RELAY_DATABASE_URL);
}
