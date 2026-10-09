import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { migrate } from "../shared/db/migrate.js";
import { defaultSecretsPath, openSecretsFile, upsertSecrets } from "../shared/secrets/secrets-file.js";

/**
 * Banco em nuvem (Supabase, região São Paulo).
 *
 *   pnpm cloud:db setup <ref>   conecta com SUPABASE_DB_PASSWORD do cofre, aplica as
 *                               migrações, cria os logins da aplicação e do relay e
 *                               grava as URLs CLOUD_* no cofre.
 *   pnpm cloud:db copy          copia os dados do Postgres local (docker) para a nuvem
 *                               e confere contagem por tabela e a cadeia da auditoria.
 *   pnpm cloud:db check         testa os três logins na nuvem.
 *
 * Nenhuma senha ou URL com senha é impressa: só ✓/✗.
 */

const LOCAL_CONTAINER = process.env.IARIS_PG_CONTAINER ?? "legacyone-postgres-1";
const LOCAL_DB = process.env.IARIS_PG_DB ?? "legacy_one";
const POOLER_HOSTS = ["aws-0-sa-east-1.pooler.supabase.com", "aws-1-sa-east-1.pooler.supabase.com"];
const ROLES = [
  { key: "CLOUD_DATABASE_URL", login: "iaris_app", role: "legacy_app" },
  { key: "CLOUD_RELAY_DATABASE_URL", login: "iaris_relay", role: "legacy_relay" },
] as const;

/** SSL obrigatório; a biblioteca pg segue a semântica do libpq (criptografa a conexão). */
const SSL = "sslmode=require&uselibpqcompat=true";
const poolerUrl = (host: string, user: string, ref: string, password: string) =>
  `postgres://${user}.${ref}:${encodeURIComponent(password)}@${host}:5432/postgres?${SSL}`;

function vault() {
  const path = defaultSecretsPath();
  const store = openSecretsFile(path);
  if (!path || !store) throw new Error("cofre não encontrado (C:\\IARIS\\cofre\\segredos.env)");
  return { path, store };
}

async function tryConnect(url: string): Promise<string | null> {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15000 });
  try {
    await c.connect();
    await c.query("SELECT 1");
    return null;
  } catch (e) {
    return (e as Error).message;
  } finally {
    await c.end().catch(() => undefined);
  }
}

async function setup(ref: string) {
  if (!/^[a-z0-9]{10,40}$/.test(ref)) throw new Error("informe o ID do projeto Supabase (ref)");
  const { path, store } = vault();
  const password = store.require("SUPABASE_DB_PASSWORD");

  let admin: string | null = null;
  let host = "";
  for (const h of POOLER_HOSTS) {
    const url = poolerUrl(h, "postgres", ref, password);
    const err = await tryConnect(url);
    console.log(`${err ? "✗" : "✓"} conexão ${h}${err ? ` — ${err}` : ""}`);
    if (!err) {
      admin = url;
      host = h;
      break;
    }
  }
  if (!admin) throw new Error("não conectou ao banco em nuvem; confira a senha no cofre e o ID do projeto");

  await migrate(admin, (m) => console.log(m));

  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  const urls: Record<string, string> = { CLOUD_ADMIN_DATABASE_URL: admin };
  try {
    for (const r of ROLES) {
      const pw = randomBytes(24).toString("base64url");
      const exists = await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [r.login]);
      const verb = exists.rowCount ? "ALTER" : "CREATE";
      await c.query(
        `${verb} ROLE ${c.escapeIdentifier(r.login)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${c.escapeLiteral(pw)}`,
      );
      await c.query(`GRANT ${r.role} TO ${c.escapeIdentifier(r.login)}`);
      urls[r.key] = poolerUrl(host, r.login, ref, pw);
    }
  } finally {
    await c.end();
  }
  upsertSecrets(path, urls);
  console.log("✓ logins iaris_app e iaris_relay criados; URLs gravadas no cofre");
  await check();
}

