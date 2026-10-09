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
 * antes deixam de abrir. Se só o servidor da tela fechar (atualização do
 * sistema), ele é reaberto sozinho e o endereço continua o mesmo.
 *
 * Endereço fixo: com IARIS_TUNNEL (nome do túnel nomeado da Cloudflare) e
 * IARIS_PUBLIC_HOST (ex.: iaris.grouplegacy.com.br) no .env, usa o túnel
 * nomeado e o endereço não muda mais. A credencial do túnel fica no perfil do
 * usuário do Windows (pasta .cloudflared), fora do repositório.
 * Uso: pnpm web:publico
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
  let stopping = false;
  const stop = () => {
    stopping = true;
    for (const c of children) c.kill();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const named = process.env.IARIS_TUNNEL;
  const fixedHost = process.env.IARIS_PUBLIC_HOST;
  if (named && !fixedHost) throw new Error("IARIS_TUNNEL definido sem IARIS_PUBLIC_HOST");
  const args = named
    ? ["tunnel", "--no-autoupdate", "run", "--url", `http://127.0.0.1:${port}`, named]
    : ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`];
  const tunnel = spawn(cloudflaredPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
  children.push(tunnel);
  let started = false;
  const onOutput = (chunk: Buffer) => {
    const text = chunk.toString();
    const origin = named
      ? /Registered tunnel connection/.test(text) ? `https://${fixedHost}` : null
      : /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text)?.[0] ?? null;
    if (!origin || started) return;
    started = true;
    try {
      writeFileSync(join(process.cwd(), "..", "endereco-publico.txt"), `${origin}\r\n`);
    } catch {
      // só informativo
    }
    console.log(`\nEndereço público: ${origin}`);
    console.log("Mande convites pela tela Usuários e acessos: o link já sai com este endereço.");
    console.log("Ao fechar esta janela, o endereço deixa de funcionar.\n");
    // Servidor da tela: se fechar, reabre com o código atual mantendo o túnel (e o endereço).
    // Três quedas seguidas em menos de 20 s cada: para tudo, para não ficar em laço.
    let quickFails = 0;
    const startWeb = () => {
      const startedAt = Date.now();
      const web = spawn(process.execPath, ["--import", "tsx", "--env-file-if-exists=.env", "src/web/server.ts"], {
        stdio: "inherit",
        env: { ...process.env, IARIS_PUBLIC_ORIGIN: origin },
      });
      children.push(web);
      web.on("exit", (code) => {
        children.splice(children.indexOf(web), 1);
        if (stopping) return;
        quickFails = Date.now() - startedAt < 20_000 ? quickFails + 1 : 0;
        if (quickFails >= 3) {
          console.error(`✗ O servidor da tela fechou 3 vezes seguidas (código ${code}). Fechando o túnel.`);
          tunnel.kill();
          process.exit(code ?? 1);
        }
        console.log(`Servidor da tela fechou (código ${code}); reabrindo com o mesmo endereço…`);
        setTimeout(startWeb, 2000);
      });
    };
    startWeb();
  };
  tunnel.stdout?.on("data", onOutput);
  tunnel.stderr?.on("data", onOutput);
  tunnel.on("exit", (code) => {
    if (stopping) return;
    stopping = true;
    if (!started) console.error(`✗ Não consegui abrir o túnel (cloudflared saiu com código ${code}). Confira a internet e se o cloudflared está instalado.`);
    else console.error("✗ O túnel caiu: o endereço público parou. Rode pnpm web:publico de novo.");
    for (const c of children) c.kill();
    process.exit(1);
  });
  setTimeout(() => {
    if (!started) console.log("Abrindo o túnel… (pode levar até 30 segundos)");
  }, 5000);
}
