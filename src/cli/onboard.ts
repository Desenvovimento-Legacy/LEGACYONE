import { config } from "../config.js";
import { BrasilApiCnpjSource } from "../integrations/cnpj-public/brasilapi.js";
import { CnpjaOpenSource } from "../integrations/cnpj-public/cnpja.js";
import { FallbackCnpjSource } from "../integrations/cnpj-public/fallback.js";
import { serproFromVault } from "../integrations/integra-contador/from-vault.js";
import { onboardByCnpj } from "../modules/onboarding/onboarding.js";
import { formatCnpj } from "../shared/br/documents.js";
import { createPool } from "../shared/db/pool.js";
import { isMain } from "../shared/is-main.js";
import { openSecretsFile } from "../shared/secrets/secrets-file.js";

/**
 * Onboarding pelo CNPJ. Uso: pnpm onboard <cnpj> [slug-do-escritorio]
 * O escritório padrão vem de LEGACY_TENANT (ou "contabilidade-legacy").
 */
if (isMain(import.meta.url)) {
  const [cnpj, slugArg] = process.argv.slice(2);
  if (!cnpj) {
    console.error("Uso: pnpm onboard <cnpj> [slug-do-escritorio]");
    process.exit(1);
  }
  const slug = slugArg ?? process.env.LEGACY_TENANT ?? "contabilidade-legacy";
  const admin = createPool(config.adminDatabaseUrl(), 1);
  const app = createPool(config.databaseUrl(), 4);
  try {
    // Resolver o escritório pelo slug é operação de plataforma.
    const t = await admin.query<{ id: string }>("SELECT id FROM tenant WHERE slug = $1", [slug]);
    const tenantId = t.rows[0]?.id;
    if (!tenantId) throw new Error(`Escritório ${slug} não existe. Crie com: pnpm tenant:create "Nome" ${slug}`);

    // Integra Contador real quando o cofre existir; sem cofre, a verificação vira pendência.
    const vault = openSecretsFile();
    const integra = vault ? serproFromVault(vault) : null;
    console.log(integra ? `Integra Contador: SERPRO (escritório ${formatCnpj(integra.office)})` : "Integra Contador: não configurado");

    const r = await onboardByCnpj(
      {
        appPool: app,
        publicData: new FallbackCnpjSource([new BrasilApiCnpjSource(undefined, 2), new CnpjaOpenSource()], (m) =>
          console.log(`  aviso: ${m}`),
        ),
        integra,
      },
      tenantId,
      { cnpj, requester: process.env.USERNAME ?? process.env.USER ?? "cli", origin: "cli" },
    );

    const p = r.profile;
    console.log("");
    console.log(`Case CLIENT_ONBOARDING ${r.caseId}`);
    console.log(`Status: ${r.caseStatus}${r.entityCreated ? " (entidade criada)" : ""}`);
    if (r.profileSource) console.log(`Fonte: ${r.profileSource}`);
    if (p) {
      console.log("");
      console.log(`${p.legalName} — ${formatCnpj(p.cnpj)}`);
      console.log(`  Situação: ${p.registrationStatus} · Início de atividade: ${p.activityStartedAt ?? "?"}`);
      console.log(`  Natureza: ${p.legalNature} (${p.legalNatureCode}) · Porte: ${p.size ?? "?"}`);
      console.log(`  Local: ${p.address.municipio}/${p.address.uf} (IBGE ${p.address.municipioIbge})`);
      console.log(`  Simples: ${p.simples.optant ? `optante desde ${p.simples.since}` : "não optante"}`);
      console.log(`  CNAE principal: ${p.primaryCnae.code} ${p.primaryCnae.description}`);
      console.log(`  CNAEs secundários: ${p.secondaryCnaes.length} · Sócios: ${p.partners.length}`);
    }
    console.log("");
    console.log(r.pending.length ? "Pendências:" : "Sem pendências.");
    for (const it of r.pending) console.log(`  [${it.responsible_source}] ${it.type}: ${it.required_information}`);
  } catch (err) {
    console.error(`Falha no onboarding: ${(err as Error).message}`);
    console.error("O Case continua aberto; rode o mesmo comando de novo para retomar.");
    process.exitCode = 1;
  } finally {
    await Promise.all([admin.end(), app.end()]);
  }
}
