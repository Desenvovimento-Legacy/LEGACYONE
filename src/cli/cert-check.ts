import { config } from "../config.js";
import { clientCertificatesDir, clientPasswordKey, syncClientCertificates } from "../platform/identity/client-certificates.js";
import type { Actor } from "../shared/actor.js";
import { createPool } from "../shared/db/pool.js";
import { isMain } from "../shared/is-main.js";
import { openSecretsFile } from "../shared/secrets/secrets-file.js";

/**
 * Confere os certificados A1 dos clientes no cofre local e registra os válidos.
 * Uso: pnpm cert:check
 * Não mostra senha nem conteúdo do certificado; não consulta órgão externo.
 */
if (isMain(import.meta.url)) {
  const vault = openSecretsFile();
  if (!vault) {
    console.error("✗ Cofre não encontrado (C:\\AIRES-COFRE\\segredos.env)");
    process.exit(1);
  }
  const slug = process.env.LEGACY_TENANT ?? "contabilidade-legacy";
  const admin = createPool(config.adminDatabaseUrl(), 1);
  const app = createPool(config.databaseUrl(), 2);
  const actor: Actor = { kind: "USER", id: process.env.USERNAME ?? process.env.USER ?? "terminal" };
  try {
    const t = await admin.query<{ id: string }>("SELECT id FROM tenant WHERE slug = $1", [slug]);
    if (!t.rows[0]) throw new Error(`Escritório ${slug} não existe`);
    const results = await syncClientCertificates(app, t.rows[0].id, vault, actor);
    for (const r of results) {
      const mark = r.status === "OK" ? "✓" : "✗";
      const extra = r.status === "OK" ? ` · válido até ${r.validTo!.split("-").reverse().join("/")}${r.registered ? " · registrado agora" : ""}` : "";
      console.log(`${mark} ${r.name} (${r.cnpj}): ${r.message}${extra}`);
      if (r.status === "NAO_ENCONTRADO") console.log(`    coloque em ${clientCertificatesDir(vault)} (ou subpasta) um .pfx com ${r.cnpj} no nome`);
      if (r.status === "SEM_SENHA") console.log(`    adicione a linha ${clientPasswordKey(r.cnpj)}=... no segredos.env`);
    }
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await Promise.all([admin.end(), app.end()]);
  }
}
