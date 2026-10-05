import { config } from "../config.js";
import { serproFromVault } from "../integrations/integra-contador/from-vault.js";
import { competenceSummary, syncFederalData } from "../modules/federal/federal-sync.js";
import { formatCnpj, normalizeCnpj } from "../shared/br/documents.js";
import { createPool } from "../shared/db/pool.js";
import { withTenant } from "../shared/db/tenant-tx.js";
import { isMain } from "../shared/is-main.js";
import { openSecretsFile } from "../shared/secrets/secrets-file.js";

/**
 * Traz da Receita (Integra Contador) as declarações PGDAS-D, os DAS e os
 * pagamentos federais de uma empresa já cadastrada.
 * Uso: pnpm federal:sync <cnpj> [ano-inicial]
 *      pnpm federal:report <cnpj>     (só o relatório, sem consultar o SERPRO)
 */
const REPORT_ONLY = process.argv.includes("--report");

/** PGDAS-D vence no dia 20 do mês seguinte ao período de apuração. */
function pgdasDeadline(competence: string): string {
  const y = Number(competence.slice(0, 4));
  const m = Number(competence.slice(5, 7));
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-20`;
}
const brl = (v: string | null) =>
  v === null ? "—" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const mmYYYY = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const ddmmyyyy = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");

if (isMain(import.meta.url)) {
  const [cnpjArg, yearArg] = process.argv.slice(2).filter((a) => a !== "--report");
  if (!cnpjArg) {
    console.error("Uso: pnpm federal:sync <cnpj> [ano-inicial]");
    process.exit(1);
  }
  const slug = process.env.LEGACY_TENANT ?? "contabilidade-legacy";
  const admin = createPool(config.adminDatabaseUrl(), 1);
  const app = createPool(config.databaseUrl(), 4);
  try {

    const t = await admin.query<{ id: string }>("SELECT id FROM tenant WHERE slug = $1", [slug]);
    const tenantId = t.rows[0]?.id;
    if (!tenantId) throw new Error(`Escritório ${slug} não existe`);
    const cnpj = normalizeCnpj(cnpjArg);
    const ent = await withTenant(app, tenantId, (tx) =>
      tx.query<{ id: string; legal_name: string }>("SELECT id, legal_name FROM entity WHERE cnpj = $1", [cnpj]),
    );
    const entity = ent.rows[0];
    if (!entity) throw new Error(`Empresa ${formatCnpj(cnpj)} não cadastrada: rode pnpm onboard ${cnpj}`);
    const caseRow = await withTenant(app, tenantId, (tx) =>
      tx.query<{ id: string }>(
        `SELECT id FROM "case" WHERE entity_id = $1 AND type = 'CLIENT_ONBOARDING' ORDER BY created_at DESC LIMIT 1`,
        [entity.id],
      ),
    );

    console.log(`${entity.legal_name} — ${formatCnpj(cnpj)}`);
    if (!REPORT_ONLY) {
      const vault = openSecretsFile();
      if (!vault) throw new Error("Cofre não encontrado: rode pnpm integra:check");
      const integra = serproFromVault(vault);
      const r = await syncFederalData({ appPool: app, integra }, tenantId, {
        entityId: entity.id,
        fromYear: yearArg ? Number(yearArg) : undefined,
        caseId: caseRow.rows[0]?.id ?? null,
      });
      console.log(`Consultas ao SERPRO: ${r.calls}`);
      console.log("");
      console.log("PGDAS-D por ano:");
      for (const y of r.years) {
        console.log(`  ${y.year}: ${y.declarations} declaração(ões), ${y.das} DAS (${y.newDeclarations + y.newDas} novos)`);
      }
      console.log(
        `Pagamentos federais ${ddmmyyyy(r.payments.from)} a ${ddmmyyyy(r.payments.to)}: ${r.payments.total} (${r.payments.created} novos)`,
      );
    }

    await withTenant(app, tenantId, async (tx) => {
      const from = `${new Date().getFullYear() - 1}-01-01`;
      const rows = await competenceSummary(tx, entity.id, from);
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
      console.log("");
      console.log("Simples Nacional por competência (desde " + mmYYYY(from) + "):");
      console.log("  PA       Declaração          DAS   Pago no PGDAS  Pagamento identificado (PagtoWeb)");
      for (const c of rows) {
        const deadline = pgdasDeadline(c.competence);
        const dec = c.declarations
          ? `${c.declarations - c.rectifications} orig + ${c.rectifications} ret`
          : today <= deadline
            ? `a declarar até ${ddmmyyyy(deadline).slice(0, 5)}`
            : "NÃO DECLARADO";
        const paidFlag = c.das === 0 ? "—" : c.dasPaidFlag === true ? "sim" : c.dasPaidFlag === false ? "não" : "?";
        const pay = c.dasPayments
          ? `${brl(c.dasPaidAmount)} em ${ddmmyyyy(c.dasPaidOn)}${c.dasPayments > 1 ? ` (${c.dasPayments} guias)` : ""}`
          : c.das === 0
            ? "sem DAS emitido"
            : "PAGAMENTO AINDA NÃO IDENTIFICADO";
        console.log(`  ${mmYYYY(c.competence)}  ${dec.padEnd(18)}  ${String(c.das).padStart(3)}   ${paidFlag.padEnd(13)}  ${pay}${c.malha ? ` · malha: ${c.malha}` : ""}`);
      }

      const other = await tx.query<{ doc: string | null; code: string | null; descr: string | null; n: number; total: string }>(
        `SELECT document_type AS doc, revenue_code AS code, max(revenue_description) AS descr,
                count(*)::int AS n, sum(amount_total)::text AS total
           FROM federal_payment
          WHERE entity_id = $1 AND collected_on >= $2
            AND NOT (coalesce(document_type_code, '') = '9' OR coalesce(document_type, '') ILIKE '%SIMPLES NACIONAL%')
          GROUP BY 1, 2 ORDER BY 1, 2`,
        [entity.id, from],
      );
      if (other.rows.length) {
        console.log("");
        console.log("Outros pagamentos federais (desde " + mmYYYY(from) + "):");
        for (const o of other.rows) {
          console.log(`  ${o.doc ?? "?"} receita ${o.code ?? "?"} ${o.descr ?? ""}: ${o.n} pagamento(s), ${brl(o.total)}`);
        }
      }
    });
  } catch (err) {
    console.error(`Falha: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await Promise.all([admin.end(), app.end()]);
  }
}
