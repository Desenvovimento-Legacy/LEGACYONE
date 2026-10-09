import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { audit } from "../../platform/audit/audit.js";
import { appendEvent, type Producer } from "../../platform/events/outbox.js";
import type { Actor } from "../../shared/actor.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";
import { normalize } from "../../shared/text.js";
import { ROLES, SERVICE_KEYS, type ChartConfig, type DreGroup, type Role, type ServiceKey } from "./chart-config.js";
import { LedgerError } from "./ledger.js";
import type { Nature } from "./standard-chart.js";

/**
 * Plano de contas padrão do escritório (modelo). Importado do relatório
 * "Plano de Contas" exportado do Domínio (salvo em CSV): código reduzido,
 * T (S = sintética), classificação e nome. Cada empresa nova recebe uma cópia.
 *
 * As contas que os lançamentos automáticos usam (clientes, fornecedores,
 * receita, tributos, despesa por tipo de serviço) e os grupos da DRE são
 * localizados pelo NOME no modelo, de forma determinística: nome exato,
 * opcionalmente debaixo de uma sintética. Nome que não aparece ou aparece em
 * duas contas fica sem conta (e a IARIS avisa), nunca é adivinhado.
 */

const PRODUCER: Producer = { kind: "engine", name: "ledger", version: "0.1.0" };

export interface TemplateAccount { code: string; shortCode: string | null; name: string; analytic: boolean; nature: Nature; parentCode: string | null }

/** Lê o CSV do relatório do Domínio (Excel → CSV, separador vírgula ou ponto e vírgula). */
export function parseDominioChart(text: string): TemplateAccount[] {
  const lines = text.split(/\r?\n/);
  const sep = (lines.find((l) => /^\d+[;,]/.test(l)) ?? ",").includes(";") ? ";" : ",";
  const out: TemplateAccount[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const cols = splitCsv(line, sep);
    if (!/^\d+$/.test((cols[0] ?? "").trim())) continue;
    const codeIdx = cols.findIndex((c, i) => i > 0 && /^\d+(\.\d+)*$/.test(c.trim()));
    const code = codeIdx > 0 ? cols[codeIdx]!.trim() : null;
    if (!code || seen.has(code)) continue;
    const name = cols.slice(codeIdx + 1).map((c) => c.trim()).find((c) => c && !/^\d+$/.test(c));
    if (!name) continue;
    const synthetic = cols.slice(1, codeIdx).some((c) => c.trim().toUpperCase() === "S");
    seen.add(code);
    out.push({ code, shortCode: cols[0]!.trim(), name: name.slice(0, 200), analytic: !synthetic, nature: natureOf(code), parentCode: code.includes(".") ? code.slice(0, code.lastIndexOf(".")) : null });
  }
  return out;
}

function splitCsv(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
    } else if (ch === sep && !q) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function natureOf(code: string): Nature {
  if (code === "1" || code.startsWith("1.")) return "ATIVO";
  if (code === "2.3" || code.startsWith("2.3.")) return "PATRIMONIO_LIQUIDO";
  if (code === "2" || code.startsWith("2.")) return "PASSIVO";
  if (code === "3" || code.startsWith("3.")) return "RECEITA";
  if (code === "4.1" || code.startsWith("4.1.")) return "CUSTO";
  if (code === "4" || code.startsWith("4.")) return "DESPESA";
  return "APURACAO";
}

// ------------------------------------------------------------------ localização das contas por nome

