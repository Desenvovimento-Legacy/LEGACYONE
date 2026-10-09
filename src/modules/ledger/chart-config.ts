import type { PoolClient } from "pg";
import { normalize } from "../../shared/text.js";
import type { Nature } from "./standard-chart.js";

/**
 * Configuração do plano de contas da empresa: qual conta faz cada papel nos
 * lançamentos automáticos (clientes, fornecedores, receita, tributos...), como
 * a DRE agrupa as contas e para onde vai cada tipo de serviço tomado.
 *
 * Vem do plano padrão do escritório (modelo importado e gravado junto com o
 * plano da empresa) ou, sem modelo, do plano padrão embutido (PADRAO_LEGACY_V1).
 */

export const ROLES = [
  "CLIENTES", "FORNECEDORES", "RECEITA_SERVICOS", "SIMPLES_DEDUCAO", "SIMPLES_RECOLHER",
  "IRRF_RET_RECOLHER", "CSRF_RET_RECOLHER", "ISS_RET_RECOLHER", "INSS_RET_RECOLHER",
  "IRRF_RECUPERAR", "CSRF_RECUPERAR", "INSS_RECUPERAR", "ISS_RETIDO_DEDUCAO",
  "BANCOS", "IRRF_FOLHA_RECOLHER", "INSS_RECOLHER", "JUROS_MORA", "MULTA_MORA",
  "APLICACOES", "RECEITA_APLICACOES", "TARIFAS",
] as const;
export type Role = (typeof ROLES)[number];

/** Tipos de serviço tomado (item/subitem da LC 116) → chave de despesa; a chave vira conta pelo plano. */
export const SERVICE_KEYS = [
  "INFORMATICA", "CONSULTORIA", "LOCACAO", "ENGENHARIA", "LIMPEZA", "VIGILANCIA", "REPROGRAFIA", "MANUTENCAO", "BANCARIOS",
  "TRANSPORTE", "ADMINISTRATIVOS", "MAO_DE_OBRA", "PUBLICIDADE", "ADVOCACIA", "AUDITORIA", "CONTABILIDADE", "PLANO_SAUDE",
  "SAUDE", "TREINAMENTO", "COURIER", "ADUANEIRO", "CORRETAGEM", "TERCEIROS",
] as const;
export type ServiceKey = (typeof SERVICE_KEYS)[number];

export interface DreGroup { key: string; label: string; include: string[]; exclude?: string[] }
export interface ChartConfig {
  template: string;
  roles: Partial<Record<Role, string>>;
  services: Partial<Record<ServiceKey, string>>;
  /** Grupos da DRE (prefixos de conta), na ordem; o resultado é somado pela própria função. */
  dre: DreGroup[];
}

/** Plano embutido (PADRAO_LEGACY_V1): usado quando o escritório não importou modelo próprio. */
export const BUILTIN_CONFIG: ChartConfig = {
  template: "PADRAO_LEGACY_V1",
  roles: {
    CLIENTES: "1.1.2.01", FORNECEDORES: "2.1.1.01", RECEITA_SERVICOS: "3.1.1.01", SIMPLES_DEDUCAO: "3.2.1.01", SIMPLES_RECOLHER: "2.1.2.01",
    IRRF_RET_RECOLHER: "2.1.2.02", CSRF_RET_RECOLHER: "2.1.2.03", ISS_RET_RECOLHER: "2.1.2.04", INSS_RET_RECOLHER: "2.1.2.05",
    IRRF_RECUPERAR: "1.1.3.01", CSRF_RECUPERAR: "1.1.3.02", INSS_RECUPERAR: "1.1.3.03", ISS_RETIDO_DEDUCAO: "3.2.1.03",
    BANCOS: "1.1.1.02", IRRF_FOLHA_RECOLHER: "2.1.3.05", INSS_RECOLHER: "2.1.3.03", JUROS_MORA: "4.4.1.02", MULTA_MORA: "4.4.1.02",
    APLICACOES: "1.1.1.03", RECEITA_APLICACOES: "3.3.1.01", TARIFAS: "4.4.1.01",
  },
  services: {
    INFORMATICA: "4.3.1.09", CONSULTORIA: "4.3.1.06", LOCACAO: "4.3.1.01", ENGENHARIA: "4.3.1.12", LIMPEZA: "4.3.1.12", VIGILANCIA: "4.3.1.12",
    REPROGRAFIA: "4.3.1.07", MANUTENCAO: "4.3.1.12", BANCARIOS: "4.4.1.01", TRANSPORTE: "4.3.1.11", ADMINISTRATIVOS: "4.3.1.06",
    MAO_DE_OBRA: "4.2.1.07", PUBLICIDADE: "4.3.1.10", ADVOCACIA: "4.3.1.06", AUDITORIA: "4.3.1.05", CONTABILIDADE: "4.3.1.05",
    TREINAMENTO: "4.3.1.06", COURIER: "4.3.1.11", ADUANEIRO: "4.3.1.11", CORRETAGEM: "4.3.1.06", TERCEIROS: "4.3.1.99",
  },
  dre: [
    { key: "rb", label: "Receita bruta", include: ["3.1"] },
    { key: "ded", label: "(−) Deduções da receita", include: ["3.2"] },
    { key: "cost", label: "(−) Custos", include: ["4.1"] },
    { key: "pes", label: "(−) Despesas com pessoal", include: ["4.2"] },
    { key: "adm", label: "(−) Despesas administrativas", include: ["4.3"] },
    { key: "trib", label: "(−) Despesas tributárias", include: ["4.5"] },
    { key: "fin", label: "(+/−) Resultado financeiro", include: ["3.3", "4.4"] },
  ],
};

