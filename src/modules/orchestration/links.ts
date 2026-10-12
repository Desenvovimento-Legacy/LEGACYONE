import type { Link } from "../../platform/orchestrator/orchestrator.js";
import type { NfseSyncDeps } from "../documents/nfse-sync.js";
import { syncEntityNfse } from "../documents/nfse-sync.js";
import { refreshRevenueExceptions } from "../federal/revenue-exceptions.js";
import { readEntityNfseTaxes, refreshWithholdings } from "../fiscal/withholdings.js";
import { buildObligationMap, entityFacts } from "../onboarding/plan.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { refreshGuides } from "../tax/guides.js";
import { runAutoPosting } from "../ledger/auto-posting.js";
import { refreshPowerRequirements } from "../onboarding/powers.js";
import { refreshAllSimples, refreshSimples } from "../tax/simples/apuracao.js";
import { prepareClientRequest } from "../relationship/client-request.js";
import { preparePgdasDrafts } from "../tax/simples/pgdas-draft.js";
import { readEntityNfeItems } from "../fiscal/nfe-items.js";

/**
 * Vínculos entre agentes: "quando acontecer X, o agente Y faz Z".
 * Ordem importa só para a leitura da tela; cada vínculo é independente.
 */

export interface LinkDeps {
  /** Busca de NFS-e (certificado no cofre). Nulo = sem cofre. */
  nfse?: NfseSyncDeps | null;
  /** Hoje (AAAA-MM-DD, horário de Brasília). */
  today?: () => string;
}

const today = (d: LinkDeps) => (d.today ? d.today() : new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }));
/** Meio-dia de hoje em Brasília (para "mês corrente" não depender do fuso da máquina). */
const now = (d: LinkDeps) => new Date(`${today(d)}T12:00:00-03:00`);