interface Spec { name: string; analytic?: boolean; under?: string }
const ROLE_SPECS: Record<Role, Spec> = {
  CLIENTES: { name: "CLIENTES", analytic: true, under: "ATIVO CIRCULANTE" },
  FORNECEDORES: { name: "FORNECEDORES", analytic: true, under: "PASSIVO CIRCULANTE" },
  RECEITA_SERVICOS: { name: "SERVICOS PRESTADOS", analytic: true },
  SIMPLES_DEDUCAO: { name: "(-) SIMPLES NACIONAL", analytic: true },
  SIMPLES_RECOLHER: { name: "SIMPLES NACIONAL A RECOLHER", analytic: true },
  IRRF_RET_RECOLHER: { name: "IRRF A RECOLHER", analytic: true },
  CSRF_RET_RECOLHER: { name: "CRF A RECOLHER", analytic: true },
  ISS_RET_RECOLHER: { name: "ISS RETIDO A RECOLHER", analytic: true },
  INSS_RET_RECOLHER: { name: "INSS RETIDO A RECOLHER", analytic: true },
  IRRF_RECUPERAR: { name: "IRRF A RECUPERAR", analytic: true },
  CSRF_RECUPERAR: { name: "TRIBUTOS FEDERAIS A COMPENSAR (DCTF WEB)", analytic: true },
  INSS_RECUPERAR: { name: "INSS A COMPENSAR", analytic: true },
  ISS_RETIDO_DEDUCAO: { name: "(-) ISS", analytic: true },
  BANCOS: { name: "BANCOS CONTA MOVIMENTO", analytic: false },
  IRRF_FOLHA_RECOLHER: { name: "IRRF A RECOLHER", analytic: true },
  INSS_RECOLHER: { name: "INSS A RECOLHER", analytic: true, under: "OBRIGACOES SOCIAIS" },
  JUROS_MORA: { name: "JUROS DE MORA", analytic: true, under: "DESPESAS FINANCEIRAS" },
  MULTA_MORA: { name: "MULTAS DE MORA", analytic: true, under: "DESPESAS FINANCEIRAS" },
};
const PJ = "SERVICOS TOMADOS DE PJ";
const SERVICE_SPECS: Record<ServiceKey, Spec> = {
  INFORMATICA: { name: "SERVS. MANUTENCAO DE INFORMATICA", under: PJ },
  CONSULTORIA: { name: "SERVS. DE ASSESSORIA E CONSULTORIA", under: PJ },
  LOCACAO: { name: "ALUGUEIS DE MAQUINAS E EQUIPAMENTOS", under: "DESPESAS ADMINISTRATIVAS" },
  ENGENHARIA: { name: "SERVS. ENGENHARIA", under: PJ },
  LIMPEZA: { name: "SERVICOS DE LIMPEZA E CONSERVACAO", under: PJ },
  VIGILANCIA: { name: "SERVS. SISTEMAS E MONITORAMENTO", under: PJ },
  REPROGRAFIA: { name: "SERVS. XEROX, PLASTIFICACAO, ENCADERNACAO", under: PJ },
  MANUTENCAO: { name: "SERVS. DE MANUTENCAO E REPARO", under: PJ },
  BANCARIOS: { name: "TARIFA BANCARIA", under: "DESPESAS FINANCEIRAS" },
  TRANSPORTE: { name: "SERVS. DE TRANSPORTE", under: PJ },
  ADMINISTRATIVOS: { name: "SERVS. ADMINISTRATIVOS", under: PJ },
  MAO_DE_OBRA: { name: "SERVICOS PRESTADOS POR TERCEIROS", under: PJ },
  PUBLICIDADE: { name: "SERVS. DE PUBLICIDADE E PROPAGANDA", under: PJ },
  ADVOCACIA: { name: "SERVS. ADVOCATICIOS", under: PJ },
  AUDITORIA: { name: "SERVS. AUDITORIA", under: PJ },
  CONTABILIDADE: { name: "SERVS. DE CONTABILIDADE", under: PJ },
  PLANO_SAUDE: { name: "ASSISTENCIA MEDICA E SOCIAL", under: "DESPESAS ADMINISTRATIVAS" },
  SAUDE: { name: "SERVS. MEDICINAIS", under: PJ },
  TREINAMENTO: { name: "SERVS. ENSINO DE IDIOMAS/TREINAMENTO", under: PJ },
  COURIER: { name: "SERVS. DE MOTOBOY", under: PJ },
  ADUANEIRO: { name: "SERVS. DE ASSESSORIA ADUANEIRA", under: PJ },
  CORRETAGEM: { name: "SERVS. AGENCIAMENTO E CORRETAGEM", under: PJ },
  TERCEIROS: { name: "SERVICOS PRESTADOS POR TERCEIROS", under: PJ },
};
const DRE_SPECS: { key: string; label: string; include: string[]; exclude?: string[] }[] = [
  { key: "rb", label: "Receita bruta", include: ["RECEITA BRUTA DE VENDAS E SERVICOS"] },
  { key: "ded", label: "(−) Deduções da receita", include: ["(-) DEDUCOES DA RECEITA BRUTA"] },
  { key: "cost", label: "(−) Custos", include: ["CUSTOS"] },
  { key: "vendas", label: "(−) Despesas com vendas", include: ["DESPESAS COM VENDAS"] },
  { key: "adm", label: "(−) Despesas administrativas", include: ["DESPESAS ADMINISTRATIVAS"], exclude: ["IMPOSTOS, TAXAS E CONTRIBUICOES", "DESPESAS FINANCEIRAS"] },
  { key: "trib", label: "(−) Despesas tributárias", include: ["IMPOSTOS, TAXAS E CONTRIBUICOES"] },
  { key: "fin", label: "(+/−) Resultado financeiro", include: ["RECEITAS FINANCEIRAS", "DESPESAS FINANCEIRAS"] },
  { key: "outras", label: "(+) Outras receitas operacionais", include: ["RECUPERACAO DE DESPESAS", "OUTRAS RECEITAS OPERACIONAIS"] },
  { key: "naoop", label: "(+/−) Resultado não operacional", include: ["RECEITAS NAO OPERACIONAIS", "DESPESAS NAO OPERACIONAIS"], exclude: ["PROVISAO DE IRPJ E CSLL"] },
  { key: "ircs", label: "(−) IRPJ e CSLL", include: ["PROVISAO DE IRPJ E CSLL"] },
];

