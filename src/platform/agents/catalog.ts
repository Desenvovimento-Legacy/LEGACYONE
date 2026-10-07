/**
 * Catálogo de agentes e processos da IARES, com a situação de implantação.
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
  // nomes usados antes da troca para IARES (histórico imutável)
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
  { id: "documentos", name: "Documentos", status: "OPERANDO", phase: "Fase 2", agents: ["docs"], summary: "NFS-e do Sistema Nacional e NF-e da SEFAZ, buscadas sozinhas, com o XML guardado." },
  { id: "fiscal", name: "Fiscal", status: "PLANEJADO", phase: "Fase 5", agents: ["fiscal"], summary: "Entradas, saídas, CFOP, CST, retenções e créditos." },
  { id: "folha", name: "Folha", status: "PLANEJADO", phase: "Fase 6", agents: ["payroll"], summary: "Admissão, folha, férias, rescisão, eSocial e FGTS Digital." },
  { id: "financeiro", name: "Financeiro e conciliação", status: "PLANEJADO", phase: "Fase 3", agents: ["financial", "reconciliation"], summary: "Extratos, banco × razão, clientes e fornecedores." },
  { id: "contabil", name: "Contábil", status: "PLANEJADO", phase: "Fase 4", agents: ["ledger"], summary: "Lançamentos com evidência, fechamento, balancete, DRE e balanço." },
  { id: "tributos", name: "Tributos e guias", status: "PLANEJADO", phase: "Fase 5 e 11", agents: ["tax", "guides"], summary: "Cálculo determinístico, guia, vencimento e pagamento." },
  { id: "obrigacoes", name: "Obrigações e SPED", status: "PLANEJADO", phase: "Fases 7 a 10", agents: ["obligations", "sped"], summary: "Mapa por empresa, ECD, ECF, EFD, DCTFWeb, DEFIS." },
  { id: "transmissao", name: "Transmissão", status: "PLANEJADO", phase: "Fase 11", agents: ["transmission"], summary: "Assinatura, envio e recibo, sempre com sua aprovação." },
  { id: "societario", name: "Societário e contratos", status: "PLANEJADO", phase: "—", agents: ["corporate", "contracts"], summary: "Abertura, alteração, contratos e assinatura eletrônica." },
  { id: "regularizacao", name: "Regularização", status: "PLANEJADO", phase: "Fase 11", agents: ["regularization"], summary: "Parcelamentos, certidões, PER/DCOMP e intimações." },
  { id: "relacionamento", name: "Relacionamento", status: "PLANEJADO", phase: "Fase 11", agents: ["relationship"], summary: "Um pedido consolidado ao cliente; entrega do mês no portal." },
  { id: "revisao", name: "Revisão independente", status: "PLANEJADO", phase: "Fase 12", agents: ["review"], summary: "Cruza tudo antes de qualquer entrega." },
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
      { id: "onboarding", name: "Implantação", status: "OPERANDO", summary: "Do CNPJ ao cliente pronto para operar.", capabilities: [cap("Cadastro pelo CNPJ", true), cap("Regime e histórico", true), cap("Serviços contratados", true), cap("Checklist e migração", true), cap("Mapa de obrigações", true)] },
      { id: "digital-identity", name: "Identidade digital", status: "OPERANDO", summary: "Procurações e certificados de cada empresa.", capabilities: [cap("Procuração e-CAC", true), cap("Certificados A1 no cofre", true), cap("Validade dos certificados", true), cap("Procurações estaduais e municipais")] },
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
      { id: "docs", name: "Documentos", status: "OPERANDO", summary: "Busca as notas sozinho e guarda o XML original.", capabilities: [cap("NFS-e Nacional", true), cap("Ciência com aprovação", true), cap("NF-e SEFAZ (aguarda sequência)"), cap("NFC-e"), cap("CT-e"), cap("NFS-e municipal")] },
      { id: "search", name: "Receita Federal", status: "OPERANDO", summary: "PGDAS-D, DAS e pagamentos, com teto de custo.", capabilities: [cap("PGDAS-D e DAS", true), cap("Pagamentos (PagtoWeb)", true), cap("Receita declarada", true), cap("Teto diário de consultas", true)] },
      { id: "obligations", name: "Obrigações", status: "OPERANDO", summary: "Quais obrigações cada empresa tem e quando vencem.", capabilities: [cap("Mapa por empresa", true), cap("Calendário de dias úteis", true), cap("Entrega das obrigações")] },
      { id: "fiscal", name: "Escrita fiscal", status: "PLANEJADO", summary: "Entradas e saídas classificadas.", capabilities: [cap("CFOP e CST"), cap("Retenções"), cap("Créditos")] },
      { id: "tax", name: "Tributos", status: "PLANEJADO", summary: "Cálculo determinístico de cada tributo.", capabilities: [cap("Simples Nacional"), cap("Presumido e Real"), cap("ICMS e ISS")] },
      { id: "guides", name: "Guias", status: "PLANEJADO", summary: "Guia, vencimento e pagamento.", capabilities: [cap("DAS e DARF"), cap("Vencimento"), cap("Pagamento identificado")] },
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
      { id: "ledger", name: "Contábil (razão)", status: "PLANEJADO", summary: "Partidas dobradas com evidência.", capabilities: [cap("Plano de contas"), cap("Lançamentos com evidência"), cap("Balancete, DRE e balanço"), cap("Fechamento")] },
      { id: "financial", name: "Financeiro", status: "PLANEJADO", summary: "Extratos e contas da empresa.", capabilities: [cap("Extratos (OFX)"), cap("Contas a pagar e receber")] },
      { id: "reconciliation", name: "Conciliação", status: "PLANEJADO", summary: "Banco, clientes e fornecedores.", capabilities: [cap("Banco × razão"), cap("Clientes e fornecedores")] },
      { id: "review", name: "Revisão independente", status: "EM_CONSTRUCAO", summary: "Cruza tudo antes de qualquer entrega.", capabilities: [cap("Receita declarada × NFS-e", true), cap("Fiscal × contábil"), cap("Folha × contábil")] },
      { id: "ecd", name: "ECD e ECF", status: "PLANEJADO", summary: "SPED contábil e fiscal anual.", capabilities: [cap("ECD"), cap("ECF"), cap("e-LALUR / e-LACS")] },
    ],
  },
];

/** Comuns a todos os departamentos. */
export const SHARED_AGENTS: AgentInfo[] = [
  { id: "case-engine", name: "Cases e pendências", status: "OPERANDO", summary: "Toda operação é um Case; o que falta vira pendência.", capabilities: [cap("Cases", true), cap("Pendências", true), cap("Fila humana", true)] },
  { id: "relationship", name: "Relacionamento", status: "PLANEJADO", summary: "Um pedido consolidado ao cliente.", capabilities: [cap("Pedido consolidado"), cap("Portal do cliente"), cap("WhatsApp e e-mail")] },
];