async function check() {
  const { store } = vault();
  let ok = true;
  for (const key of ["CLOUD_ADMIN_DATABASE_URL", "CLOUD_DATABASE_URL", "CLOUD_RELAY_DATABASE_URL"]) {
    const err = store.has(key) ? await tryConnect(store.require(key)) : "não está no cofre";
    console.log(`${err ? "✗" : "✓"} ${key}${err ? ` — ${err}` : ""}`);
    ok &&= !err;
  }
  if (!ok) process.exitCode = 1;
}

/** Conta linhas de todas as tabelas do schema public (rodando como dono/superusuário). */
const COUNT_SQL = `SELECT c.relname AS t,
  (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text AS n
  FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
  WHERE s.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> 'schema_migrations'
  ORDER BY 1`;

function run(cmd: string, args: string[], input: string | null, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `${cmd} saiu com código ${code}`))));
    p.stdin.end(input ?? "");
  });
}

const localPsql = (sql: string) =>
  run("docker", ["exec", "-i", LOCAL_CONTAINER, "sh", "-c", `psql -U "$POSTGRES_USER" -d ${LOCAL_DB} -At -F '|' -v ON_ERROR_STOP=1`], sql);

async function copy() {
  const { store } = vault();
  const admin = store.require("CLOUD_ADMIN_DATABASE_URL");
  const cloud = new pg.Client({ connectionString: admin });
  await cloud.connect();
  try {
    const has = await cloud.query("SELECT (SELECT count(*) FROM tenant)::int AS n");
    if (has.rows[0].n > 0) throw new Error("o banco em nuvem já tem dados; a cópia só roda em banco vazio");

    // psql (libpq) não conhece uselibpqcompat; a URL vai por variável de ambiente, nunca na linha de comando.
    const env = { ...process.env, CLOUDURL: admin.replace("&uselibpqcompat=true", "") };
    const script =
      `{ echo "SET session_replication_role = replica;"; ` +
      `pg_dump -U "$POSTGRES_USER" -d ${LOCAL_DB} --data-only --no-owner --no-privileges --exclude-table=schema_migrations; } ` +
      `| psql -q -v ON_ERROR_STOP=1 --single-transaction "$CLOUDURL"`;
    console.log("copiando dados…");
    await run("docker", ["exec", "-i", "-e", "CLOUDURL", LOCAL_CONTAINER, "sh", "-c", script], null, env);

    const local = new Map(
      (await localPsql(COUNT_SQL + ";"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split("|") as [string, string]),
    );
    const remote = new Map((await cloud.query<{ t: string; n: string }>(COUNT_SQL)).rows.map((r) => [r.t, r.n]));
    let diff = 0;
    let rows = 0;
    for (const [t, n] of local) {
      rows += Number(n);
      if (remote.get(t) !== n) {
        diff++;
        console.log(`✗ ${t}: local ${n}, nuvem ${remote.get(t) ?? "não existe"}`);
      }
    }
    console.log(`${diff ? "✗" : "✓"} ${local.size} tabelas, ${rows} linhas conferidas${diff ? `, ${diff} divergentes` : ""}`);

    const tenants = (await cloud.query<{ id: string }>("SELECT id FROM tenant")).rows;
    let broken = 0;
    for (const t of tenants) {
      await cloud.query("SELECT set_config('app.tenant_id', $1, false)", [t.id]);
      const r = await cloud.query<{ b: string | null }>("SELECT audit_verify_chain($1) AS b", [t.id]);
      if (r.rows[0]!.b !== null) broken++;
    }
    console.log(`${broken ? "✗" : "✓"} cadeia da auditoria íntegra em ${tenants.length - broken} de ${tenants.length} escritórios`);
    if (diff || broken) process.exitCode = 1;
  } finally {
    await cloud.end();
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "setup") await setup(arg ?? "");
else if (cmd === "copy") await copy();
else if (cmd === "check") await check();
else console.log("uso: pnpm cloud:db setup <ref> | copy | check");
