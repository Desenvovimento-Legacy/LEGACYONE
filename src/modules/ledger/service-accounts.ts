import { BUILTIN_CONFIG, serviceKey, type ChartConfig, type ServiceKey } from "./chart-config.js";

/**
 * Proposta de contabilização das NFS-e tomadas: tipo de serviço (item/subitem da
 * lista da LC 116/2003, pelo código de tributação nacional) → chave de despesa →
 * conta do plano da empresa. Vale só depois de aprovada por uma pessoa; regra
 * por fornecedor (decisão humana) tem precedência.
 */

export const TAKEN_SERVICES_RULE = "tomadas-servico@1";

/** Rótulos da tabela (o que a pessoa aprova). */
export const SERVICE_TABLE: { code: string; label: string; key: ServiceKey }[] = [
  { code: "01", label: "Informática", key: "INFORMATICA" },
  { code: "02", label: "Pesquisa e desenvolvimento", key: "CONSULTORIA" },
  { code: "03", label: "Locação, cessão de uso", key: "LOCACAO" },
  { code: "04", label: "Saúde", key: "SAUDE" },
  { code: "04.22/04.23", label: "Planos de saúde", key: "PLANO_SAUDE" },
  { code: "07", label: "Engenharia e obras", key: "ENGENHARIA" },
  { code: "07.10/07.11", label: "Limpeza e conservação", key: "LIMPEZA" },
  { code: "08", label: "Educação e treinamento", key: "TREINAMENTO" },
  { code: "10", label: "Intermediação e corretagem", key: "CORRETAGEM" },
  { code: "11", label: "Guarda, vigilância, monitoramento", key: "VIGILANCIA" },
  { code: "13", label: "Fotografia e reprografia", key: "REPROGRAFIA" },
  { code: "14", label: "Manutenção e conserto de bens", key: "MANUTENCAO" },
  { code: "15", label: "Serviços bancários", key: "BANCARIOS" },
  { code: "16", label: "Transporte municipal", key: "TRANSPORTE" },
  { code: "17", label: "Apoio técnico e administrativo", key: "ADMINISTRATIVOS" },
  { code: "17.05", label: "Fornecimento de mão de obra", key: "MAO_DE_OBRA" },
  { code: "17.06", label: "Propaganda e publicidade", key: "PUBLICIDADE" },
  { code: "17.14", label: "Advocacia", key: "ADVOCACIA" },
  { code: "17.16", label: "Auditoria", key: "AUDITORIA" },
  { code: "17.19", label: "Contabilidade", key: "CONTABILIDADE" },
  { code: "17.20", label: "Consultoria econômica ou financeira", key: "CONSULTORIA" },
  { code: "23/35/37", label: "Comunicação visual, relações públicas, artistas", key: "PUBLICIDADE" },
  { code: "24", label: "Chaveiros, carimbos, placas", key: "REPROGRAFIA" },
  { code: "26", label: "Coleta e entrega (courier)", key: "COURIER" },
  { code: "28", label: "Avaliação de bens", key: "CONSULTORIA" },
  { code: "31", label: "Serviços técnicos de edificações e eletrônica", key: "MANUTENCAO" },
  { code: "32", label: "Desenhos técnicos", key: "ENGENHARIA" },
  { code: "33", label: "Desembaraço aduaneiro", key: "ADUANEIRO" },
];

/** Conta proposta para o código de tributação nacional no plano da empresa; nulo = sem proposta (fica para pessoa). */
export function serviceAccount(nationalCode: string | null, cfg: ChartConfig = BUILTIN_CONFIG): string | null {
  const k = serviceKey(nationalCode);
  return k ? cfg.services[k] ?? null : null;
}

/** Tabela com a conta de cada linha no plano da empresa (para a tela). */
export function serviceProposal(cfg: ChartConfig = BUILTIN_CONFIG) {
  return SERVICE_TABLE.map((r) => ({ ...r, account: cfg.services[r.key] ?? null }));
}