/** Localiza as contas pelo nome. Devolve a configuração e o que não foi achado (ou achado em dobro). */
export function resolveConfig(accounts: TemplateAccount[], template: string): { config: ChartConfig; unresolved: string[] } {
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const ancestors = (a: TemplateAccount): string[] => {
    const out: string[] = [];
    let p = a.parentCode;
    while (p) { const x = byCode.get(p); if (!x) break; out.push(normalize(x.name)); p = x.parentCode; }
    return out;
  };
  const unresolved: string[] = [];
  const find = (label: string, s: Spec): string | null => {
    const hits = accounts.filter((a) => normalize(a.name) === normalize(s.name) && (s.analytic === undefined || a.analytic === s.analytic) && (!s.under || ancestors(a).includes(normalize(s.under))));
    if (hits.length === 1) return hits[0]!.code;
    unresolved.push(`${label}: "${s.name}"${s.under ? ` em "${s.under}"` : ""} ${hits.length ? `aparece ${hits.length} vezes` : "não encontrada"}`);
    return null;
  };
  const roles: ChartConfig["roles"] = {};
  for (const r of ROLES) { const c = find(r, ROLE_SPECS[r]); if (c) roles[r] = c; }
  const services: ChartConfig["services"] = {};
  for (const k of SERVICE_KEYS) { const c = find(`serviço ${k}`, { analytic: true, ...SERVICE_SPECS[k] }); if (c) services[k] = c; }
  const dre: DreGroup[] = [];
  for (const g of DRE_SPECS) {
    const inc = g.include.map((n) => find(`DRE ${g.key}`, { name: n, analytic: false })).filter((x): x is string => Boolean(x));
    const exc = (g.exclude ?? []).map((n) => find(`DRE ${g.key} (exceto)`, { name: n, analytic: false })).filter((x): x is string => Boolean(x));
    if (inc.length) dre.push({ key: g.key, label: g.label, include: inc, ...(exc.length ? { exclude: exc } : {}) });
  }
  return { config: { template, roles, services, dre }, unresolved };
}

// ------------------------------------------------------------------ importação

export async function importChartTemplate(pool: Pool, tenantId: string, input: { name: string; fileName: string; bytes: Buffer }, actor: Actor) {
  if (actor.kind !== "USER") throw new LedgerError("Plano padrão do escritório é decisão de uma pessoa");
  const text = new TextDecoder(isUtf8(input.bytes) ? "utf-8" : "windows-1252").decode(input.bytes);
  const accounts = parseDominioChart(text);
  if (accounts.length < 20) throw new LedgerError("Arquivo não parece o relatório de plano de contas (menos de 20 contas lidas)");
  for (const a of accounts) if (a.parentCode && !accounts.some((x) => x.code === a.parentCode)) throw new LedgerError(`Conta ${a.code} sem a sintética ${a.parentCode} no arquivo`);
  const sha = createHash("sha256").update(input.bytes).digest();
  const id = newId();
  const { config, unresolved } = resolveConfig(accounts, `ESCRITORIO:${id}`);
  await withTenant(pool, tenantId, async (tx) => {
    await tx.query(
      `INSERT INTO chart_template (id, tenant_id, name, file_name, sha256, accounts, config, unresolved, imported_by)
       VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8)`,
      [id, input.name.slice(0, 120), input.fileName.slice(0, 200), sha, accounts.length, JSON.stringify(config), JSON.stringify(unresolved), actor.id],
    );
    for (const a of accounts) {
      await tx.query(
        `INSERT INTO chart_template_account (id, tenant_id, template_id, code, short_code, name, nature, analytic, parent_code)
         VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8)`,
        [newId(), id, a.code, a.shortCode, a.name, a.nature, a.analytic, a.parentCode],
      );
    }
    await appendEvent(tx, {
      type: "CHART_TEMPLATE_IMPORTED", schemaVersion: 1, producer: PRODUCER, idempotencyKey: `modelo-plano:${id}`,
      payload: { template_id: id, name: input.name, accounts: accounts.length, unresolved: unresolved.length },
    });
    await audit(tx, { actor, action: "ledger.chart_template_imported", resourceType: "chart_template", resourceId: id,
      data: { name: input.name, file: input.fileName, accounts: accounts.length, sha256: sha.toString("hex"), unresolved } });
  });
  return { id, accounts: accounts.length, analytic: accounts.filter((a) => a.analytic).length, roles: config.roles, unresolved };
}

function isUtf8(b: Buffer): boolean {
  try { new TextDecoder("utf-8", { fatal: true }).decode(b); return true; } catch { return false; }
}

/** Modelo vigente do escritório (o último importado); nulo = usa o plano embutido. */
export async function activeTemplate(tx: PoolClient) {
  const r = await tx.query<{ id: string; name: string; config: ChartConfig; imported_at: Date; accounts: number; unresolved: string[] }>(
    "SELECT id, name, config, imported_at, accounts, unresolved FROM chart_template ORDER BY imported_at DESC LIMIT 1",
  );
  return r.rows[0] ?? null;
}
