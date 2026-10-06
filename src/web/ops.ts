import type { PoolClient } from "pg";
import { agentName, PIPELINE_STAGES, PROCESSES } from "../platform/agents/catalog.js";
import { formatCnpj } from "../shared/br/documents.js";
import { accessMap, entityFacts, nextDueDates, type DueSpec } from "../modules/onboarding/plan.js";
import { loadCalendar } from "../modules/regulatory/calendar.js";

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
  }>(
    `SELECT e.id, coalesce(e.trade_name, e.legal_name) AS name, e.cnpj,
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

  const operating = new Set(PROCESSES.filter((p) => p.status === "OPERANDO").flatMap((p) => p.agents));
  const totalAgents = new Set(PROCESSES.flatMap((p) => p.agents));
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
          return e.has_cert ? { kind: "run", text: "certificado ok · conector em construção" } : { kind: "wait", text: "aguarda certificado A1" };
        case "Tributos":
          return e.has_pgdas ? { kind: "done", text: "Receita sincronizada" } : { kind: "future", text: "Fase 5" };
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
  return [
    ...catalog,
    ...pend.rows.map((p) => ({
      kind: p.type === "CONTRACTED_SERVICES" ? "services" : p.type === "OBLIGATION_RULES_APPROVAL" ? "rules" : "pending",
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