/**
 * Configuração do plano da empresa. Plano vindo de modelo do escritório: as
 * contas são localizadas pelo nome no próprio plano da empresa a cada uso (conta
 * nova do modelo, ou papel novo da IARIS, passa a valer sem reaplicar o plano).
 * Sem modelo: a configuração do plano embutido.
 */
export async function chartConfig(tx: PoolClient, entityId: string): Promise<ChartConfig> {
  const r = await tx.query<{ template_id: string | null; config: ChartConfig }>(
    "SELECT template_id, config FROM chart_layout WHERE entity_id = $1 ORDER BY valid_from DESC, created_at DESC LIMIT 1",
    [entityId],
  );
  const l = r.rows[0];
  if (!l) return BUILTIN_CONFIG;
  if (!l.template_id) return l.config;
  const accs = await tx.query<{ code: string; short_code: string | null; name: string; analytic: boolean; nature: Nature; parent_code: string | null }>(
    `SELECT DISTINCT ON (code) code, short_code, name, analytic, nature, parent_code FROM chart_account
      WHERE entity_id = $1 AND valid_to IS NULL ORDER BY code, valid_from DESC`,
    [entityId],
  );
  return resolveConfig(accs.rows.map((a) => ({ code: a.code, shortCode: a.short_code, name: a.name, analytic: a.analytic, nature: a.nature, parentCode: a.parent_code })), l.config.template).config;
}

export interface TemplateAccount { code: string; shortCode: string | null; name: string; analytic: boolean; nature: Nature; parentCode: string | null }


const ITEM_SERVICE: Record<string, ServiceKey> = {
  "01": "INFORMATICA", "02": "CONSULTORIA", "03": "LOCACAO", "04": "SAUDE", "07": "ENGENHARIA", "08": "TREINAMENTO", "10": "CORRETAGEM",
  "11": "VIGILANCIA", "13": "REPROGRAFIA", "14": "MANUTENCAO", "15": "BANCARIOS", "16": "TRANSPORTE", "17": "ADMINISTRATIVOS",
  "23": "PUBLICIDADE", "24": "REPROGRAFIA", "26": "COURIER", "28": "CONSULTORIA", "31": "MANUTENCAO", "32": "ENGENHARIA",
  "33": "ADUANEIRO", "35": "PUBLICIDADE", "37": "PUBLICIDADE",
};
const SUBITEM_SERVICE: Record<string, ServiceKey> = {
  "0422": "PLANO_SAUDE", "0423": "PLANO_SAUDE", "0710": "LIMPEZA", "0711": "LIMPEZA", "1401": "MANUTENCAO", "1705": "MAO_DE_OBRA",
  "1706": "PUBLICIDADE", "1714": "ADVOCACIA", "1716": "AUDITORIA", "1719": "CONTABILIDADE", "1720": "CONSULTORIA",
};

/** Chave do tipo de serviço pelo código de tributação nacional (subitem primeiro, depois item). */
export function serviceKey(nationalCode: string | null): ServiceKey | null {
  const c = (nationalCode ?? "").replace(/\D/g, "");
  if (c.length < 2) return null;
  return SUBITEM_SERVICE[c.slice(0, 4)] ?? ITEM_SERVICE[c.slice(0, 2)] ?? null;
}

export function roleAccount(cfg: ChartConfig, role: Role): string {
  const a = cfg.roles[role];
  if (!a) throw new Error(`O plano de contas (${cfg.template}) não define a conta de ${role}`);
  return a;
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
  APLICACOES: { name: "APLICACOES FINANCEIRAS LIQUIDEZ IMEDIATA", analytic: false },
  RECEITA_APLICACOES: { name: "JUROS DE APLICACOES", analytic: true },
  TARIFAS: { name: "TARIFA BANCARIA", analytic: true, under: "DESPESAS FINANCEIRAS" },
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

