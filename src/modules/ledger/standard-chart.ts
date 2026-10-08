/**
 * Plano de contas padrão da Legacy (proposta v1) para empresas do Simples
 * Nacional de serviços e comércio. Só é aplicado a uma empresa por decisão
 * humana; pode ser substituído pelo plano do escritório (migração).
 *
 * Contas de banco (1.1.1.02.NN) são criadas pelo agente Financeiro, uma por
 * conta bancária encontrada no extrato.
 */

export const STANDARD_CHART_ID = "PADRAO_LEGACY_V1";

export type Nature = "ATIVO" | "PASSIVO" | "PATRIMONIO_LIQUIDO" | "RECEITA" | "CUSTO" | "DESPESA";
export interface ChartRow {
  code: string;
  name: string;
  nature: Nature;
  analytic: boolean;
}

const A = (code: string, name: string, nature: Nature): ChartRow => ({ code, name, nature, analytic: true });
const S = (code: string, name: string, nature: Nature): ChartRow => ({ code, name, nature, analytic: false });

export const STANDARD_CHART: ChartRow[] = [
  S("1", "ATIVO", "ATIVO"),
  S("1.1", "ATIVO CIRCULANTE", "ATIVO"),
  S("1.1.1", "DISPONÍVEL", "ATIVO"),
  A("1.1.1.01", "Caixa", "ATIVO"),
  S("1.1.1.02", "Bancos conta movimento", "ATIVO"),
  A("1.1.1.03", "Aplicações financeiras de liquidez imediata", "ATIVO"),
  S("1.1.2", "CLIENTES", "ATIVO"),
  A("1.1.2.01", "Clientes", "ATIVO"),
  A("1.1.2.02", "Cartões e meios de pagamento a receber", "ATIVO"),
  S("1.1.3", "TRIBUTOS A RECUPERAR", "ATIVO"),
  A("1.1.3.01", "IRRF a recuperar", "ATIVO"),
  A("1.1.3.02", "PIS/COFINS/CSLL retidos a recuperar", "ATIVO"),
  A("1.1.3.03", "INSS retido a recuperar", "ATIVO"),
  S("1.1.4", "OUTROS CRÉDITOS", "ATIVO"),
  A("1.1.4.01", "Adiantamentos a fornecedores", "ATIVO"),
  A("1.1.4.02", "Adiantamentos a empregados", "ATIVO"),
  A("1.1.4.03", "Despesas antecipadas", "ATIVO"),
  S("1.1.5", "ESTOQUES", "ATIVO"),
  A("1.1.5.01", "Mercadorias para revenda", "ATIVO"),
  A("1.1.5.02", "Matérias-primas e insumos", "ATIVO"),
  S("1.2", "ATIVO NÃO CIRCULANTE", "ATIVO"),
  S("1.2.3", "IMOBILIZADO", "ATIVO"),
  A("1.2.3.01", "Máquinas e equipamentos", "ATIVO"),
  A("1.2.3.02", "Móveis e utensílios", "ATIVO"),
  A("1.2.3.03", "Computadores e periféricos", "ATIVO"),
  A("1.2.3.04", "Veículos", "ATIVO"),
  A("1.2.3.90", "(-) Depreciação acumulada", "ATIVO"),

  S("2", "PASSIVO", "PASSIVO"),
  S("2.1", "PASSIVO CIRCULANTE", "PASSIVO"),
  S("2.1.1", "FORNECEDORES", "PASSIVO"),
  A("2.1.1.01", "Fornecedores", "PASSIVO"),
  S("2.1.2", "OBRIGAÇÕES TRIBUTÁRIAS", "PASSIVO"),
  A("2.1.2.01", "Simples Nacional a recolher", "PASSIVO"),
  A("2.1.2.02", "IRRF retido de terceiros a recolher", "PASSIVO"),
  A("2.1.2.03", "PIS/COFINS/CSLL retidos de terceiros a recolher", "PASSIVO"),
  A("2.1.2.04", "ISS retido de terceiros a recolher", "PASSIVO"),
  A("2.1.2.05", "INSS retido de terceiros a recolher", "PASSIVO"),
  A("2.1.2.06", "Parcelamentos tributários", "PASSIVO"),
  S("2.1.3", "OBRIGAÇÕES TRABALHISTAS E PREVIDENCIÁRIAS", "PASSIVO"),
  A("2.1.3.01", "Salários a pagar", "PASSIVO"),
  A("2.1.3.02", "Pró-labore a pagar", "PASSIVO"),
  A("2.1.3.03", "INSS a recolher", "PASSIVO"),
  A("2.1.3.04", "FGTS a recolher", "PASSIVO"),
  A("2.1.3.05", "IRRF sobre salários a recolher", "PASSIVO"),
  A("2.1.3.06", "Férias e 13º a pagar", "PASSIVO"),
  S("2.1.4", "EMPRÉSTIMOS E FINANCIAMENTOS", "PASSIVO"),
  A("2.1.4.01", "Empréstimos bancários", "PASSIVO"),
  A("2.1.4.02", "Cartão de crédito empresarial a pagar", "PASSIVO"),
  S("2.1.9", "OUTRAS OBRIGAÇÕES", "PASSIVO"),
  A("2.1.9.01", "Contas a pagar", "PASSIVO"),
  A("2.1.9.02", "Adiantamentos de clientes", "PASSIVO"),
  A("2.1.9.03", "Lucros a distribuir", "PASSIVO"),
  S("2.3", "PATRIMÔNIO LÍQUIDO", "PATRIMONIO_LIQUIDO"),
  A("2.3.1.01", "Capital social", "PATRIMONIO_LIQUIDO"),
  A("2.3.1.02", "Lucros ou prejuízos acumulados", "PATRIMONIO_LIQUIDO"),
  A("2.3.1.03", "Lucros distribuídos", "PATRIMONIO_LIQUIDO"),

  S("3", "RECEITAS", "RECEITA"),
  S("3.1", "RECEITA BRUTA", "RECEITA"),
  A("3.1.1.01", "Receita de prestação de serviços", "RECEITA"),
  A("3.1.1.02", "Receita de venda de mercadorias", "RECEITA"),
  A("3.1.1.03", "Receita de venda de produtos industrializados", "RECEITA"),
  S("3.2", "DEDUÇÕES DA RECEITA", "RECEITA"),
  A("3.2.1.01", "Simples Nacional sobre a receita", "RECEITA"),
  A("3.2.1.02", "Devoluções e cancelamentos", "RECEITA"),
  S("3.3", "OUTRAS RECEITAS", "RECEITA"),
  A("3.3.1.01", "Rendimentos de aplicações financeiras", "RECEITA"),
  A("3.3.1.02", "Juros e descontos obtidos", "RECEITA"),

  S("4", "CUSTOS E DESPESAS", "DESPESA"),
  S("4.1", "CUSTOS", "CUSTO"),
  A("4.1.1.01", "Custo das mercadorias vendidas", "CUSTO"),
  A("4.1.1.02", "Custo dos serviços prestados", "CUSTO"),
  S("4.2", "DESPESAS COM PESSOAL", "DESPESA"),
  A("4.2.1.01", "Salários e ordenados", "DESPESA"),
  A("4.2.1.02", "Pró-labore", "DESPESA"),
  A("4.2.1.03", "INSS patronal", "DESPESA"),
  A("4.2.1.04", "FGTS", "DESPESA"),
  A("4.2.1.05", "Férias e 13º salário", "DESPESA"),
  A("4.2.1.06", "Vale-transporte e alimentação", "DESPESA"),
  A("4.2.1.07", "Serviços de autônomos e terceiros", "DESPESA"),
  S("4.3", "DESPESAS ADMINISTRATIVAS", "DESPESA"),
  A("4.3.1.01", "Aluguel e condomínio", "DESPESA"),
  A("4.3.1.02", "Energia elétrica", "DESPESA"),
  A("4.3.1.03", "Água e esgoto", "DESPESA"),
  A("4.3.1.04", "Telefone e internet", "DESPESA"),
  A("4.3.1.05", "Honorários contábeis", "DESPESA"),
  A("4.3.1.06", "Honorários advocatícios e consultoria", "DESPESA"),
  A("4.3.1.07", "Material de escritório e consumo", "DESPESA"),
  A("4.3.1.08", "Combustíveis e manutenção de veículos", "DESPESA"),
  A("4.3.1.09", "Sistemas e softwares", "DESPESA"),
  A("4.3.1.10", "Marketing e publicidade", "DESPESA"),
  A("4.3.1.11", "Fretes e transportes", "DESPESA"),
  A("4.3.1.12", "Manutenção e conservação", "DESPESA"),
  A("4.3.1.13", "Taxas e licenças", "DESPESA"),
  A("4.3.1.99", "Outras despesas administrativas", "DESPESA"),
  S("4.4", "DESPESAS FINANCEIRAS", "DESPESA"),
  A("4.4.1.01", "Tarifas bancárias", "DESPESA"),
  A("4.4.1.02", "Juros e multas pagos", "DESPESA"),
  A("4.4.1.03", "IOF", "DESPESA"),
  A("4.4.1.04", "Taxas de cartão e meios de pagamento", "DESPESA"),
  S("4.5", "DESPESAS TRIBUTÁRIAS", "DESPESA"),
  A("4.5.1.01", "Impostos e taxas diversos", "DESPESA"),
];

export const parentOf = (code: string): string | null => {
  // pai = maior prefixo existente no plano (1.1.1.01 → 1.1.1; 2.3.1.01 → 2.3)
  const parts = code.split(".");
  for (let n = parts.length - 1; n > 0; n--) {
    const p = parts.slice(0, n).join(".");
    if (STANDARD_CHART.some((r) => r.code === p)) return p;
  }
  return null;
};
