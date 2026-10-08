import type { PoolClient } from "pg";
import { guidesNeedingAttention } from "../modules/tax/guides.js";
import { withholdingsNeedingAttention } from "../modules/fiscal/withholdings.js";
import { EVENT_LABEL, LINKS } from "../modules/orchestration/links.js";
import { MAX_ATTEMPTS } from "../platform/orchestrator/orchestrator.js";
import { agentName, DEPARTMENTS, PIPELINE_STAGES, PROCESSES, SHARED_AGENTS, type AgentInfo } from "../platform/agents/catalog.js";
import { formatCnpj } from "../shared/br/documents.js";
import { accessMap, entityFacts, nextDueDates, type DueSpec } from "../modules/onboarding/plan.js";
import { loadCalendar } from "../modules/regulatory/calendar.js";
import { cienciaQueue } from "../modules/documents/documents.js";
import { openRevenueExceptions } from "../modules/federal/revenue-exceptions.js";

/**
 * Leituras da seção Operação (Central de agentes, Fila humana, Cases).
 * Só banco: nada aqui chama sistema externo.
 */

const STATUS_PT: Record<string, string> = {
  OPEN: "aberto",
  IN_PROGRESS: "em andamento",
  WAITING_CLIENT: "aguardando cliente",
  WAITING_EXTERNAL: "aguardando órgão externo",
  WAITING_HUMAN: "aguardando você",
  IN_REVIEW: "em revisão",
  COMPLETED: "concluído",
  CANCELLED: "cancelado",
};
export const statusPt = (s: string) => STATUS_PT[s] ?? s;

const CASE_PT: Record<string, string> = {
  CLIENT_ONBOARDING: "Implantação",
  DOCUMENT_REQUEST: "Pedido de documentos",
  ACCOUNTING_FIRM_MIGRATION: "Migração da contabilidade anterior",
  ACCOUNTING_CLOSING: "Fechamento contábil",
  TAX_CLOSING: "Fechamento fiscal",
  PAYROLL_CLOSING: "Fechamento da folha",
  EXCEPTION: "Exceção",
};
export const caseTypePt = (t: string) => CASE_PT[t] ?? t;

const SERVICE_PT: Record<string, string> = {
  CONTABIL: "contábil",
  FISCAL: "fiscal",
  FOLHA: "folha",
  SOCIETARIO: "societário",
  FINANCEIRO: "financeiro",
  IRPF: "IRPF",
};

const fmtDate = (iso: string | null | undefined) =>
  iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "";

