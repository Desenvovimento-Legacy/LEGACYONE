/**
 * Catálogo de agentes e processos da AIRES, com a situação de implantação.
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
  // nomes usados antes da troca para AIRES (histórico imutável)
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
  { id: "documentos", name: "Documentos", status: "EM_CONSTRUCAO", phase: "Fase 2", agents: ["docs"], summary: "NF-e, NFS-e e CT-e direto da SEFAZ e da NFS-e Nacional, todo dia." },
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
