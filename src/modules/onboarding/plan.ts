import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { Actor } from "../../shared/actor.js";
import { newId } from "../../shared/ids.js";
import { audit } from "../../platform/audit/audit.js";
import { openCase, transitionCase } from "../../platform/cases/case-engine.js";
import { appendEvent } from "../../platform/events/outbox.js";
import { openPendingItem, type ResponsibleSource } from "../../platform/pending/pending.js";
import { profileAsOf } from "../registry/registry.js";
import type { BusinessCalendar, DueAdjust } from "../regulatory/calendar.js";
import { powerRequirements } from "./powers.js";

/**
 * Plano de implantação (seção 4 da especificação). A partir dos fatos da empresa
 * monta, de forma determinística e reexecutável:
 *  - checklist do que falta receber, agrupado num Case DOCUMENT_REQUEST (o
 *    Relacionamento consolida o pedido ao cliente);
 *  - Case ACCOUNTING_FIRM_MIGRATION quando a empresa já existia antes do início
 *    da responsabilidade e o serviço contábil foi contratado;
 *  - mapa de obrigações, só com regras aprovadas pelo responsável técnico;
 *  - mapa de acessos (calculado a partir dos dados, ver accessMap).
 */

const PRODUCER = { kind: "agent", name: "onboarding", version: "0.2.0" } as const;

export interface EntityFacts {
  entityId: string;
  regime: string | null;
  services: string[];
  responsibilityStart: string | null;
  activityStartedAt: string | null;
  /** Há remuneração (empregados ou pró-labore) nos pagamentos da DCTFWeb. */
  remuneration: boolean;
  /** Há empregados (INSS descontado de segurados empregados, receita 1082). */
  employees: boolean;
  /** Alguma atividade (CNAE) típica de serviço sujeito ao ISS. */
  serviceActivity: boolean;
  /** Reteve IRRF ou PIS/COFINS/CSLL em NFS-e tomada nos últimos 12 meses. */
  withholdingTaken: boolean;
  hasClientCertificate: boolean;
}

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

/** Divisões CNAE de serviços sujeitos ao ISS (aproximação; a regra exige aprovação). */
function isServiceCnae(cnae: string): boolean {
  const div = Number(cnae.slice(0, 2));
  return (div >= 41 && div <= 43) || div >= 58;
}

