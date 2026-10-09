import { openSecretsFile } from "./shared/secrets/secrets-file.js";

/**
 * Banco em nuvem: com IARIS_DB_TARGET=cloud no .env, as URLs do banco vêm do
 * cofre (CLOUD_ADMIN_DATABASE_URL, CLOUD_DATABASE_URL, CLOUD_RELAY_DATABASE_URL),
 * nunca do .env nem do código.
 */
function required(name: string): string {
  if (process.env.IARIS_DB_TARGET === "cloud" && name.endsWith("DATABASE_URL")) {
    const vault = openSecretsFile();
    if (!vault) throw new Error("IARIS_DB_TARGET=cloud, mas o cofre não foi encontrado");
    return vault.require(`CLOUD_${name}`);
  }
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente ${name} não definida (veja .env.example)`);
  }
  return value;
}

export const config = {
  adminDatabaseUrl: () => required("ADMIN_DATABASE_URL"),
  databaseUrl: () => required("DATABASE_URL"),
  relayDatabaseUrl: () => required("RELAY_DATABASE_URL"),
  natsUrl: () => process.env.NATS_URL ?? "nats://localhost:4222",
};