export const LINKS: Link<LinkDeps>[] = [
  {
    id: "notas-conferencia",
    on: ["NFSE_BATCH_RECEIVED"],
    agent: "review",
    does: "Confere a receita declarada com as NFS-e prestadas e abre ou fecha a exceção do mês",
    run: async ({ pool, tenantId, entityId }) => ({ ...(await refreshRevenueExceptions(pool, tenantId, entityId!)) }),
  },
  {
    id: "notas-simples",
    on: ["NFSE_BATCH_RECEIVED"],
    agent: "tax",
    does: "Recalcula o Simples do mês fechado com as notas novas",
    run: async ({ pool, tenantId, entityId, deps }) => ({ ...(await refreshSimples(pool, tenantId, entityId!, now(deps))) }),
  },
  {
    id: "declaracao-conferencia",
    on: ["PGDAS_DECLARATION_READ", "CONTRACTED_SERVICES_DEFINED"],
    agent: "review",
    does: "Refaz a conferência de receita com a declaração lida ou o novo início de responsabilidade",
    run: async ({ pool, tenantId, entityId }) => ({ ...(await refreshRevenueExceptions(pool, tenantId, entityId!)) }),
  },
  {
    id: "declaracao-simples",
    on: ["PGDAS_DECLARATION_READ", "FEDERAL_PAYMENTS_SYNCED"],
    agent: "tax",
    does: "Recalcula o Simples e confere com o débito declarado ou o DAS pago",
    run: async ({ pool, tenantId, entityId, deps }) => ({ ...(await refreshSimples(pool, tenantId, entityId!, now(deps))) }),
  },
  {
    id: "tabelas-simples",
    on: ["SIMPLES_RULES_APPROVED"],
    agent: "tax",
    does: "Recalcula todas as empresas com as tabelas aprovadas",
    perEntity: false,
    run: async ({ pool, tenantId, deps }) => ({ changed: await refreshAllSimples(pool, tenantId, now(deps)) }),
  },
  {
    id: "receita-guias",
    on: ["PGDAS_INDEX_SYNCED", "FEDERAL_PAYMENTS_SYNCED", "PGDAS_DECLARATION_READ", "CONTRACTED_SERVICES_DEFINED"],
    agent: "guides",
    does: "Atualiza prazo e pagamento do DAS de cada competência",
    run: async ({ pool, tenantId, entityId, deps }) => ({ ...(await refreshGuides(pool, tenantId, entityId!, today(deps))) }),
  },
  {
    id: "notas-tributos",
    on: ["NFSE_BATCH_RECEIVED"],
    agent: "fiscal",
    does: "Lê os tributos e as retenções de cada NFS-e nova",
    run: async ({ pool, tenantId, entityId }) => {
      const r = await readEntityNfseTaxes(pool, tenantId, entityId!);
      return { documents: r.read, divergent: r.divergent };
    },
  },
  {
    id: "retencoes-recolhimento",
    on: ["NFSE_TAXES_READ", "FEDERAL_PAYMENTS_SYNCED", "CONTRACTED_SERVICES_DEFINED"],
    agent: "fiscal",
    does: "Confere o IRRF e o PIS/COFINS/CSLL retidos nas notas tomadas com o DARF pago",
    run: async ({ pool, tenantId, entityId, deps }) => ({ ...(await refreshWithholdings(pool, tenantId, entityId!, today(deps))) }),
  },
  {
    id: "retencoes-obrigacoes",
    on: ["NFSE_TAXES_READ"],
    agent: "obligations",
    does: "Inclui o recolhimento das retenções no mapa de obrigações quando a empresa passa a reter",
    run: async ({ pool, tenantId, entityId }) =>
      withTenant(pool, tenantId, async (tx) => ({ ...(await buildObligationMap(tx, await entityFacts(tx, entityId!))) })),
  },
  {
    id: "regras-obrigacoes",
    on: ["OBLIGATION_RULES_APPROVED"],
    agent: "fiscal",
    does: "Refaz a situação das retenções com o prazo aprovado",
    perEntity: false,
    run: async ({ pool, tenantId, deps }) => {
      const ents = await withTenant(pool, tenantId, (tx) => tx.query<{ id: string }>("SELECT DISTINCT entity_id AS id FROM nfse_tax WHERE role = 'TOMADA'"));
      let changed = 0;
      for (const e of ents.rows) changed += (await refreshWithholdings(pool, tenantId, e.id, today(deps))).changed;
      return { changed };
    },
  },
  {
    id: "contabil-automatico",
    on: ["CHART_OF_ACCOUNTS_DEFINED", "BANK_STATEMENT_RECEIVED", "NFSE_BATCH_RECEIVED", "PGDAS_DECLARATION_READ", "FEDERAL_PAYMENTS_SYNCED", "NFSE_TAXES_READ"],
    agent: "ledger",
    does: "Contabiliza notas, Simples declarado e extrato; o que não tem hipótese única fica para classificação",
    run: async ({ pool, tenantId, entityId }) => {
      const r = await runAutoPosting(pool, tenantId, entityId!);
      return r.skipped ? { skipped: r.skipped } : { entries: r.posted, reversed: r.reversed, pending: r.pendingBank };
    },
  },
  {
    id: "procuracoes-locais",
    on: ["CONTRACTED_SERVICES_DEFINED", "ENTITY_PROFILE_CREATED", "PGDAS_DECLARATION_READ", "NFSE_TAXES_READ", "POWER_OF_ATTORNEY_REGISTERED"],
    agent: "digital-identity",
    does: "Vê quais procurações estaduais e municipais a empresa precisa e pede ao cliente as que faltam",
    run: async ({ pool, tenantId, entityId }) => ({ ...(await refreshPowerRequirements(pool, tenantId, entityId!)) }),
  },
  {
    id: "relacionamento-pedido",
    on: ["ACCOUNTING_BATCH_POSTED", "BANK_STATEMENT_RECEIVED", "NFSE_BATCH_RECEIVED", "PENDING_ITEM_CREATED", "OPENING_BALANCES_IMPORTED", "CHART_OF_ACCOUNTS_DEFINED", "ACCOUNTING_CLOSING_COMPLETED", "ACCOUNTING_RULES_APPROVED"],
    agent: "relationship",
    does: "Junta num pedido só ao cliente o que falta: extratos, comprovantes, notas esperadas e esclarecimentos",
    when: (e) => Boolean(e.entity_id),
    run: async ({ pool, tenantId, entityId, deps }) => {
      const r = await prepareClientRequest(pool, tenantId, entityId!, today(deps));
      return { version: r.version, changed: r.changed, items: r.items };
    },
  },
  {
    id: "nfe-itens",
    on: ["DFE_BATCH_RECEIVED", "XML_BATCH_IMPORTED", "PGDAS_DECLARATION_READ"],
    agent: "fiscal",
    does: "Lê os itens das NF-e e NFC-e: confere CFOP e CST, marca ST e monofásico, propõe o CFOP de entrada e decide os créditos pelo regime",
    when: (e) => Boolean(e.entity_id),
    run: async ({ pool, tenantId, entityId }) => ({ ...(await readEntityNfeItems(pool, tenantId, entityId!)) }),
  },
  {
    id: "pgdas-pronta",
    on: ["SIMPLES_CALCULATED", "NFSE_BATCH_RECEIVED", "PGDAS_DECLARATION_READ", "PGDAS_INDEX_SYNCED", "NFSE_TAXES_READ", "SIMPLES_RULES_APPROVED"],
    agent: "tax",
    does: "Monta a PGDAS-D dos meses em aberto, pronta para transmitir (não transmite) e com o motivo do que bloqueia",
    when: (e) => Boolean(e.entity_id),
    run: async ({ pool, tenantId, entityId, deps }) => ({ ...(await preparePgdasDrafts(pool, tenantId, entityId!, today(deps))) }),
  },
  {
    id: "certificado-notas",
    on: ["DIGITAL_CERTIFICATE_REGISTERED"],
    agent: "docs",
    does: "Busca as NFS-e da empresa assim que o certificado entra no cofre",
    run: async ({ tenantId, entityId, deps }) => {
      if (!deps.nfse) return { skipped: "sem cofre" };
      const r = await syncEntityNfse(deps.nfse, tenantId, entityId!);
      return { status: r.status, documents: r.documents, calls: r.calls };
    },
  },
];