export async function entityFacts(tx: PoolClient, entityId: string, on = today()): Promise<EntityFacts> {
  const profile = await profileAsOf(tx, entityId, on);
  const e = await tx.query<{ activity_started_at: string | null; start: string | null; cert: boolean }>(
    `SELECT e.activity_started_at,
            (SELECT min(valid_from)::text FROM contracted_service_history h WHERE h.entity_id = e.id) AS start,
            EXISTS (SELECT 1 FROM digital_certificate d WHERE d.entity_id = e.id AND d.status = 'ACTIVE' AND d.valid_to > now()) AS cert
       FROM entity e WHERE e.id = $1`,
    [entityId],
  );
  // Serviços vigentes no início da responsabilidade, quando ela ainda não começou.
  const start = e.rows[0]?.start ?? null;
  const services = profile.services.length ? profile.services : start ? (await profileAsOf(tx, entityId, start)).services : [];
  const pay = await tx.query<{ code: string }>(
    `SELECT DISTINCT b->>'revenueCode' AS code
       FROM federal_payment p, jsonb_array_elements(p.breakdown) b
      WHERE p.entity_id = $1 AND p.collected_on >= ($2::date - interval '12 months')
        AND b->>'revenueCode' IN ('1082', '1099')`,
    [entityId, on],
  );
  const codes = new Set(pay.rows.map((r) => r.code));
  const wt = await tx.query<{ yes: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM nfse_tax t WHERE t.entity_id = $1 AND t.role = 'TOMADA' AND (t.irrf > 0 OR t.csrf > 0)
                       AND t.competence >= date_trunc('month', $2::date - interval '12 months')) AS yes`,
    [entityId, on],
  );
  const cnaes = await tx.query<{ cnae: string }>(
    `SELECT a.cnae FROM activity_history a JOIN establishment s ON s.id = a.establishment_id
      WHERE s.entity_id = $1 AND a.valid_to IS NULL`,
    [entityId],
  );
  return {
    entityId,
    regime: profile.regime,
    services,
    responsibilityStart: start,
    activityStartedAt: e.rows[0]?.activity_started_at ?? null,
    remuneration: codes.has("1082") || codes.has("1099"),
    employees: codes.has("1082"),
    serviceActivity: cnaes.rows.some((r) => isServiceCnae(r.cnae)),
    withholdingTaken: Boolean(wt.rows[0]?.yes),
    hasClientCertificate: Boolean(e.rows[0]?.cert),
  };
}

interface RuleRow {
  id: string;
  code: string;
  version: number;
  name: string;
  conditions: { regimes?: string[]; services_any?: string[]; requires?: string[] };
  valid_from: string;
  valid_to: string | null;
}

/** A regra se aplica? Devolve os fatos que a fizeram valer (ou null). */
export function ruleApplies(rule: Pick<RuleRow, "conditions">, f: EntityFacts): Record<string, unknown> | null {
  const c = rule.conditions;
  if (c.regimes && !(f.regime && c.regimes.includes(f.regime))) return null;
  if (c.services_any && !c.services_any.some((s) => f.services.includes(s))) return null;
  const req: Record<string, boolean> = {
    remuneration: f.remuneration,
    employees: f.employees,
    service_activity: f.serviceActivity,
    withholding_taken: f.withholdingTaken,
  };
  for (const r of c.requires ?? []) if (!req[r]) return null;
  return {
    regime: f.regime,
    services: f.services.filter((s) => !c.services_any || c.services_any.includes(s)),
    requires: c.requires ?? [],
  };
}

/** Gera (ou completa) o mapa de obrigações com as regras aprovadas no escritório. */
export async function buildObligationMap(tx: PoolClient, f: EntityFacts): Promise<{ added: number; pendingApproval: number }> {
  const rules = await tx.query<RuleRow & { approved: boolean }>(
    `SELECT r.id, r.code, r.version, r.name, r.conditions, r.valid_from::text, r.valid_to::text,
            EXISTS (SELECT 1 FROM obligation_rule_approval a WHERE a.rule_id = r.id) AS approved
       FROM obligation_rule r WHERE r.valid_to IS NULL AND r.superseded_at IS NULL ORDER BY r.code`,
  );
  if (!f.responsibilityStart) return { added: 0, pendingApproval: 0 };
  let added = 0;
  let pendingApproval = 0;
  for (const r of rules.rows) {
    const reason = ruleApplies(r, f);
    if (!reason) continue;
    if (!r.approved) {
      pendingApproval++;
      continue;
    }
    const from = r.valid_from > f.responsibilityStart ? r.valid_from : f.responsibilityStart;
    const ins = await tx.query(
      `INSERT INTO entity_obligation (id, tenant_id, entity_id, rule_id, rule_code, valid_from, reason)
       SELECT $1, current_tenant(), $2, $3, $4, $5, $6
        WHERE NOT EXISTS (SELECT 1 FROM entity_obligation o
                           WHERE o.entity_id = $2 AND o.rule_code = $4 AND o.valid_to IS NULL)`,
      [newId(), f.entityId, r.id, r.code, from, JSON.stringify({ ...reason, rule_version: r.version })],
    );
    added += ins.rowCount ?? 0;
  }
  return { added, pendingApproval };
}

interface ChecklistItem {
  type: string;
  responsible: ResponsibleSource;
  info: string;
  impact: string;
}

function checklistFor(f: EntityFacts): ChecklistItem[] {
  const s = new Set(f.services);
  const items: ChecklistItem[] = [];
  if ((s.has("FISCAL") || s.has("CONTABIL")) && !f.hasClientCertificate) {
    items.push({ type: "CLIENT_CERTIFICATE", responsible: "CLIENT", info: "Enviar o certificado A1 (e-CNPJ) da empresa e a senha pelo canal seguro", impact: "Sem ele a IARIS não busca NF-e e NFS-e automaticamente" });
  }
  if (s.has("FISCAL")) {
    items.push({ type: "STATE_REGISTRATION", responsible: "CLIENT", info: "Informar a inscrição estadual (ou confirmar que a empresa não tem)", impact: "Necessária para as obrigações estaduais e notas de mercadoria" });
    items.push({ type: "MUNICIPAL_ACCESS", responsible: "CLIENT", info: "Informar a inscrição municipal e o acesso ao emissor de NFS-e da prefeitura", impact: "Necessário para buscar NFS-e e cumprir as obrigações municipais" });
  }
  if (s.has("FOLHA") && f.remuneration) {
    items.push({ type: "PAYROLL_HANDOVER", responsible: "CLIENT", info: "Enviar a relação de empregados e sócios com pró-labore, a última folha e o acesso ao eSocial", impact: "Sem isso a folha da primeira competência não é calculada" });
  }
  if (s.has("CONTABIL") || s.has("FINANCEIRO")) {
    items.push({ type: "BANK_ACCOUNTS", responsible: "CLIENT", info: "Informar os bancos da empresa e enviar os extratos a partir do início da responsabilidade", impact: "Sem extrato não há conciliação nem fechamento contábil" });
  }
  if (s.has("SOCIETARIO")) {
    items.push({ type: "CORPORATE_DOCUMENTS", responsible: "CLIENT", info: "Enviar o contrato social e a última alteração registrada", impact: "Base para o cadastro societário e alterações futuras" });
  }
  return items;
}

function monthBefore(isoFirstDay: string): string {
  const [y, m] = isoFirstDay.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

export interface PlanResult {
  documentCaseId: string | null;
  migrationCaseId: string | null;
  checklist: number;
  obligationsAdded: number;
  rulesPendingApproval: number;
}

/** Monta o plano de implantação. Idempotente: reexecutar não duplica nada. */
export async function buildImplementationPlan(tx: PoolClient, entityId: string, onboardingCaseId: string | null, actor: Actor): Promise<PlanResult> {
  const f = await entityFacts(tx, entityId);
  const result: PlanResult = { documentCaseId: null, migrationCaseId: null, checklist: 0, obligationsAdded: 0, rulesPendingApproval: 0 };

  // 1. Checklist do que o cliente precisa enviar, num Case de pedido de documentos.
  const items = checklistFor(f);
  if (items.length) {
    const { case: doc } = await openCase(
      tx,
      { type: "DOCUMENT_REQUEST", idempotencyKey: `implantacao-docs:${entityId}`, origin: "onboarding", requester: actor.id, entityId, parentCaseId: onboardingCaseId ?? undefined },
      actor,
    );
    result.documentCaseId = doc.id;
    for (const it of items) {
      const r = await openPendingItem(
        tx,
        { type: it.type, entityId, caseId: doc.id, responsibleSource: it.responsible, requiredInformation: it.info, impact: it.impact, channel: "portal" },
        actor,
      );
      if (r.created) result.checklist++;
    }
    if (doc.status === "OPEN") {
      await transitionCase(tx, { caseId: doc.id, to: "IN_PROGRESS", reason: "checklist da implantação" }, actor);
      await transitionCase(tx, { caseId: doc.id, to: "WAITING_CLIENT", reason: `${items.length} item(ns) com o cliente` }, actor);
    }
  }

  // 2. Migração da contabilidade anterior: a empresa já existia antes da responsabilidade.
  if (f.services.includes("CONTABIL") && f.responsibilityStart && f.activityStartedAt && f.activityStartedAt < f.responsibilityStart) {
    const { case: mig } = await openCase(
      tx,
      { type: "ACCOUNTING_FIRM_MIGRATION", idempotencyKey: `migracao:${entityId}`, origin: "onboarding", requester: actor.id, entityId, parentCaseId: onboardingCaseId ?? undefined },
      actor,
    );
    result.migrationCaseId = mig.id;
    const last = monthBefore(f.responsibilityStart);
    const migItems: ChecklistItem[] = [
      { type: "PREV_TRIAL_BALANCE", responsible: "CLIENT", info: `Balancete de ${last} da contabilidade anterior (último mês antes da Legacy)`, impact: "Base dos saldos de abertura; sem ele os saldos ficam como não validados" },
      { type: "PREV_LEDGER_CHART", responsible: "CLIENT", info: "Razão do último exercício e plano de contas da contabilidade anterior", impact: "Necessário para o de/para de contas e a composição dos saldos" },
      { type: "PREV_BALANCE_COMPOSITION", responsible: "CLIENT", info: "Composição dos saldos: bancos, clientes, fornecedores, estoque, imobilizado, empréstimos", impact: "Saldo sem composição fica marcado como NO_COMPOSITION" },
    ];
    for (const it of migItems) {
      await openPendingItem(tx, { type: it.type, entityId, caseId: mig.id, responsibleSource: it.responsible, requiredInformation: it.info, impact: it.impact, channel: "portal" }, actor);
    }
    if (mig.status === "OPEN") {
      await transitionCase(tx, { caseId: mig.id, to: "IN_PROGRESS", reason: "migração aberta pela implantação" }, actor);
      await transitionCase(tx, { caseId: mig.id, to: "WAITING_CLIENT", reason: "aguardando arquivos da contabilidade anterior" }, actor);
    }
  }

  // 3. Mapa de obrigações (só regras aprovadas).
  const map = await buildObligationMap(tx, f);
  result.obligationsAdded = map.added;
  result.rulesPendingApproval = map.pendingApproval;
  if (map.pendingApproval) {
    await openPendingItem(
      tx,
      {
        type: "OBLIGATION_RULES_APPROVAL",
        entityId: null,
        responsibleSource: "OFFICE",
        requiredInformation: "Aprovar as regras do catálogo de obrigações antes de gerar os mapas das empresas",
        impact: "Sem regras aprovadas, nenhuma obrigação é atribuída automaticamente",
      },
      actor,
    );
  }

  await appendEvent(tx, {
    type: "IMPLEMENTATION_PLAN_CREATED",
    schemaVersion: 1,
    producer: PRODUCER,
    idempotencyKey: `entity:${entityId}:plan:${createHash("sha256").update(JSON.stringify({ result, f })).digest("hex").slice(0, 32)}`,
    entityId,
    caseId: onboardingCaseId,
    correlationId: onboardingCaseId ?? entityId,
    payload: {
      entity_id: entityId,
      checklist_items: items.length,
      obligations_added: result.obligationsAdded,
      rules_pending_approval: result.rulesPendingApproval,
      migration_case_id: result.migrationCaseId,
      facts: { regime: f.regime, services: f.services, remuneration: f.remuneration, employees: f.employees, service_activity: f.serviceActivity, withholding_taken: f.withholdingTaken },
    },
  });
  await audit(tx, {
    actor,
    action: "onboarding.plan_built",
    resourceType: "entity",
    resourceId: entityId,
    entityId,
    caseId: onboardingCaseId,
    data: { ...result, facts: f },
  });
  return result;
}

/** Aprova as regras propostas no escritório e completa os mapas das empresas. */
export async function approveObligationRules(tx: PoolClient, actor: Actor): Promise<{ approved: number; obligationsAdded: number }> {
  const pending = await tx.query<{ id: string; code: string; version: number }>(
    `SELECT r.id, r.code, r.version FROM obligation_rule r
      WHERE r.valid_to IS NULL AND r.superseded_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM obligation_rule_approval a WHERE a.rule_id = r.id)`,
  );
  for (const r of pending.rows) {
    await tx.query(
      "INSERT INTO obligation_rule_approval (id, tenant_id, rule_id, approved_by) VALUES ($1, current_tenant(), $2, $3)",
      [newId(), r.id, actor.id],
    );
    await audit(tx, {
      actor,
      action: "regulatory.rule_approved",
      resourceType: "obligation_rule",
      resourceId: r.id,
      ruleRef: `${r.code}@${r.version}`,
      approvedBy: actor.id,
      data: { code: r.code, version: r.version },
    });
  }
  const ents = await tx.query<{ id: string }>(
    "SELECT DISTINCT entity_id AS id FROM contracted_service_history",
  );
  let added = 0;
  for (const e of ents.rows) added += (await buildObligationMap(tx, await entityFacts(tx, e.id))).added;
  if (pending.rows.length) {
    const rules = pending.rows.map((r) => `${r.code}@${r.version}`).sort();
    await appendEvent(tx, {
      type: "OBLIGATION_RULES_APPROVED",
      schemaVersion: 1,
      producer: { kind: "user", name: actor.id, version: "1" },
      idempotencyKey: `regras:${createHash("sha256").update(pending.rows.map((r) => r.id).sort().join(",")).digest("hex").slice(0, 32)}`,
      payload: { rules, approved_by: actor.id },
    });
  }
  return { approved: pending.rows.length, obligationsAdded: added };
}

/** Próximos vencimentos de uma obrigação a partir de hoje. */
export type DueSpec =
  | { kind: "next_month_day"; day: number; adjust?: DueAdjust }
  | { kind: "annual"; month: number; day: number; adjust?: DueAdjust }
  | null;

export interface DueDate {
  competence: string;
  due: string;
  /** Data da regra antes do ajuste por dia não útil, quando diferente. */
  nominal?: string;
  adjustReason?: string;
}

export function nextDueDates(
  due: DueSpec,
  from: string,
  count = 2,
  /** Primeira competência sob responsabilidade do escritório (anteriores não entram). */
  firstCompetence?: string,
  calendar?: BusinessCalendar,
): DueDate[] {
  if (!due) return [];
  const minComp = firstCompetence ? `${firstCompetence.slice(0, 7)}-01` : "0000-01-01";
  const out: DueDate[] = [];
  const push = (competence: string, nominal: string) => {
    const a = calendar ? calendar.adjust(nominal, due.adjust) : { due: nominal, reason: null };
    if (a.due < from) return;
    out.push(a.reason ? { competence, due: a.due, nominal, adjustReason: a.reason } : { competence, due: a.due });
  };
  const [y, m] = from.split("-").map(Number) as [number, number];
  if (due.kind === "next_month_day") {
    for (let i = -2; out.length < count && i < 24; i++) {
      const comp = new Date(Date.UTC(y, m - 1 + i, 1));
      const c = comp.toISOString().slice(0, 10);
      if (c < minComp) continue;
      push(c, new Date(Date.UTC(comp.getUTCFullYear(), comp.getUTCMonth() + 1, due.day)).toISOString().slice(0, 10));
    }
  } else {
    for (let yy = y - 1; out.length < count && yy < y + 3; yy++) {
      if (`${yy}-12-31` < minComp) continue;
      push(`${yy}-01-01`, `${yy + 1}-${String(due.month).padStart(2, "0")}-${String(due.day).padStart(2, "0")}`);
    }
  }
  return out;
}

/** Mapa de acessos: o que a IARIS consegue acessar por empresa, calculado dos dados. */
export async function accessMap(tx: PoolClient, entityId: string) {
  const r = await tx.query<{ poa_to: string | null; cert: boolean; cert_to: string | null; open: string[] }>(
    `SELECT (SELECT max(coalesce(valid_to, 'infinity'::date))::text FROM power_of_attorney p
              WHERE p.entity_id = $1 AND p.system = 'ECAC' AND current_date <@ daterange(valid_from, valid_to, '[]')) AS poa_to,
            EXISTS (SELECT 1 FROM digital_certificate d WHERE d.entity_id = $1 AND d.status = 'ACTIVE' AND d.valid_to > now()) AS cert,
            (SELECT to_char(max(d.valid_to) AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY') FROM digital_certificate d
              WHERE d.entity_id = $1 AND d.status = 'ACTIVE' AND d.valid_to > now()) AS cert_to,
            coalesce((SELECT array_agg(type) FROM pending_item WHERE entity_id = $1 AND status = 'OPEN'), '{}') AS open`,
    [entityId],
  );
  const x = r.rows[0]!;
  const open = new Set(x.open);
  const poa = !x.poa_to ? null : x.poa_to === "infinity" ? "procuração vigente, sem data de término" : `procuração vigente até ${x.poa_to.split("-").reverse().join("/")}`;
  return [
    { system: "e-CAC / Integra Contador", status: poa ? "OK" : "PENDENTE", detail: poa ?? "sem procuração eletrônica para o escritório" },
    { system: "eSocial / DCTFWeb", status: poa ? "OK" : "PENDENTE", detail: poa ? "pela procuração e-CAC" : "depende da procuração e-CAC" },
    { system: "SEFAZ (NF-e, CT-e)", status: x.cert ? "OK" : "PENDENTE", detail: x.cert ? `certificado A1 no cofre, válido até ${x.cert_to}` : "aguarda certificado A1 da empresa" },
    ...(await powerRequirements(tx, entityId)).map((r) => ({
      system: `${r.name} (procuração)`,
      status: r.status === "OK" ? "OK" : r.status === "VENCE_EM_BREVE" ? "A VENCER" : "PENDENTE",
      detail: r.current
        ? `${r.current.verification === "DOCUMENTO" ? "termo anexado" : "declarada"}${r.current.validTo ? `, válida até ${r.current.validTo.split("-").reverse().join("/")}` : ", sem data de término"}${r.status === "VENCIDA" ? " (vencida)" : ""}`
        : `falta: a empresa ${r.reason}`,
    })),
    { system: "Prefeitura (NFS-e)", status: open.has("MUNICIPAL_ACCESS") ? "PENDENTE" : "A VERIFICAR", detail: open.has("MUNICIPAL_ACCESS") ? "aguarda inscrição municipal e acesso" : "NFS-e pelo Emissor Nacional" },
    { system: "Bancos", status: open.has("BANK_ACCOUNTS") ? "PENDENTE" : "A VERIFICAR", detail: open.has("BANK_ACCOUNTS") ? "aguarda bancos e extratos" : "sem pedido aberto" },
  ];
}
