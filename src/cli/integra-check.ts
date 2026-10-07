import { checkVault, serproFromVault } from "../integrations/integra-contador/from-vault.js";
import { formatCnpj } from "../shared/br/documents.js";
import { isMain } from "../shared/is-main.js";
import { defaultSecretsPath, openSecretsFile } from "../shared/secrets/secrets-file.js";

/**
 * Confere o cofre e a conexão com o SERPRO, sem exibir nenhum segredo.
 * Uso: pnpm integra:check            (cofre + certificado + autenticação, não bilhetado)
 *      pnpm integra:check <cnpj>     (+ consulta de procuração, bilhetada)
 */
if (isMain(import.meta.url)) {
  const [cnpj] = process.argv.slice(2);
  try {
    const store = openSecretsFile();
    if (!store) throw new Error(`Cofre não encontrado em ${defaultSecretsPath() ?? "(defina IARES_SECRETS_FILE)"}`);

    const v = checkVault(store);
    console.log(`Cofre: ${v.location}`);
    for (const [k, ok] of Object.entries(v.fields)) console.log(`  ${ok ? "✓" : "✗"} ${k}${ok ? "" : " (vazio)"}`);
    console.log(`  ${v.certificateFileFound ? "✓" : "✗"} arquivo do certificado encontrado`);
    console.log(`  ${v.certificateOpened ? "✓" : "✗"} certificado abriu com a senha${v.certificateError ? ` — ${v.certificateError}` : ""}`);
    if (v.certificate) {
      console.log(`  Titular: ${v.certificate.subject}`);
      console.log(`  Validade: ${v.certificate.validFrom} a ${v.certificate.validTo}${v.certificate.expired ? " (VENCIDO)" : ""}`);
    }
    if (Object.values(v.fields).some((ok) => !ok) || !v.certificateOpened) {
      throw new Error("Cofre incompleto: corrija os itens marcados com ✗");
    }

    const integra = serproFromVault(store);
    const auth = await integra.authenticate();
    console.log(`✓ Autenticado no SERPRO como ${formatCnpj(integra.office)} (token válido até ${auth.expiresAt.toISOString()})`);

    if (cnpj) {
      const r = await integra.checkPowerOfAttorney(cnpj);
      const p = r.value;
      console.log("");
      console.log(`Procuração e-CAC ${formatCnpj(p.contributor)} → ${formatCnpj(p.grantee)}: ${p.active ? "VIGENTE" : "NÃO ENCONTRADA"}`);
      for (const g of p.grants) {
        console.log(`  até ${g.validTo} · ${g.services.length} serviço(s)`);
        for (const s of g.services) console.log(`    - ${s}`);
      }
    }
  } catch (err) {
    console.error(`Falha: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
