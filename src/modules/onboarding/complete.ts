import type { Pool } from "pg";
import { z } from "zod";
import type { Actor } from "../../shared/actor.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { audit } from "../../platform/audit/audit.js";
import { getCase, transitionCase } from "../../platform/cases/case-engine.js";
import { appendEvent } from "../../platform/events/outbox.js";
import { openPendingItems, resolvePendingItem } from "../../platform/pending/pending.js";
import { addContractedService, ContractedService } from "../registry/registry.js";
import { approveObligationRules, buildImplementationPlan, type PlanResult } from "./plan.js";

/**
 * Decisões humanas que encerram a implantação:
 *  1. o escritório informa os serviços contratados e a data de início da
 *     responsabilidade (decisão empresarial) → a pendência fecha e o Case
 *     segue sozinho para revisão;
 *  2. o gestor aprova a implantação revisada → Case concluído.
 * Nada é sobrescrito: serviço é vigência nova; aprovação é transição auditada.
 */

const PRODUCER = { kind: "agent", name: "onboarding", version: "0.2.0" } as const;

export const ServicesInput = z.object({
  pendingItemId: z.uuid(),
  services: z.array(ContractedService).min(1, "Escolha ao menos um serviço"),
  /** Início da responsabilidade do escritório: dia 1 de uma competência. */
  startDate: z.iso.date().refine((d) => d.endsWith("-01"), "A data de início deve ser o dia 1 de uma competência"),
});

export class HumanActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanActionError";
  }
}

export async function defineContractedServices(
  pool: Pool,
  tenantId: string,
  raw: z.input<typeof ServicesInput>,
  actor: Actor,
): Promise<{ caseId: string | null; caseStatus: string | null; plan: PlanResult }> {
  const input = ServicesInput.parse(raw);
  return withTenant(pool, tenantId, async (tx) => {
    const { rows } = await tx.query<{ id: string; entity_id: string | null; case_id: string | null; type: string; status: string }>(
      "SELECT id, entity_id, case_id, type, status FROM pending_item WHERE id = $1 FOR UPDATE",
      [input.pendingItemId],
    );
    const item = rows[0];
    if (!item) throw new HumanActionError("Pendência não encontrada");
    if (item.type !== "CONTRACTED_SERVICES") throw new HumanActionError("Esta pendência não é de serviços contratados");
    if (item.status !== "OPEN") throw new HumanActionError("Esta pendência já foi resolvida");
    if (!item.entity_id) throw new HumanActionError("Pendência sem empresa");

    const services = [...new Set(input.services)].sort();
    for (const service of services) {
      await addContractedService(
        tx,
        { entityId: item.entity_id, service, validFrom: input.startDate, source: `informado por ${actor.id}` },
        actor,
      );
    }
    await resolvePendingItem(
      tx,
      { id: item.id, resolution: `serviços ${services.join(", ")} a partir de ${input.startDate}` },
      actor,
    );
    await appendEvent(tx, {
      type: "CONTRACTED_SERVICES_DEFINED",
      schemaVersion: 1,
      producer: PRODUCER,
      idempotencyKey: `entity:${item.entity_id}:services:${input.startDate}:${services.join("+")}`,
      entityId: item.entity_id,
      caseId: item.case_id,
      correlationId: item.case_id ?? item.entity_id,
      payload: { entity_id: item.entity_id, services, valid_from: input.startDate, defined_by: actor.id },
    });

    // Próximo passo automático: plano de implantação (checklist, migração, obrigações).
    const plan = await buildImplementationPlan(tx, item.entity_id, item.case_id, actor);

    // O Case segue sozinho: sem pendência aberta, vai para revisão.
    if (!item.case_id) return { caseId: null, caseStatus: null, plan };
    const open = await openPendingItems(tx, { caseId: item.case_id });
    let c = await getCase(tx, item.case_id);
    if (c && open.length === 0 && c.status.startsWith("WAITING_")) {
      c = (await transitionCase(tx, { caseId: c.id, to: "IN_PROGRESS", reason: "pendências resolvidas" }, actor)).case;
      c = (await transitionCase(tx, { caseId: c.id, to: "IN_REVIEW", reason: "implantação pronta para revisão" }, actor)).case;
    }
    return { caseId: item.case_id, caseStatus: c?.status ?? null, plan };
  });
}

/** Aprovação humana de um Case revisado. Só conclui sem pendência aberta. */
export async function approveCase(pool: Pool, tenantId: string, caseId: string, actor: Actor): Promise<string> {
  if (actor.kind !== "USER") throw new HumanActionError("Só uma pessoa aprova a conclusão");
  return withTenant(pool, tenantId, async (tx) => {
    const c = await getCase(tx, caseId);
    if (!c) throw new HumanActionError("Case não encontrado");
    if (c.status !== "IN_REVIEW") throw new HumanActionError("O Case não está em revisão");
    const open = await openPendingItems(tx, { caseId });
    if (open.length) throw new HumanActionError(`Há ${open.length} pendência(s) aberta(s)`);
    const done = await transitionCase(tx, { caseId, to: "COMPLETED", reason: `aprovado por ${actor.id}` }, actor);
    await audit(tx, {
      actor,
      action: "case.approve",
      resourceType: "case",
      resourceId: caseId,
      caseId,
      entityId: c.entity_id,
      approvedBy: actor.id,
      data: { type: c.type },
    });
    return done.case.status;
  });
}

/** Aprovação, pelo responsável técnico, das regras propostas do catálogo de obrigações. */
export async function approveRules(pool: Pool, tenantId: string, actor: Actor) {
  if (actor.kind !== "USER") throw new HumanActionError("Só uma pessoa aprova regras");
  return withTenant(pool, tenantId, async (tx) => {
    const r = await approveObligationRules(tx, actor);
    const open = await tx.query<{ id: string }>(
      "SELECT id FROM pending_item WHERE status = 'OPEN' AND type = 'OBLIGATION_RULES_APPROVAL'",
    );
    for (const p of open.rows) {
      await resolvePendingItem(tx, { id: p.id, resolution: `${r.approved} regra(s) aprovada(s) por ${actor.id}` }, actor);
    }
    return r;
  });
}
