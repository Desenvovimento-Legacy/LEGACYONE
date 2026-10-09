import type { PoolClient } from "pg";

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

/** Configuração gravada para a empresa quando o plano foi aplicado; sem ela, a embutida. */
export async function chartConfig(tx: PoolClient, entityId: string): Promise<ChartConfig> {
  const r = await tx.query<{ config: ChartConfig }>(
    "SELECT config FROM chart_layout WHERE entity_id = $1 ORDER BY valid_from DESC, created_at DESC LIMIT 1",
    [entityId],
  );
  return r.rows[0]?.config ?? BUILTIN_CONFIG;
}

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