/** Nomes dos eventos para a tela. */
export const EVENT_LABEL: Record<string, string> = {
  NFSE_BATCH_RECEIVED: "NFS-e novas recebidas",
  PGDAS_DECLARATION_READ: "Declaração do PGDAS-D lida",
  PGDAS_INDEX_SYNCED: "Declarações e DAS buscados na Receita",
  FEDERAL_PAYMENTS_SYNCED: "Pagamentos federais buscados",
  SIMPLES_RULES_APPROVED: "Tabelas do Simples aprovadas",
  CONTRACTED_SERVICES_DEFINED: "Serviços e início da responsabilidade definidos",
  DIGITAL_CERTIFICATE_REGISTERED: "Certificado A1 registrado no cofre",
  NFSE_TAXES_READ: "Tributos das NFS-e lidos",
  OBLIGATION_RULES_APPROVED: "Regras de obrigações aprovadas",
  CHART_OF_ACCOUNTS_DEFINED: "Plano de contas definido",
  BANK_STATEMENT_RECEIVED: "Extrato bancário recebido",
  ENTITY_PROFILE_CREATED: "Perfil da empresa montado",
  POWER_OF_ATTORNEY_REGISTERED: "Procuração estadual ou municipal registrada",
  ACCOUNTING_BATCH_POSTED: "Lançamentos automáticos feitos",
  PENDING_ITEM_CREATED: "Pendência aberta",
  OPENING_BALANCES_IMPORTED: "Saldos de abertura lançados",
  ACCOUNTING_CLOSING_COMPLETED: "Competência contábil fechada",
  ACCOUNTING_RULES_APPROVED: "Regra de contabilização aprovada",
  SIMPLES_CALCULATED: "Simples calculado",
  PGDAS_DRAFT_PREPARED: "PGDAS-D montada (pronta para transmitir)",
  NFE_ITEMS_READ: "Itens das NF-e lidos (CFOP, CST e créditos)",
  DFE_BATCH_RECEIVED: "NF-e/CT-e recebidos da SEFAZ",
  XML_BATCH_IMPORTED: "XML recebidos por upload ou pasta",
  PGDAS_DRAFT_CHECKED: "PGDAS-D conferida com a Receita (sem transmitir)",
};
