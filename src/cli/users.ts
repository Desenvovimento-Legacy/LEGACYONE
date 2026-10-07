import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { config } from "../config.js";
import { AccessError, inviteUser, listUsers, Role, ROLE_LABEL, revokeUser } from "../platform/access/access.js";
import { parseAuthKey } from "../platform/access/crypto.js";
import type { Actor } from "../shared/actor.js";
import { createPool } from "../shared/db/pool.js";
import { isMain } from "../shared/is-main.js";
import { defaultSecretsPath, openSecretsFile } from "../shared/secrets/secrets-file.js";

/**
 * Usuários da IARIS (rodar na máquina do escritório):
 *   pnpm auth:init                                   cria a chave de login no cofre (uma vez)
 *   pnpm user:invite email "Nome" PERFIL [--mostrar]  convite de primeiro acesso (72 h)
 *   pnpm user:revoke email ["motivo"]                revoga e encerra as sessões
 *   pnpm user:list
 * PERFIL: LEITURA | OPERADOR | RESPONSAVEL_TECNICO
 * O link do convite vai para a área de transferência (Windows) e não é impresso,
 * a menos que se use --mostrar.
 */

const OPERATOR: Actor = { kind: "USER", id: process.env.USERNAME ?? process.env.USER ?? "terminal" };

function initKey() {
  const path = defaultSecretsPath();
  if (!path) throw new Error("Cofre não encontrado: defina IARIS_SECRETS_FILE");
  const vault = openSecretsFile(path);
  if (!vault) throw new Error(`Cofre não encontrado em ${path}`);
  if (vault.has("IARIS_AUTH_KEY")) {
    parseAuthKey(vault.require("IARIS_AUTH_KEY"));
    console.log("✓ IARIS_AUTH_KEY já existe no cofre (não foi alterada)");
    return;
  }
  const text = readFileSync(path, "utf8");
  const sep = text.length && !text.endsWith("\n") ? "\r\n" : "";
  appendFileSync(path, `${sep}IARIS_AUTH_KEY=${randomBytes(32).toString("base64")}\r\n`);
  console.log(`✓ IARIS_AUTH_KEY criada no cofre (${path}). Não apague: sem ela os autenticadores param de valer.`);
}

function copyToClipboard(text: string): boolean {
  if (process.platform !== "win32") return false;
  const r = spawnSync("clip", { input: text, shell: true });
  return r.status === 0;
}

async function tenantId(): Promise<string> {
  const slug = process.env.LEGACY_TENANT ?? "contabilidade-legacy";
  const admin = createPool(config.adminDatabaseUrl(), 1);
  try {
    const t = await admin.query<{ id: string }>("SELECT id FROM tenant WHERE slug = $1", [slug]);
    if (!t.rows[0]) throw new Error(`Escritório ${slug} não existe`);
    return t.rows[0].id;
  } finally {
    await admin.end();
  }
}

if (isMain(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === "init") {
      initKey();
    } else {
      const vault = openSecretsFile();
      if (!vault?.has("IARIS_AUTH_KEY")) throw new Error("Falta a chave de login no cofre. Rode antes: pnpm auth:init");
      const app = createPool(config.databaseUrl(), 2);
      const deps = { appPool: app, tenantId: await tenantId(), authKey: parseAuthKey(vault.require("IARIS_AUTH_KEY")) };
      try {
        if (cmd === "invite") {
          const show = args.includes("--mostrar");
          const [email, name, role] = args.filter((a) => a !== "--mostrar");
          const parsedRole = Role.safeParse((role ?? "").toUpperCase());
          if (!email || !name || !parsedRole.success) {
            throw new Error('Uso: pnpm user:invite email "Nome" LEITURA|OPERADOR|RESPONSAVEL_TECNICO');
          }
          const r = await inviteUser(deps, { email, name, role: parsedRole.data }, OPERATOR);
          const origin = (process.env.IARIS_PUBLIC_ORIGIN || `http://127.0.0.1:${process.env.IARIS_WEB_PORT ?? 3100}`).replace(/\/+$/, "");
          const link = `${origin}/convite#t=${r.token}`;
          console.log(`✓ ${r.created ? "Usuário criado" : "Usuário já existia"}: ${email} · perfil ${ROLE_LABEL[parsedRole.data]}`);
          console.log(`  Convite vale até ${r.expiresAt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} e só funciona uma vez.`);
          if (show) console.log(`  Link: ${link}`);
          else if (copyToClipboard(link)) console.log("  Link copiado para a área de transferência: cole (Ctrl+V) e envie à pessoa.");
          else console.log(`  Link: ${link}`);
          if (!process.env.IARIS_PUBLIC_ORIGIN) console.log("  Atenção: sem IARIS_PUBLIC_ORIGIN, o link só abre nesta máquina.");
        } else if (cmd === "revoke") {
          const [email, ...reason] = args;
          if (!email) throw new Error('Uso: pnpm user:revoke email ["motivo"]');
          const r = await revokeUser(deps, email, reason.join(" ") || "revogado pelo escritório", OPERATOR);
          console.log(`✓ Acesso de ${email} revogado; ${r.sessionsEnded} sessão(ões) encerrada(s).`);
        } else if (cmd === "list") {
          const users = await listUsers(deps);
          if (!users.length) console.log("Nenhum usuário.");
          for (const u of users) {
            const st = !u.active ? "revogado" : u.enrolled ? "ativo" : "convite pendente";
            const last = u.last_login ? u.last_login.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "nunca";
            console.log(`${u.email.padEnd(36)} ${u.name.padEnd(24)} ${(u.role ? ROLE_LABEL[u.role] : "—").padEnd(20)} ${st.padEnd(17)} último login: ${last}`);
          }
        } else {
          throw new Error("Comandos: init | invite | revoke | list");
        }
      } finally {
        await app.end();
      }
    }
  } catch (err) {
    console.error(err instanceof AccessError || err instanceof Error ? `✗ ${err.message}` : err);
    process.exitCode = 1;
  }
}