/** Frase curta, em português, para um evento do barramento. */
export function describeEvent(type: string, p: Record<string, unknown>): string {
  switch (type) {
    case "CASE_CREATED":
      return `Case ${caseTypePt(String(p.case_type))} aberto`;
    case "CASE_STATUS_CHANGED":
      return `${caseTypePt(String(p.case_type))}: ${statusPt(String(p.from))} → ${statusPt(String(p.to))}`;
    case "CASE_COMPLETED":
      return `${caseTypePt(String(p.case_type))} concluído`;
    case "CASE_CANCELLED":
      return `${caseTypePt(String(p.case_type))} cancelado`;
    case "ENTITY_PROFILE_CREATED":
      return `Perfil montado · ${String(p.regime ?? "regime a definir").replace("_", " ").toLowerCase()} · ${p.activities} CNAEs · ${p.partners} sócios`;
    case "PENDING_ITEM_CREATED":
      return String(p.required_information ?? "pendência aberta");
    case "POWER_OF_ATTORNEY_VERIFIED":
      return p.active ? "Procuração e-CAC vigente para o escritório" : "Sem procuração e-CAC para o escritório";
    case "PGDAS_INDEX_SYNCED":
      return `${p.competence ? `PA ${String(p.competence).slice(5, 7)}/${String(p.competence).slice(0, 4)}` : p.year} · ${p.declarations} declarações, ${p.das} DAS`;
    case "FEDERAL_PAYMENTS_SYNCED":
      return `${p.payments} pagamentos federais (${fmtDate(String(p.from))} a ${fmtDate(String(p.to))})`;
    case "IMPLEMENTATION_PLAN_CREATED":
      return `Plano de implantação: ${p.checklist_items} itens a receber, ${p.obligations_added} obrigações no mapa${p.migration_case_id ? ", migração aberta" : ""}${p.rules_pending_approval ? `, ${p.rules_pending_approval} regras aguardando aprovação` : ""}`;
    case "CONTRACTED_SERVICES_DEFINED":
      return `Serviços ${(p.services as string[]).map((s) => SERVICE_PT[s] ?? s).join(", ")} desde ${fmtDate(String(p.valid_from))}`;
    case "DIGITAL_CERTIFICATE_REGISTERED":
      return `Certificado A1 conferido no cofre, válido até ${fmtDate(String(p.valid_to))}${p.replaced ? " (substitui o anterior)" : ""}`;
    case "DFE_BATCH_RECEIVED": {
      const k = (p.kinds ?? {}) as Record<string, number>;
      const parts = [k.CTE && `${k.CTE} CT-e`, k.NFE && `${k.NFE} NF-e completa(s)`, k.RES_NFE && `${k.RES_NFE} resumo(s) de NF-e`, (k.EVENTO ?? 0) + (k.RES_EVENTO ?? 0) && `${(k.EVENTO ?? 0) + (k.RES_EVENTO ?? 0)} evento(s)`].filter(Boolean);
      return `SEFAZ: ${parts.join(", ") || `${p.documents} documento(s)`}`;
    }
    case "NFSE_BATCH_RECEIVED": {
      const r = (p.roles ?? {}) as Record<string, number>;
      const parts = [r.PRESTADA && `${r.PRESTADA} prestada(s)`, r.TOMADA && `${r.TOMADA} tomada(s)`, r.EVENTO && `${r.EVENTO} evento(s)`, r.OUTRA && `${r.OUTRA} outra(s)`].filter(Boolean);
      return `NFS-e Nacional: ${parts.join(", ") || `${p.documents} documento(s)`}`;
    }
    case "PGDAS_DECLARATION_READ":
      return p.found
        ? `Declaração PGDAS-D do PA ${String(p.competence).slice(5, 7)}/${String(p.competence).slice(0, 4)} lida: ${p.months} mês(es) de receita${p.regime ? ` · regime ${String(p.regime).toLowerCase()}` : ""}`
        : `Sem declaração transmitida no PA ${String(p.competence).slice(5, 7)}/${String(p.competence).slice(0, 4)}`;
    case "REVENUE_DIVERGENCE_DETECTED":
      return `Receita ${String(p.competence).slice(5, 7)}/${String(p.competence).slice(0, 4)}: declarado × NFS-e diverge em ${Number(p.difference).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}`;
    case "EXCEPTION_DECIDED":
      return p.decision === "RETIFICAR" ? "Exceção decidida: retificar o PGDAS-D" : p.decision === "ADIAR" ? "Exceção adiada para revisão posterior" : "Exceção decidida: diferença mantida com justificativa";
    case "SIMPLES_RULES_APPROVED":
      return `Tabelas do Simples aprovadas: ${(p.rules as string[]).join(", ")}`;
    case "SIMPLES_CALCULATED": {
      const pa = `${String(p.competence).slice(5, 7)}/${String(p.competence).slice(0, 4)}`;
      const brl = (v: unknown) => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
      if (p.status === "CONFERE") return `Simples ${pa}: cálculo confere com o declarado (${brl(p.total)})`;
      if (p.status === "DIVERGE") return `Simples ${pa}: cálculo ${brl(p.total)} × referência ${brl(p.reference_total)}`;
      if (p.status === "CALCULADO") return `Simples ${pa} apurado pelas NFS-e: ${brl(p.total)} (a declarar)`;
      return `Simples ${pa}: ${String(p.status).toLowerCase().replace(/_/g, " ")}`;
    }
    case "GUIDE_STATUS_CHANGED": {
      const pa = `${String(p.competence).slice(5, 7)}/${String(p.competence).slice(0, 4)}`;
      const GS: Record<string, string> = {
        A_DECLARAR: "a declarar", DECLARACAO_NAO_IDENTIFICADA: "declaração ainda não identificada", SEM_DEBITO: "sem débito",
        DECLARADO_SEM_DAS: "declarado, DAS a emitir", A_VENCER: "DAS a vencer", PAGAMENTO_NAO_IDENTIFICADO: "pagamento ainda não identificado",
        PAGO: "pago", PAGO_EM_ATRASO: "pago após o vencimento",
      };
      return `DAS ${pa}: ${GS[String(p.to)] ?? String(p.to)}${p.due ? ` (vencimento ${fmtDate(String(p.due))})` : ""}`;
    }
    case "USER_INVITED":
      return `Convite de acesso enviado (perfil ${String(p.role).replace("_", " ").toLowerCase()})`;
    case "USER_ENROLLED":
      return "Pessoa ativou o acesso (senha e autenticador)";
    case "USER_ACCESS_CHANGED":
      return p.active ? `Perfil de acesso: ${String(p.role).replace("_", " ").toLowerCase()}` : "Acesso revogado";
    case "XML_BATCH_IMPORTED": {
      const t = (p.types ?? {}) as Record<string, number>;
      const N: Record<string, string> = { NFE: "NF-e", NFCE: "NFC-e", CTE: "CT-e", NFSE: "NFS-e", EVENTO_NFE: "evento(s) de NF-e", EVENTO_CTE: "evento(s) de CT-e", OUTRO: "outro(s)" };
      return `XML recebidos por ${p.source === "PASTA" ? "pasta" : "upload"}: ${Object.entries(t).map(([k, v]) => `${v} ${N[k] ?? k}`).join(", ")}`;
    }
    case "NFSE_TAXES_READ": {
      const brl = (v: unknown) => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
      return `Tributos de ${p.documents} NFS-e lidos${Number(p.federal_withheld_taken) ? ` · ${brl(p.federal_withheld_taken)} de IRRF e PIS/COFINS/CSLL retidos nas tomadas` : ""}${p.divergent ? ` · ${p.divergent} a conferir` : ""}`;
    }
    case "WITHHOLDING_STATUS_CHANGED": {
      const pa = `${String(p.competence).slice(5, 7)}/${String(p.competence).slice(0, 4)}`;
      const WS: Record<string, string> = {
        PRAZO_A_APROVAR: "prazo a aprovar", A_VENCER: "a vencer", ABAIXO_DO_MINIMO: "abaixo de R$ 10,00 (acumula)",
        PAGAMENTO_NAO_IDENTIFICADO: "recolhimento ainda não identificado", PAGO: "recolhido", PAGO_EM_ATRASO: "recolhido após o vencimento",
        PAGO_DIVERGENTE: "recolhido valor diferente do retido", PAGO_SEM_NOTA: "recolhido sem NFS-e com retenção",
      };
      return `${p.tax === "IRRF" ? "IRRF" : "PIS/COFINS/CSLL"} retido ${pa}: ${WS[String(p.to)] ?? String(p.to)}`;
    }
    case "OBLIGATION_RULES_APPROVED":
      return `Regras de obrigações aprovadas: ${(p.rules as string[]).join(", ")}`;
    case "NFE_MANIFESTATION_APPROVED":
      return `Ciência da operação aprovada para ${(p.access_keys as string[]).length} NF-e`;
    default:
      return type;
  }
}

