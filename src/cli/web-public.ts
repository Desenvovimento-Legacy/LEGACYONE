import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "../shared/is-main.js";

/**
 * Abre a IARIS com um endereço público HTTPS (túnel rápido da Cloudflare, sem
 * conta) para quem está fora deste computador. Todo acesso continua exigindo
 * login com senha e autenticador; a tela segue escutando só em 127.0.0.1.
 *
 * O endereço muda a cada vez que este comando é iniciado: convites gerados
 * antes deixam de abrir. Uso: pnpm web:publico
 */

const CANDIDATES = [
  process.env.CLOUDFLARED,
  "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
  "C:\\Program Files\\cloudflared\\cloudflared.exe",
].filter((p): p is string => Boolean(p));

function cloudflaredPath(): string {
  return CANDIDATES.find((p) => existsSync(p)) ?? "cloudflared";
}

if (isMain(import.meta.url)) {
  const port = process.env.IARIS_WEB_PORT ?? "3100";
  const children: ChildProcess[] = [];
  const stop = () => {
    for (const c of children) c.kill();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const tunnel = spawn(cloudflaredPath(), ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(tunnel);
  let started = false;
  const onOutput = (chunk: Buffer) => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk.toString());
    if (!m || started) return;
    started = true;
    const origin = m[0];
    try {
      writeFileSync(join(process.cwd(), "..", "endereco-publico.txt"), `${origin}\r\n`);
    } catch {
      // só informativo
    }
    console.log(`\nEndereço público: ${origin}`);
    console.log("Mande convites pela tela Usuários e acessos: o link já sai com este endereço.");
    console.log("Ao fechar esta janela, o endereço deixa de funcionar.\n");
    const web = spawn(process.execPath, ["--import", "tsx", "--env-file-if-exists=.env", "src/web/server.ts"], {
      stdio: "inherit",
      env: { ...process.env, IARIS_PUBLIC_ORIGIN: origin },
    });
    children.push(web);
    web.on("exit", (code) => {
      tunnel.kill();
      process.exit(code ?? 0);
    });
  };
  tunnel.stdout?.on("data", onOutput);
  tunnel.stderr?.on("data", onOutput);
  tunnel.on("exit", (code) => {
    if (!started) console.error(`✗ Não consegui abrir o túnel (cloudflared saiu com código ${code}). Confira a internet e se o cloudflared está instalado.`);
    else console.error("✗ O túnel caiu: o endereço público parou. Rode pnpm web:publico de novo.");
    for (const c of children) c.kill();
    process.exit(1);
  });
  setTimeout(() => {
    if (!started) console.log("Abrindo o túnel… (pode levar até 30 segundos)");
  }, 5000);
}
