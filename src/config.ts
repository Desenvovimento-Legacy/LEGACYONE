function required(name: string): string {
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
