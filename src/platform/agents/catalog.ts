/**
 * Catálogo de agentes e processos da IARIS, com a situação de implantação.
 * É a fonte da Central de agentes: muda aqui quando um agente entra em operação.
 */
export type AgentStatus = "OPERANDO" | "EM_CONSTRUCAO" | "PLANEJADO";

export interface ProcessInfo {
  id: string;
  name: string;
  status: AgentStatus;
  phase: string;
  /** Ids dos agentes (como aparecem em producer.name e no audit_log). */
  agents: string[];
  summary: string;
}

export const AGENT_NAMES: Record<string, string> = {
  onboarding: "Implantação",
  search: "Busca Receita",
  "digital-identity": "Identidade Digital",
  orchestrator: "Orquestrador",
  docs: "Documentos",
  fiscal: "Fiscal",
  payroll: "Folha",
  financial: "Financeiro",
  reconciliation: "Conciliação",
  ledger: "Contábil",
  tax: "Tributos",
  guides: "Guias",
  obligations: "Obrigações",
  sped: "SPED",
  transmission: "Transmissão",
  corporate: "Societário",
  contracts: "Contratos",
  regularization: "Regularização",
  relationship: "Relacionamento",
  review: "Revisão",
  "case-engine": "Motor de Cases",
  "pending-engine": "Pendências",
  esocial: "eSocial e DCTFWeb",
  ecd: "ECD e ECF",
  // nomes usados antes da troca para IARIS (histórico imutável)
  "one-onboarding": "Implantação",
  "one-search": "Busca Receita",
};

export function agentName(id: string | null | undefined): string {
  if (!id) return "—";
  return AGENT_NAMES[id] ?? id;
}

export const PROCESSES: ProcessInfo[] = [
  { id: "implantacao", name: "Implantação", status: "OPERANDO", phase: "Fase 1", agents: ["onboarding", "digital-identity"], summary: "Do CNPJ ao cliente pronto: perfil, regime, procuração e serviços contratados." },
  { id: "receita", name: "Receita Federal", status: "OPERANDO", phase: "Fase 1", agents: ["search"], summary: "PGDAS-D, DAS e pagamentos por competência, com teto de custo." },
  { id: "documentos", name: "Documentos", status: "OPERANDO", phase: "Fase 2", agents: ["docs"], summary: "NFS-e (Nacional e municipal ABRASF), NF-e e CT-e da SEFAZ buscados sozinhos ou por arquivo, com o XML guardado; NF-e segue o NSU indicado pela SEFAZ." },
  { id: "fiscal", name: "Fiscal", status: "EM_CONSTRUCAO", phase: "Fase 5", agents: ["fiscal"], summary: "Tributos e retenções de toda NFS-e (Nacional, municipal ou enviada por arquivo) conferidos com o DARF pago; CFOP, CST e créditos de NF-e a seguir." },
  { id: "folha", name: "Folha", status: "PLANEJADO", phase: "Fase 6", agents: ["payroll"], summary: "Admissão, folha, férias, rescisão, eSocial e FGTS Digital." },
  { id: "financeiro", name: "Financeiro e conciliação", status: "EM_CONSTRUCAO", phase: "Fase 3", agents: ["financial", "reconciliation"], summary: "Extrato em OFX, Excel, CSV ou PDF conciliado com DARF/DAS e notas (inclusive pagamento parcial e transferência entre contas); regras de histórico." },
  { id: "contabil", name: "Contábil", status: "EM_CONSTRUCAO", phase: "Fase 4", agents: ["ledger"], summary: "Razão de partidas dobradas montado sozinho a partir de notas, Simples e extrato; saldos de abertura do escritório anterior; balancete, DRE, balanço e fechamento do mês." },
  { id: "tributos", name: "Tributos e guias", status: "EM_CONSTRUCAO", phase: "Fase 5 e 11", agents: ["tax", "guides"], summary: "Cálculo determinístico do Simples, do Lucro Presumido e do Lucro Real (e-LALUR), com vencimento, quota, código do DARF e pagamento conferido." },
  { id: "obrigacoes", name: "Obrigações e SPED", status: "PLANEJADO", phase: "Fases 7 a 10", agents: ["obligations", "sped"], summary: "Mapa por empresa, ECD, ECF, EFD, DCTFWeb, DEFIS." },
  { id: "transmissao", name: "Transmissão", status: "PLANEJADO", phase: "Fase 11", agents: ["transmission"], summary: "Assinatura, envio e recibo, sempre com sua aprovação." },
  { id: "societario", name: "Societário e contratos", status: "PLANEJADO", phase: "—", agents: ["corporate", "contracts"], summary: "Abertura, alteração, contratos e assinatura eletrônica." },
  { id: "regularizacao", name: "Regularização", status: "PLANEJADO", phase: "Fase 11", agents: ["regularization"], summary: "Parcelamentos, certidões, PER/DCOMP e intimações." },
  { id: "relacionamento", name: "Relacionamento", status: "EM_CONSTRUCAO", phase: "Fase 11", agents: ["relationship"], summary: "Um pedido consolidado ao cliente, montado sozinho (balancete anterior, extratos, comprovantes, notas esperadas, esclarecimentos), sem repetir o que já chegou; envio por e-mail e portal a seguir." },
  { id: "revisao", name: "Revisão independente", status: "OPERANDO", phase: "Fase 12", agents: ["review"], summary: "Cruza fiscal, contábil, banco, declarado e pago por mês e dá a nota de cobertura e de risco." },
];

