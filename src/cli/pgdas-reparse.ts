import { config } from "../config.js";
import { pdfText } from "../integrations/integra-contador/pgdas-pdf.js";
import { reparseDeclarations } from "../modules/federal/declared-revenue.js";
import { normalizeCnpj } from "../shared/br/documents.js";
import { createPool } from "../shared/db/pool.js";
import { withTenant } from "../shared/db/tenant-tx.js";
import { isMain } from "../shared/is-main.js";

/**
 * Relê os PDFs de declaração PGDAS-D já guardados (sem consultar o SERPRO).
 * Uso: pnpm federal:reparse <cnpj> [--texto]
 *   --texto  mostra o trecho "2.1) Discriminativo de Receitas" do PDF mais recente (para ajuste do leitor)
 */
if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const cnpj = normalizeCnpj(args.find((a) => !a.startsWith("--")) ?? "");
  const slug = process.env.LEGACY_TENANT ?? "contabilidade-legacy";
  const admin = createPool(config.adminDatabaseUrl(), 1);
  const app = createPool(config.databaseUrl(), 1);
  try {
    const t = (await admin.query<{ id: string }>("SELECT id FROM tenant WHERE slug = $1", [slug])).rows[0];
    if (!t) throw new Error(`Escritório ${slug} não existe`);
    await withTenant(app, t.id, async (tx) => {
      const e = (await tx.query<{ id: string }>("SELECT id FROM entity WHERE cnpj = $1", [cnpj])).rows[0];
      if (!e) throw new Error(`Empresa ${cnpj} não encontrada`);
      if (args.includes("--texto")) {
        const p = (await tx.query<{ pdf: Buffer }>("SELECT pdf FROM pgdas_declaration_pdf WHERE entity_id = $1 AND kind = 'DECLARACAO' ORDER BY fetched_at DESC LIMIT 1", [e.id])).rows[0];
        if (!p) throw new Error("Nenhum PDF guardado");
        const txt = (await pdfText(p.pdf)).replace(/\s+/g, " ");
        const i = Math.max(0, txt.search(/RPA|Discriminativo/i));
        console.log(txt.slice(Math.max(0, i - 400), i + 700));
      }
      const r = await reparseDeclarations(tx, e.id);
      console.log(`✓ ${r.pdfs} PDF(s) relido(s); ${r.months} mês(es) novo(s) gravado(s)`);
    });
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await Promise.all([admin.end(), app.end()]);
  }
}
