import { config } from "../config.js";
import { readEntityNfseTaxes, refreshWithholdings, withholdingsOverview } from "../modules/fiscal/withholdings.js";
import { normalizeCnpj } from "../shared/br/documents.js";
import { createPool } from "../shared/db/pool.js";
import { withTenant } from "../shared/db/tenant-tx.js";
import { isMain } from "../shared/is-main.js";

/**
 * Agente Fiscal por comando: lê os tributos das NFS-e ainda não lidas, refaz a
 * situação das retenções e mostra o resumo. Só banco: nenhuma consulta externa.
 * Uso: pnpm fiscal:retencoes [cnpj]
 */
if (isMain(import.meta.url)) {
  const only = process.argv[2] ? normalizeCnpj(process.argv[2]) : null;
  const slug = process.env.LEGACY_TENANT ?? "contabilidade-legacy";
  const admin = createPool(config.adminDatabaseUrl(), 1);
  const app = createPool(config.databaseUrl(), 2);
  const brl = (v: string | null) => (v === null ? "—" : Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2 }));
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  try {
    const t = (await admin.query<{ id: string }>("SELECT id FROM tenant WHERE slug = $1", [slug])).rows[0];
    if (!t) throw new Error(`Escritório ${slug} não existe`);
    const ents = await withTenant(app, t.id, (tx) =>
      tx.query<{ id: string; cnpj: string; name: string }>(
        "SELECT id, cnpj, coalesce(trade_name, legal_name) AS name FROM entity WHERE cnpj IS NOT NULL AND ($1::text IS NULL OR cnpj = $1) ORDER BY 3",
        [only],
      ),
    );
    for (const e of ents.rows) {
      const r = await readEntityNfseTaxes(app, t.id, e.id);
      const w = await refreshWithholdings(app, t.id, e.id, today);
      console.log(`\n${e.name}: ${r.read} NFS-e lidas agora (${r.divergent} com total diferente da soma) · ${w.changed} situação(ões) nova(s)`);
      const o = await withTenant(app, t.id, (tx) => withholdingsOverview(tx, e.id, today));
      if (!o.dueApproved) console.log("  prazo das retenções: regra RETENCOES_FEDERAIS aguardando aprovação");
      for (const x of o.rows) {
        console.log(`  ${x.competence.slice(0, 7)} ${x.tax.padEnd(4)} retido ${brl(x.withheld).padStart(10)} | recolhido ${brl(x.paid).padStart(10)} | ${x.status}${x.responsibility === "ANTERIOR" ? " (escritório anterior)" : ""}`);
      }
      for (const m of o.taken.slice(0, 13)) {
        if (Number(m.iss) || m.divergent || m.fromSimplesProvider) {
          console.log(`  ${m.competence.slice(0, 7)} tomadas ${m.notes}: ISS retido ${brl(m.iss)}${m.divergent ? ` · ${m.divergent} a conferir` : ""}${m.fromSimplesProvider ? ` · ${m.fromSimplesProvider} de prestador do Simples com IR/CSRF retido` : ""}`);
        }
      }
    }
  } finally {
    await admin.end();
    await app.end();
  }
}