export async function centralData(tx: PoolClient) {
  const entities = await tx.query<{
    id: string;
    name: string;
    cnpj: string;
    onboarding_status: string | null;
    has_pgdas: boolean;
    has_cert: boolean;
    dfe_docs: number;
    awaiting: number;
    simples: { competence: string; status: string; total: string | null } | null;
  }>(
    `SELECT e.id, coalesce(e.trade_name, e.legal_name) AS name, e.cnpj,
            (SELECT count(*)::int FROM dfe_document x WHERE x.entity_id = e.id AND x.kind IN ('NFE', 'RES_NFE')) AS dfe_docs,
            (SELECT json_build_object('competence', s.competence, 'status', s.status, 'total', s.total::text)
               FROM simples_calculation s WHERE s.entity_id = e.id
              ORDER BY s.competence DESC, s.created_at DESC LIMIT 1) AS simples,
            (SELECT count(*)::int FROM dfe_document r WHERE r.entity_id = e.id AND r.kind = 'RES_NFE' AND r.situation = '1'
               AND NOT EXISTS (SELECT 1 FROM dfe_document f WHERE f.entity_id = r.entity_id AND f.kind = 'NFE' AND f.access_key = r.access_key)
               AND NOT EXISTS (SELECT 1 FROM nfe_manifestation m WHERE m.entity_id = r.entity_id AND m.access_key = r.access_key)) AS awaiting,
            (SELECT c.status FROM "case" c WHERE c.entity_id = e.id AND c.type = 'CLIENT_ONBOARDING'
              ORDER BY c.created_at DESC LIMIT 1) AS onboarding_status,
            EXISTS (SELECT 1 FROM pgdas_declaration d WHERE d.entity_id = e.id) AS has_pgdas,
            EXISTS (SELECT 1 FROM digital_certificate d WHERE d.entity_id = e.id AND d.status = 'ACTIVE' AND d.valid_to > now()) AS has_cert
       FROM entity e WHERE e.cnpj IS NOT NULL ORDER BY e.legal_name`,
  );

  const human = await humanQueue(tx);

  const counts = await tx.query<{ in_progress: number; exceptions: number; waiting_client: number; waiting_external: number; office_items: number }>(
    `SELECT
       (SELECT count(*)::int FROM "case" WHERE status = 'IN_PROGRESS') AS in_progress,
       (SELECT count(*)::int FROM "case" WHERE type = 'EXCEPTION' AND status NOT IN ('COMPLETED', 'CANCELLED')) AS exceptions,
       (SELECT count(*)::int FROM pending_item WHERE status = 'OPEN' AND responsible_source = 'CLIENT') AS waiting_client,
       (SELECT count(*)::int FROM pending_item WHERE status = 'OPEN' AND responsible_source = 'EXTERNAL') AS waiting_external,
       (SELECT count(*)::int FROM pending_item WHERE responsible_source = 'OFFICE') AS office_items`,
  );
  const c = counts.rows[0]!;

  const events = await tx.query<{ type: string; occurred_at: Date; producer: { name?: string }; payload: Record<string, unknown>; entity: string | null }>(
    `SELECT o.type, o.occurred_at, o.producer, o.payload, coalesce(e.trade_name, e.legal_name) AS entity
       FROM outbox o LEFT JOIN entity e ON e.id = o.entity_id
      ORDER BY o.occurred_at DESC LIMIT 30`,
  );

  const allAgents = [...DEPARTMENTS.flatMap((d) => d.agents), ...SHARED_AGENTS];
  const operating = new Set(allAgents.filter((a) => a.status === "OPERANDO").map((a) => a.id));
  const totalAgents = new Set(allAgents.map((a) => a.id));
  const nEntities = entities.rows.length;

  const stageFor = (e: (typeof entities.rows)[number]) =>
    PIPELINE_STAGES.map((stage) => {
      switch (stage) {
        case "Implantação": {
          const s = e.onboarding_status;
          if (s === "COMPLETED") return { kind: "done", text: "concluída" };
          if (s === "IN_REVIEW") return { kind: "wait", text: "aguardando aprovação" };
          if (s === "WAITING_HUMAN") return { kind: "wait", text: "aguardando você" };
          if (s === "WAITING_CLIENT") return { kind: "wait", text: "aguardando cliente" };
          return { kind: "run", text: s ? statusPt(s) : "não iniciada" };
        }
        case "Documentos":
          if (!e.has_cert) return { kind: "wait", text: "aguarda certificado A1" };
          if (e.awaiting) return { kind: "wait", text: `${e.awaiting} NF-e aguardando ciência` };
          return { kind: e.dfe_docs ? "done" : "run", text: e.dfe_docs ? `${e.dfe_docs} NF-e recebidas` : "busca SEFAZ ativa" };
        case "Tributos": {
          const sc = e.simples;
          if (sc) {
            const pa = `${sc.competence.slice(5, 7)}/${sc.competence.slice(0, 4)}`;
            if (sc.status === "CALCULADO") return { kind: "run", text: `Simples ${pa} calculado` };
            if (sc.status === "CONFERE") return { kind: "done", text: `Simples ${pa} confere` };
            if (sc.status === "DIVERGE") return { kind: "wait", text: `Simples ${pa} diverge` };
            if (sc.status === "REGRA_PENDENTE") return { kind: "wait", text: "tabelas a aprovar" };
            return { kind: "wait", text: `Simples ${pa}: ${sc.status.toLowerCase().replace(/_/g, " ")}` };
          }
          return e.has_pgdas ? { kind: "done", text: "Receita sincronizada" } : { kind: "future", text: "Fase 5" };
        }
        default: {
          const proc = PROCESSES.find((p) => p.name.startsWith(stage) || (stage === "Cliente" && p.id === "relacionamento"));
          return { kind: "future", text: proc ? proc.phase : "planejado" };
        }
      }
    });

  return {
    kpis: {
      entities: nEntities,
      agentsOperating: operating.size,
      agentsTotal: totalAgents.size,
      inProgress: c.in_progress,
      humanQueue: human.length,
      exceptions: c.exceptions,
      waitingClient: c.waiting_client,
      waitingExternal: c.waiting_external,
      humanTouchesPerClient: nEntities ? Math.round((c.office_items / nEntities) * 10) / 10 : 0,
    },
    processes: PROCESSES,
    stages: PIPELINE_STAGES,
    pipeline: entities.rows.map((e) => ({ id: e.id, name: e.name, cnpj: formatCnpj(e.cnpj), cells: stageFor(e) })),
    human,
    deferred: (await openRevenueExceptions(tx)).filter((d) => d.decision === "ADIAR"),
    events: events.rows.map((ev) => ({
      type: ev.type,
      at: ev.occurred_at.toISOString(),
      agent: agentName(ev.producer?.name),
      entity: ev.entity,
      text: describeEvent(ev.type, ev.payload),
    })),
  };
}

