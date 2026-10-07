import { config } from "../config.js";
import { simulateSimples } from "../modules/tax/simples/apuracao.js";
import { normalizeCnpj } from "../shared/br/documents.js";
import { createPool } from "../shared/db/pool.js";
import { withTenant } from "../shared/db/tenant-tx.js";
import { isMain } from "../shared/is-main.js";

/**
 * Simula o motor do Simples com as tabelas PROPOSTAS, antes da aprovação.
 * Só leitura: não grava cálculo, não emite evento, não consulta órgão externo.
 * Uso: pnpm simples:simular <cnpj>
 */
if (isMain(import.meta.url)) {
  const cnpj = normalizeCnpj(process.argv[2] ?? "");
  const slug = process.env.LEGACY_TENANT ?? "contabilidade-legacy";
  const admin = createPool(config.adminDatabaseUrl(), 1);
  const app = createPool(config.databaseUrl(), 1);
  const brl = (v: string | null) => (v === null ? "—" : Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2 }));
  try {
    const t = (await admin.query<{ id: string }>("SELECT id FROM tenant WHERE slug = $1", [slug])).rows[0];
    if (!t) throw new Error(`Escritório ${slug} não existe`);
    await withTenant(app, t.id, async (tx) => {
      const e = (await tx.query<{ id: string }>("SELECT id FROM entity WHERE cnpj = $1", [cnpj])).rows[0];
      if (!e) throw new Error(`Empresa ${cnpj} não encontrada`);
      for (const c of await simulateSimples(tx, e.id)) {
        const r = c.result && c.result.ok ? c.result : null;
        const line = [
          c.competence.slice(0, 7),
          c.mode === "APURACAO" ? "apuração" : "conferência",
          `RBT12 ${brl(String(c.inputs.rbt12 ?? null))}`,
          r ? `faixa ${r.bracket}` : "",
          `calculado ${brl(c.total)}`,
          c.reference ? `${c.reference.kind === "DECLARACAO" ? "declarado" : "DAS pago"} ${brl(c.reference.total)}` : "",
          c.difference !== null ? `dif ${brl(c.difference)}` : "",
          c.status,
          Object.keys(c.taxDifferences).length ? JSON.stringify(c.taxDifferences) : "",
          c.reason ?? "",
        ].filter(Boolean);
        console.log(line.join(" | "));
      }
    });
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await Promise.all([admin.end(), app.end()]);
  }
}