/** Etapas da esteira por empresa (Central). */
export const PIPELINE_STAGES = [
  "Implantação",
  "Documentos",
  "Fiscal",
  "Folha",
  "Financeiro",
  "Contábil",
  "Tributos",
  "Revisão",
  "Obrigações",
  "Cliente",
] as const;

/**
 * Departamentos e agentes vinculados (painel "Funcionamento dos agentes").
 * Verde = agente operando; vermelho = ainda não ativo. Cada capacidade tem a
 * própria situação, para mostrar o que já roda dentro de cada agente.
 */
export interface Capability {
  name: string;
  on: boolean;
}

export interface AgentInfo {
  id: string;
  name: string;
  status: AgentStatus;
  summary: string;
  capabilities: Capability[];
}

export interface DepartmentInfo {
  id: string;
  name: string;
  summary: string;
  agents: AgentInfo[];
}

const cap = (name: string, on = false): Capability => ({ name, on });

export const DEPARTMENTS: DepartmentInfo[] = [
  {
    id: "societario",
    name: "Societário",
    summary: "Cadastro, identidade digital, atos societários e regularização.",
    agents: [
      { id: "onboarding", name: "Implantação", status: "OPERANDO", summary: "Do CNPJ ao cliente pronto para operar.", capabilities: [cap("Cadastro pelo CNPJ", true), cap("Regime e histórico", true), cap("Regime identificado pela Receita (DARF pagos e ECF nos dados abertos)", true), cap("Serviços contratados", true), cap("Checklist e migração", true), cap("Mapa de obrigações", true)] },
      { id: "digital-identity", name: "Identidade digital", status: "OPERANDO", summary: "Procurações e certificados de cada empresa.", capabilities: [cap("Procuração e-CAC", true), cap("Certificados A1 no cofre", true), cap("Validade dos certificados", true), cap("Procurações estaduais e municipais", true)] },
      { id: "corporate", name: "Societário", status: "PLANEJADO", summary: "Atos da empresa na Junta e na Receita.", capabilities: [cap("Abertura"), cap("Alteração contratual"), cap("Filiais"), cap("Baixa")] },
      { id: "contracts", name: "Contratos e assinatura", status: "PLANEJADO", summary: "Documentos a partir de modelos aprovados.", capabilities: [cap("Modelos aprovados"), cap("Assinatura eletrônica"), cap("Arquivo e evidência")] },
      { id: "regularization", name: "Regularização", status: "PLANEJADO", summary: "Pendências com os órgãos.", capabilities: [cap("Certidões"), cap("Parcelamentos"), cap("PER/DCOMP"), cap("Intimações")] },
    ],
  },
  {
    id: "fiscal",
    name: "Fiscal",
    summary: "Documentos, Receita Federal, apuração, guias e obrigações.",
    agents: [
      { id: "docs", name: "Documentos", status: "OPERANDO", summary: "Busca as notas sozinho e guarda o XML original.", capabilities: [cap("NFS-e Nacional", true), cap("NF-e só em resumo: ciência pedida ao cliente", true), cap("CT-e (distribuição nacional)", true), cap("Entrada de XML: upload e pasta", true), cap("NFC-e pelo XML do PDV", true), cap("NF-e SEFAZ (segue o NSU indicado pela SEFAZ)", true), cap("NFS-e municipal (XML ABRASF por upload ou pasta)", true), cap("NFS-e enviada por arquivo entra no fiscal e no contábil", true)] },
      { id: "search", name: "Receita Federal", status: "OPERANDO", summary: "PGDAS-D, DAS e pagamentos, com teto de custo.", capabilities: [cap("PGDAS-D e DAS", true), cap("Pagamentos (PagtoWeb)", true), cap("Receita declarada", true), cap("Teto diário de consultas", true)] },
      { id: "obligations", name: "Obrigações", status: "OPERANDO", summary: "Quais obrigações cada empresa tem e quando vencem.", capabilities: [cap("Mapa por empresa", true), cap("Calendário de dias úteis", true), cap("Entrega das obrigações")] },
      { id: "fiscal", name: "Escrita fiscal", status: "OPERANDO", summary: "Lê os tributos de cada NFS-e (Nacional ou municipal) e confere as retenções com o recolhimento.", capabilities: [cap("Tributos da NFS-e (NT 007)", true), cap("Tributos da NFS-e municipal (ABRASF)", true), cap("Prova da retenção pelo valor líquido", true), cap("IRRF e PIS/COFINS/CSLL retidos × DARF", true), cap("ISS retido nas tomadas: prazo por município e recolhimento no extrato", true), cap("CFOP e CST de cada item da NF-e/NFC-e (com conferência)", true), cap("ST e monofásico por item", true), cap("CFOP de entrada proposto pela destinação", true), cap("Créditos de ICMS, IPI, PIS e COFINS pelo regime", true)] },
      { id: "tax", name: "Tributos", status: "OPERANDO", summary: "Cálculo determinístico de cada tributo, só com tabela aprovada.", capabilities: [cap("Simples Nacional: cálculo e conferência", true), cap("PGDAS-D pronta para transmitir (Receita calcula, sem transmitir)", true), cap("Simples: fator r e impedimento de ISS/ICMS"), cap("Lucro Presumido: PIS/COFINS cumulativos e IRPJ/CSLL trimestral com LC 224/2025", true), cap("Lucro Real: e-LALUR (Parte A/B), trava de 30%, PIS/COFINS não cumulativos com créditos", true), cap("Lucro Real anual: estimativa pela receita e ajuste anual", true), cap("Estimativa por balancete de suspensão/redução"), cap("Regime de caixa no Presumido"), cap("ICMS e ISS próprios")] },
      { id: "guides", name: "Guias", status: "OPERANDO", summary: "DAS de cada competência: prazo, emissão e pagamento identificado.", capabilities: [cap("Vencimento com dias úteis", true), cap("Pagamento identificado (DAS)", true), cap("Guia enviada ao cliente registrada (separa não enviada de não paga)", true), cap("Pagamentos na Receita consultados sozinhos 5 dias após o vencimento", true), cap("Emissão do DAS"), cap("Emissão do DARF")] },
      { id: "sped", name: "SPED fiscal", status: "PLANEJADO", summary: "Arquivos digitais fiscais.", capabilities: [cap("EFD ICMS/IPI"), cap("EFD-Contribuições"), cap("EFD-Reinf")] },
      { id: "transmission", name: "Transmissão", status: "PLANEJADO", summary: "Assinatura, envio e recibo, com sua aprovação.", capabilities: [cap("Assinatura"), cap("Envio"), cap("Recibo")] },
    ],
  },
  {
    id: "folha",
    name: "Folha",
    summary: "Pessoas, folha mensal e obrigações trabalhistas.",
    agents: [
      { id: "payroll", name: "Folha de pagamento", status: "PLANEJADO", summary: "Do contrato à rescisão.", capabilities: [cap("Admissão"), cap("Folha mensal"), cap("Férias"), cap("13º salário"), cap("Rescisão"), cap("Provisões")] },
      { id: "esocial", name: "eSocial e DCTFWeb", status: "PLANEJADO", summary: "Eventos, contribuições e FGTS.", capabilities: [cap("Eventos eSocial"), cap("DCTFWeb"), cap("FGTS Digital")] },
    ],
  },
  {
    id: "contabil",
    name: "Contábil",
    summary: "Razão próprio, conciliação, revisão e SPED contábil.",
    agents: [
      { id: "ledger", name: "Contábil (razão)", status: "OPERANDO", summary: "Partidas dobradas com evidência, garantidas pelo banco de dados.", capabilities: [cap("Plano de contas padrão", true), cap("Lançamentos com evidência e estorno", true), cap("Receita das NFS-e e provisão do Simples", true), cap("NFS-e tomadas com retenções", true), cap("Plano de contas do escritório (modelo próprio)", true), cap("Pagamento parcial e transferência entre contas", true), cap("Balancete", true), cap("DRE e balanço", true), cap("Saldos de abertura pelo balancete anterior (PDF)", true), cap("Fechamento do mês com conferências", true), cap("Bloqueio de período", true), cap("Classificação de movimento sem regra (pessoa decide, vira regra)", true)] },
      { id: "financial", name: "Financeiro", status: "OPERANDO", summary: "Extratos e contas da empresa.", capabilities: [cap("Extratos OFX sem duplicar", true), cap("Conta contábil do banco automática", true), cap("Extrato em PDF (com saldo conferido), Excel e CSV", true), cap("Mesmo período em dois formatos não duplica", true), cap("Open Finance"), cap("Contas a pagar e receber")] },
      { id: "reconciliation", name: "Conciliação", status: "OPERANDO", summary: "Cada movimento do banco explicado por DARF, nota ou regra.", capabilities: [cap("DAS e DARF item a item", true), cap("Recebimento × NFS-e", true), cap("Pagamento × NFS-e tomada (inclusive parcial)", true), cap("Cadastro de clientes e fornecedores pelas notas", true), cap("Regras de histórico aprendidas", true), cap("Fornecedores × NF-e"), cap("Proposta por IA com aprovação")] },
      { id: "review", name: "Revisão independente", status: "OPERANDO", summary: "Cruza tudo antes de qualquer entrega e abre exceção com hipótese.", capabilities: [cap("Receita declarada × NFS-e", true), cap("Simples calculado × declarado", true), cap("Exceções com hipótese", true), cap("Fiscal × contábil (NFS-e e NF-e de venda)", true), cap("Banco × razão", true), cap("DAS e retenções × pagamento", true), cap("CFOP/CST e XML completos", true), cap("Nota de cobertura, materialidade e risco por mês", true), cap("Folha × contábil")] },
      { id: "ecd", name: "ECD e ECF", status: "PLANEJADO", summary: "SPED contábil e fiscal anual.", capabilities: [cap("ECD"), cap("ECF"), cap("e-LALUR / e-LACS")] },
    ],
  },
];

/** Comuns a todos os departamentos. */
export const SHARED_AGENTS: AgentInfo[] = [
  { id: "orchestrator", name: "Orquestrador", status: "OPERANDO", summary: "Liga os agentes por evento: quando um termina, o próximo começa sozinho.", capabilities: [cap("Vínculos por evento", true), cap("Cadeia de causa visível", true), cap("Refazer com limite e escalar", true)] },
  { id: "case-engine", name: "Cases e pendências", status: "OPERANDO", summary: "Toda operação é um Case; o que falta vira pendência.", capabilities: [cap("Cases", true), cap("Pendências", true), cap("Fila humana", true)] },
  { id: "relationship", name: "Relacionamento", status: "OPERANDO", summary: "Um pedido consolidado ao cliente, montado sozinho.", capabilities: [cap("Pedido consolidado", true), cap("Itens resolvidos sozinhos", true), cap("Pendências do cadastro fechadas pelos dados", true), cap("Sem itens repetidos (agrupa por fornecedor e sócio)", true), cap("Texto pronto para WhatsApp", true), cap("Envio por e-mail"), cap("Portal do cliente")] },
];
