/**
 * Proposta de contabilização das NFS-e tomadas: tipo de serviço (item da lista
 * da LC 116/2003, os 4 primeiros dígitos do código de tributação nacional) →
 * conta de despesa do plano padrão Legacy. Vale só depois de aprovada por uma
 * pessoa; regra por fornecedor (decisão humana) tem precedência.
 */

export const TAKEN_SERVICES_RULE = "tomadas-servico@1";

/** Por subitem (4 dígitos) primeiro; depois pelo item (2 dígitos). */
export const SERVICE_ACCOUNT_BY_SUBITEM: Record<string, string> = {
  "0710": "4.3.1.12", // limpeza, manutenção e conservação de imóveis
  "1401": "4.3.1.12", // manutenção de máquinas, veículos e equipamentos
  "1705": "4.2.1.07", // fornecimento de mão de obra
  "1706": "4.3.1.10", // propaganda e publicidade
  "1714": "4.3.1.06", // advocacia
  "1716": "4.3.1.05", // auditoria
  "1719": "4.3.1.05", // contabilidade
  "1720": "4.3.1.06", // consultoria e assessoria econômica ou financeira
};

export const SERVICE_ACCOUNT_BY_ITEM: Record<string, { account: string; label: string }> = {
  "01": { account: "4.3.1.09", label: "Informática" },
  "02": { account: "4.3.1.06", label: "Pesquisa e desenvolvimento" },
  "03": { account: "4.3.1.01", label: "Locação, cessão de uso" },
  "07": { account: "4.3.1.12", label: "Engenharia, obras, limpeza e conservação" },
  "11": { account: "4.3.1.12", label: "Guarda, vigilância" },
  "13": { account: "4.3.1.07", label: "Fotografia e reprografia" },
  "14": { account: "4.3.1.12", label: "Manutenção e conserto de bens" },
  "15": { account: "4.4.1.01", label: "Serviços bancários" },
  "16": { account: "4.3.1.11", label: "Transporte municipal" },
  "17": { account: "4.3.1.06", label: "Apoio técnico, administrativo, jurídico, contábil" },
  "23": { account: "4.3.1.10", label: "Programação e comunicação visual" },
  "24": { account: "4.3.1.07", label: "Chaveiros, carimbos, placas" },
  "26": { account: "4.3.1.11", label: "Coleta e entrega (courier)" },
  "28": { account: "4.3.1.06", label: "Avaliação de bens" },
  "31": { account: "4.3.1.12", label: "Serviços técnicos de edificações e eletrônica" },
  "32": { account: "4.3.1.06", label: "Desenhos técnicos" },
  "33": { account: "4.3.1.11", label: "Desembaraço aduaneiro" },
  "35": { account: "4.3.1.10", label: "Reportagem e relações públicas" },
  "37": { account: "4.3.1.10", label: "Artistas e modelos" },
};

/** Conta proposta para o código de tributação nacional; nulo = sem proposta (fica para pessoa). */
export function serviceAccount(nationalCode: string | null): string | null {
  const c = (nationalCode ?? "").replace(/\D/g, "");
  if (c.length < 2) return null;
  return SERVICE_ACCOUNT_BY_SUBITEM[c.slice(0, 4)] ?? SERVICE_ACCOUNT_BY_ITEM[c.slice(0, 2)]?.account ?? null;
}