/** Fila humana: pendências do escritório e Cases que esperam aprovação. */
export async function humanQueue(tx: PoolClient) {
  const pend = await tx.query<{
    id: string;
    type: string;
    required_information: string;
    impact: string;
    created_at: Date;
    entity_id: string | null;
    entity: string | null;
    case_id: string | null;
  }>(
    `SELECT p.id, p.type, p.required_information, p.impact, p.created_at, p.entity_id,
            coalesce(e.trade_name, e.legal_name) AS entity, p.case_id
       FROM pending_item p LEFT JOIN entity e ON e.id = p.entity_id
      WHERE p.status = 'OPEN' AND p.responsible_source = 'OFFICE'
      ORDER BY p.created_at`,
  );
  const review = await tx.query<{ id: string; type: string; entity_id: string | null; entity: string | null; updated_at: Date }>(
    `SELECT c.id, c.type, c.entity_id, coalesce(e.trade_name, e.legal_name) AS entity, c.updated_at
       FROM "case" c LEFT JOIN entity e ON e.id = c.entity_id
      WHERE c.status = 'IN_REVIEW' ORDER BY c.updated_at`,
  );
  // Versão nova de regra publicada no catálogo também espera o responsável técnico.
  const rules = await tx.query<{ n: number; codes: string[]; since: Date | null }>(
    `SELECT count(*)::int AS n, coalesce(array_agg(r.code ORDER BY r.code), '{}') AS codes, min(r.created_at) AS since
       FROM obligation_rule r
      WHERE r.valid_to IS NULL AND r.superseded_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM obligation_rule_approval a WHERE a.rule_id = r.id)
        -- só atualização de catálogo: a primeira aprovação vem pela pendência da implantação
        AND EXISTS (SELECT 1 FROM obligation_rule_approval)`,
  );
  const rulePending = pend.rows.some((p) => p.type === "OBLIGATION_RULES_APPROVAL");
  const r0 = rules.rows[0]!;
  const catalog =
    r0.n > 0 && !rulePending
      ? [{
          kind: "rules",
          id: "catalogo",
          type: "OBLIGATION_RULES_APPROVAL",
          entityId: null,
          entity: null,
          caseId: null,
          title: `${r0.n} regra(s) nova(s) ou atualizada(s) no catálogo: ${r0.codes.join(", ")}`,
          impact: "Até a aprovação, as empresas seguem com a versão anterior aprovada",
          since: (r0.since ?? new Date()).toISOString(),
        }]
      : [];
  const ciencia = (await cienciaQueue(tx)).map((c) => ({
    kind: "ciencia",
    id: c.entity_id,
    type: "NFE_CIENCIA",
    entityId: c.entity_id,
    entity: c.entity,
    caseId: null,
    title: `${c.n} NF-e de entrada aguardando ciência da operação`,
    impact: `Total ${Number(c.total ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}. Sem a ciência, a SEFAZ entrega só o resumo; com ela, o XML completo.`,
    since: (c.oldest ?? new Date()).toISOString(),
  }));
  const divergences = new Map((await openRevenueExceptions(tx)).map((d) => [d.case_id, d]));
  const guides = (await guidesNeedingAttention(tx)).map((g) => {
    const pa = `${g.competence.slice(5, 7)}/${g.competence.slice(0, 4)}`;
    const venc = g.due_on ? fmtDate(g.due_on) : "—";
    return {
      kind: "guide",
      id: `${g.entity_id}:${g.competence}`,
      type: g.status === "PAGAMENTO_NAO_IDENTIFICADO" ? "DAS_PAGAMENTO" : "PGDAS_DECLARACAO",
      entityId: g.entity_id,
      entity: g.entity,
      caseId: null,
      title: g.status === "PAGAMENTO_NAO_IDENTIFICADO"
        ? `DAS ${pa}: pagamento ainda não identificado (vencimento ${venc})`
        : `PGDAS-D ${pa}: declaração ainda não identificada (prazo ${venc})`,
      impact: "Situação até a última consulta à Receita. Pode já ter sido resolvido: atualize a competência em Receita Federal ou confirme com o cliente.",
      since: g.created_at.toISOString(),
    };
  });
  const brlFmt = (v: string | null) => Number(v ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const withholdings = (await withholdingsNeedingAttention(tx)).map((w) => {
    const pa = `${w.competence.slice(5, 7)}/${w.competence.slice(0, 4)}`;
    const name = w.tax === "IRRF" ? "IRRF" : "PIS/COFINS/CSLL";
    return {
      kind: "withholding",
      id: `${w.entity_id}:${w.competence}:${w.tax}`,
      type: w.status === "PAGO_DIVERGENTE" ? "RETENCAO_DIVERGENTE" : "RETENCAO_PAGAMENTO",
      entityId: w.entity_id,
      entity: w.entity,
      caseId: null,
      title: w.status === "PAGO_DIVERGENTE"
        ? `${name} retido ${pa}: recolhido ${brlFmt(w.paid)}, retido nas notas tomadas ${brlFmt(w.withheld)}`
        : `${name} retido ${pa} (${brlFmt(w.withheld)}): recolhimento ainda não identificado (vencimento ${w.due_on ? fmtDate(w.due_on) : "—"})`,
      impact: w.status === "PAGO_DIVERGENTE"
        ? "Pode haver nota fora do Emissor Nacional ou retenção de outra competência no mesmo DARF. Confira as notas da competência."
        : "Retido nas NFS-e tomadas e ainda não visto nos pagamentos federais (até a última consulta). Confirme com o cliente ou atualize os pagamentos.",
      since: w.created_at.toISOString(),
    };
  });
  // Vínculo que falhou MAX_ATTEMPTS vezes no mesmo evento espera uma pessoa.
  const failed = await tx.query<{ link_id: string; agent: string; event_type: string; entity_id: string | null; entity: string | null; error: string; at: Date }>(
    `SELECT DISTINCT ON (r.link_id, r.event_id) r.link_id, r.agent, r.event_type, r.entity_id, coalesce(e.trade_name, e.legal_name) AS entity, r.error, r.finished_at AS at
       FROM agent_reaction r LEFT JOIN entity e ON e.id = r.entity_id
      WHERE r.status = 'ERRO'
        AND NOT EXISTS (SELECT 1 FROM inbox i WHERE i.consumer = r.link_id AND i.event_id = r.event_id)
        AND (SELECT count(*) FROM agent_reaction x WHERE x.link_id = r.link_id AND x.event_id = r.event_id AND x.status = 'ERRO') >= $1
      ORDER BY r.link_id, r.event_id, r.finished_at DESC`,
    [MAX_ATTEMPTS],
  );
  const links = failed.rows.map((f) => {
    const l = LINKS.find((x) => x.id === f.link_id);
    return {
      kind: "link",
      id: f.link_id,
      type: "VINCULO_FALHOU",
      entityId: f.entity_id,
      entity: f.entity,
      caseId: null,
      title: `${agentName(f.agent)}: não conseguiu "${l?.does ?? f.link_id}" depois de ${EVENT_LABEL[f.event_type] ?? f.event_type}`,
      impact: `Tentou ${MAX_ATTEMPTS} vezes. Último erro: ${f.error}`,
      since: f.at.toISOString(),
    };
  });
  return [
    ...catalog,
    ...ciencia,
    ...links,
    ...guides,
    ...withholdings,
    ...pend.rows.map((p) => ({
      kind: p.case_id && divergences.has(p.case_id) ? "divergence" : p.type === "CONTRACTED_SERVICES" ? "services" : p.type === "OBLIGATION_RULES_APPROVAL" ? "rules" : "pending",
      divergence: p.case_id ? (divergences.get(p.case_id) ?? null) : null,
      id: p.id,
      type: p.type,
      entityId: p.entity_id,
      entity: p.entity,
      caseId: p.case_id,
      title: p.required_information,
      impact: p.impact,
      since: p.created_at.toISOString(),
    })),
    ...review.rows.map((c) => ({
      kind: "approve",
      id: c.id,
      type: c.type,
      entityId: c.entity_id,
      entity: c.entity,
      caseId: c.id,
      title: `${caseTypePt(c.type)} revisada: aprovar a conclusão`,
      impact: "Com a aprovação, o Case é concluído e a próxima etapa começa",
      since: c.updated_at.toISOString(),
    })),
  ];
}

/** Cases (tela Fechamento / acompanhamento). */
export async function casesList(tx: PoolClient) {
  const { rows } = await tx.query<{
    id: string;
    type: string;
    status: string;
    owner_agent: string;
    competence: string | null;
    created_at: Date;
    updated_at: Date;
    entity: string | null;
    open_pending: number;
    transitions: { at: string; from: string; to: string; reason: string | null; actor: string }[];
  }>(
    `SELECT c.id, c.type, c.status, c.owner_agent, c.competence::text, c.created_at, c.updated_at,
            coalesce(e.trade_name, e.legal_name) AS entity,
            (SELECT count(*)::int FROM pending_item p WHERE p.case_id = c.id AND p.status = 'OPEN') AS open_pending,
            coalesce((SELECT json_agg(json_build_object('at', t.occurred_at, 'from', t.from_status, 'to', t.to_status,
                                                        'reason', t.reason, 'actor', t.actor_id) ORDER BY t.occurred_at)
                        FROM case_transition t WHERE t.case_id = c.id), '[]') AS transitions
       FROM "case" c LEFT JOIN entity e ON e.id = c.entity_id
      ORDER BY c.updated_at DESC LIMIT 100`,
  );
  return rows.map((r) => ({
    id: r.id,
    type: caseTypePt(r.type),
    status: r.status,
    statusPt: statusPt(r.status),
    agent: agentName(r.owner_agent),
    competence: r.competence,
    entity: r.entity,
    openPending: r.open_pending,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    transitions: r.transitions.map((t) => ({ ...t, fromPt: statusPt(t.from), toPt: statusPt(t.to), actor: agentName(t.actor) })),
  }));
}

/** Regras do catálogo de obrigações, com a aprovação do escritório. */
export async function rulesList(tx: PoolClient) {
  const { rows } = await tx.query<{
    id: string; code: string; version: number; name: string; sphere: string; periodicity: string;
    due: unknown; legal_basis: string; notes: string | null; approved_by: string | null; approved_at: Date | null;
    in_use_version: number | null;
  }>(
    `SELECT r.id, r.code, r.version, r.name, r.sphere, r.periodicity, r.due, r.legal_basis, r.notes,
            a.approved_by, a.approved_at,
            (SELECT max(p.version) FROM obligation_rule p JOIN obligation_rule_approval pa ON pa.rule_id = p.id
              WHERE p.code = r.code AND p.valid_to IS NULL) AS in_use_version
       FROM obligation_rule r LEFT JOIN obligation_rule_approval a ON a.rule_id = r.id
      WHERE r.valid_to IS NULL AND r.superseded_at IS NULL ORDER BY r.sphere, r.code`,
  );
  return rows.map((r) => ({ ...r, approved_at: r.approved_at ? r.approved_at.toISOString() : null }));
}

const SERVICE_NAMES: Record<string, string> = { CONTABIL: "Contábil", FISCAL: "Fiscal", FOLHA: "Folha", SOCIETARIO: "Societário", FINANCEIRO: "Financeiro", IRPF: "IRPF" };

export async function entitiesList(tx: PoolClient) {
  const { rows } = await tx.query<{ id: string; name: string; legal_name: string; cnpj: string; regime: string | null; start: string | null; open_items: number }>(
    `SELECT e.id, coalesce(e.trade_name, e.legal_name) AS name, e.legal_name, e.cnpj,
            (SELECT regime FROM tax_regime_history t WHERE t.entity_id = e.id ORDER BY valid_from DESC LIMIT 1) AS regime,
            (SELECT min(valid_from)::text FROM contracted_service_history h WHERE h.entity_id = e.id) AS start,
            (SELECT count(*)::int FROM pending_item p WHERE p.entity_id = e.id AND p.status = 'OPEN') AS open_items
       FROM entity e WHERE e.cnpj IS NOT NULL ORDER BY e.legal_name`,
  );
  return rows.map((r) => ({ ...r, cnpj: formatCnpj(r.cnpj) }));
}

/** Ficha da empresa: perfil, responsabilidade, acessos, obrigações, checklist e Cases. */
export async function entityDetail(tx: PoolClient, entityId: string) {
  const e = await tx.query<{ id: string; legal_name: string; trade_name: string | null; cnpj: string; activity_started_at: string | null; uf: string | null; municipio_ibge: string | null }>(
    `SELECT e.id, e.legal_name, e.trade_name, e.cnpj, e.activity_started_at,
            s.uf, s.municipio_ibge
       FROM entity e LEFT JOIN establishment s ON s.entity_id = e.id AND s.kind = 'MATRIZ'
      WHERE e.id = $1`,
    [entityId],
  );
  const ent = e.rows[0];
  if (!ent) return null;
  const facts = await entityFacts(tx, entityId);
  const services = await tx.query<{ service: string; valid_from: string }>(
    "SELECT service, valid_from::text FROM contracted_service_history WHERE entity_id = $1 AND valid_to IS NULL ORDER BY service",
    [entityId],
  );
  const cnae = await tx.query<{ cnae: string; description: string | null; is_primary: boolean }>(
    `SELECT a.cnae, a.description, a.is_primary FROM activity_history a JOIN establishment s ON s.id = a.establishment_id
      WHERE s.entity_id = $1 AND a.valid_to IS NULL ORDER BY a.is_primary DESC, a.cnae`,
    [entityId],
  );
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  // Vale a versão mais recente da regra já aprovada pelo escritório.
  const obl = await tx.query<{ code: string; version: number; name: string; sphere: string; periodicity: string; due: DueSpec; legal_basis: string; notes: string | null; valid_from: string; reason: Record<string, unknown>; newer_pending: boolean }>(
    `SELECT o.rule_code AS code, r.version, r.name, r.sphere, r.periodicity, r.due, r.legal_basis, r.notes, o.valid_from::text, o.reason,
            EXISTS (SELECT 1 FROM obligation_rule n WHERE n.code = o.rule_code AND n.version > r.version AND n.valid_to IS NULL
                     AND NOT EXISTS (SELECT 1 FROM obligation_rule_approval na WHERE na.rule_id = n.id)) AS newer_pending
       FROM entity_obligation o
       JOIN LATERAL (SELECT x.* FROM obligation_rule x JOIN obligation_rule_approval xa ON xa.rule_id = x.id
                      WHERE x.code = o.rule_code AND x.valid_to IS NULL ORDER BY x.version DESC LIMIT 1) r ON true
      WHERE o.entity_id = $1 AND o.valid_to IS NULL ORDER BY r.sphere, r.code`,
    [entityId],
  );
  const calendar = await loadCalendar(tx);
  const pend = await tx.query<{ id: string; type: string; required_information: string; impact: string; responsible_source: string; status: string; case_type: string | null }>(
    `SELECT p.id, p.type, p.required_information, p.impact, p.responsible_source, p.status, c.type AS case_type
       FROM pending_item p LEFT JOIN "case" c ON c.id = p.case_id
      WHERE p.entity_id = $1 ORDER BY p.status, p.created_at`,
    [entityId],
  );
  const cases = await tx.query<{ id: string; type: string; status: string; updated_at: Date }>(
    `SELECT id, type, status, updated_at FROM "case" WHERE entity_id = $1 ORDER BY created_at`,
    [entityId],
  );
  return {
    id: ent.id,
    legalName: ent.legal_name,
    tradeName: ent.trade_name,
    cnpj: formatCnpj(ent.cnpj),
    activityStartedAt: ent.activity_started_at,
    uf: ent.uf,
    facts,
    services: services.rows.map((r) => ({ code: r.service, name: SERVICE_NAMES[r.service] ?? r.service, since: r.valid_from })),
    cnaes: cnae.rows,
    access: await accessMap(tx, entityId),
    obligations: obl.rows.map((o) => ({ ...o, next: nextDueDates(o.due, today, 2, o.valid_from, calendar) })),
    checklist: pend.rows.map((p) => ({ ...p, caseType: p.case_type ? caseTypePt(p.case_type) : null })),
    cases: cases.rows.map((c) => ({ id: c.id, type: caseTypePt(c.type), status: c.status, statusPt: statusPt(c.status), updatedAt: c.updated_at.toISOString() })),
  };
}

/** Ids que um agente usa no barramento e na auditoria (inclui nomes antigos). */
const AGENT_ALIASES: Record<string, string[]> = {
  onboarding: ["onboarding", "one-onboarding"],
  search: ["search", "one-search"],
  "case-engine": ["case-engine", "pending-engine"],
};

/** Painel "Funcionamento dos agentes": departamentos, agentes, capacidades e atividade real. */
export async function departmentsData(tx: PoolClient) {
  const { rows } = await tx.query<{ id: string; last_at: Date | null; n24: number; n7: number }>(
    `WITH acts AS (
       SELECT producer->>'name' AS id, occurred_at AS at FROM outbox
       UNION ALL
       SELECT actor_id, occurred_at FROM audit_log WHERE actor_kind = 'AGENT'
       UNION ALL
       SELECT agent, finished_at FROM agent_reaction WHERE status = 'OK'
     )
     SELECT id, max(at) AS last_at,
            count(*) FILTER (WHERE at > now() - interval '24 hours')::int AS n24,
            count(*) FILTER (WHERE at > now() - interval '7 days')::int AS n7
       FROM acts GROUP BY id`,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const activity = (a: AgentInfo) => {
    const ids = AGENT_ALIASES[a.id] ?? [a.id];
    let last: Date | null = null;
    let n24 = 0;
    let n7 = 0;
    for (const id of ids) {
      const r = byId.get(id);
      if (!r) continue;
      n24 += r.n24;
      n7 += r.n7;
      if (r.last_at && (!last || r.last_at > last)) last = r.last_at;
    }
    return { lastAt: last ? last.toISOString() : null, actions24h: n24, actions7d: n7 };
  };
  const view = (a: AgentInfo) => ({ ...a, active: a.status === "OPERANDO", ...activity(a) });
  return {
    departments: DEPARTMENTS.map((d) => {
      const agents = d.agents.map(view);
      const caps = d.agents.flatMap((a) => a.capabilities);
      return {
        id: d.id,
        name: d.name,
        summary: d.summary,
        agents,
        activeAgents: agents.filter((a) => a.active).length,
        capabilitiesOn: caps.filter((c) => c.on).length,
        capabilitiesTotal: caps.length,
      };
    }),
    shared: SHARED_AGENTS.map(view),
  };
}

/** Vínculos entre agentes e as últimas reações (tela "Vínculos dos agentes"). */
export async function linksData(tx: PoolClient) {
  const stats = await tx.query<{ link_id: string; ok: number; erro: number; last_at: Date | null }>(
    `SELECT link_id, count(*) FILTER (WHERE status = 'OK')::int AS ok, count(*) FILTER (WHERE status = 'ERRO')::int AS erro, max(finished_at) AS last_at
       FROM agent_reaction WHERE finished_at > now() - interval '7 days' GROUP BY link_id`,
  );
  const by = new Map(stats.rows.map((r) => [r.link_id, r]));
  const recent = await tx.query<{ link_id: string; agent: string; event_type: string; events: number; entity: string | null; status: string; result: Record<string, unknown>; error: string | null; finished_at: Date; ms: number; caused: string[] }>(
    `SELECT r.link_id, r.agent, r.event_type, r.events, coalesce(e.trade_name, e.legal_name) AS entity, r.status, r.result, r.error, r.finished_at,
            (extract(epoch FROM r.finished_at - r.started_at) * 1000)::int AS ms,
            coalesce((SELECT array_agg(o.type ORDER BY o.occurred_at) FROM outbox o
                       WHERE o.causation_id = r.event_id AND o.occurred_at BETWEEN r.started_at AND r.finished_at), '{}') AS caused
       FROM agent_reaction r LEFT JOIN entity e ON e.id = r.entity_id
      ORDER BY r.finished_at DESC LIMIT 40`,
  );
  return {
    links: LINKS.map((l) => {
      const st = by.get(l.id);
      return {
        id: l.id,
        on: l.on.map((t) => ({ type: t, label: EVENT_LABEL[t] ?? t })),
        agent: l.agent,
        agentName: agentName(l.agent),
        does: l.does,
        ok7d: st?.ok ?? 0,
        errors7d: st?.erro ?? 0,
        lastAt: st?.last_at ? st.last_at.toISOString() : null,
      };
    }),
    recent: recent.rows.map((r) => ({
      link: r.link_id,
      agentName: agentName(r.agent),
      event: EVENT_LABEL[r.event_type] ?? r.event_type,
      events: r.events,
      entity: r.entity,
      status: r.status,
      result: r.result,
      error: r.error,
      at: r.finished_at.toISOString(),
      ms: r.ms,
      caused: r.caused.map((t) => describeEventType(t)),
    })),
  };
}

function describeEventType(t: string): string {
  const L: Record<string, string> = {
    REVENUE_DIVERGENCE_DETECTED: "divergência de receita",
    SIMPLES_CALCULATED: "Simples calculado",
    GUIDE_STATUS_CHANGED: "situação de guia",
    CASE_CREATED: "Case aberto",
    CASE_STATUS_CHANGED: "Case atualizado",
    CASE_COMPLETED: "Case concluído",
    PENDING_ITEM_CREATED: "pendência aberta",
    NFSE_BATCH_RECEIVED: "NFS-e recebidas",
  };
  return L[t] ?? t;
}
