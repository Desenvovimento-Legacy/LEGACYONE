import type { Pool, PoolClient } from "pg";
import type { Actor } from "../../shared/actor.js";
import { isValidCnpj, normalizeCnpj } from "../../shared/br/documents.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";
import { audit } from "../../platform/audit/audit.js";
import { getCase, openCase, transitionCase, type CaseRow } from "../../platform/cases/case-engine.js";
import type { CaseStatus } from "../../platform/cases/state-machine.js";
import { appendEvent } from "../../platform/events/outbox.js";
import { storeExternalSnapshot } from "../../platform/evidence/snapshot.js";
import { openPendingItem, openPendingItems, resolvePendingItem, type PendingItemRow } from "../../platform/pending/pending.js";
import { CnpjNotFoundError, type CnpjPublicDataSource, type PublicCompanyData } from "../../integrations/cnpj-public/types.js";
import type { IntegraContador } from "../../integrations/integra-contador/types.js";
import { reserveBilledCalls, type MeteringPolicy } from "../../platform/metering/metering.js";
import { entityTypeFromLegalNature } from "../registry/legal-nature.js";
import { createClient, createEntity, setEntityType, setTaxRegime } from "../registry/registry.js";

/**
 * One Onboarding — Case CLIENT_ONBOARDING a partir do CNPJ.
 *
 * Quem inicia: pedido do cliente ou do escritório (só o CNPJ).
 * O que faz sozinho: busca dados públicos, monta o perfil temporal da entidade
 * (tipo, regime, estabelecimento, CNAEs, sócios), guarda a evidência e verifica
 * a procuração no Integra Contador.
 * Humano por exceção: só o que não pode ser inferido vira pendência
 * (serviços contratados, regime fora do Simples, procuração ausente).
 * Reexecução é segura: não duplica entidade, pendência nem evento.
 */

export const ONBOARDING_AGENT: Actor = { kind: "AGENT", id: "one-onboarding" };
const PRODUCER = { kind: "agent", name: "one-onboarding", version: "0.1.0" } as const;

export interface OnboardingDeps {
  appPool: Pool;
  publicData: CnpjPublicDataSource;
  /** null enquanto o conector real não estiver configurado. */
  integra: IntegraContador | null;
  /** Teto de consultas cobradas; a consulta de procuração é cobrada. */
  metering?: MeteringPolicy;
}

export interface OnboardingResult {
  caseId: string;
  caseStatus: CaseStatus;
  entityId: string | null;
  entityCreated: boolean;
  profile: PublicCompanyData | null;
  /** Fonte que respondeu a consulta pública. */
  profileSource?: string;
  pending: PendingItemRow[];
}

function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function findEntityByCnpj(tx: PoolClient, cnpj: string): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>("SELECT id FROM entity WHERE cnpj = $1", [cnpj]);
  return rows[0]?.id ?? null;
}

/** Cria entidade, matriz, CNAEs, sócios, tipo e regime a partir dos dados públicos. */
async function buildEntity(
  tx: PoolClient,
  c: CaseRow,
  d: PublicCompanyData,
  source: string,
  actor: Actor,
): Promise<{ entityId: string; entityType: string | null; regime: string | null; activities: number }> {
  const started = d.activityStartedAt ?? today();
  const clientId = await createClient(tx, d.legalName, actor);
  const entityId = await createEntity(
    tx,
    { personKind: "PJ", clientId, cnpj: d.cnpj, legalName: d.legalName, tradeName: d.tradeName ?? undefined },
    actor,
  );
  await tx.query("UPDATE entity SET activity_started_at = $2 WHERE id = $1", [entityId, d.activityStartedAt]);

  const establishmentId = newId();
  await tx.query(
    `INSERT INTO establishment (id, tenant_id, entity_id, kind, cnpj, uf, municipio_ibge, opened_at)
     VALUES ($1, current_tenant(), $2, 'MATRIZ', $3, $4, $5, $6)`,
    [establishmentId, entityId, d.cnpj, d.address.uf, d.address.municipioIbge, started],
  );

  // A base pública informa os CNAEs atuais, não a data de cada alteração:
  // a vigência parte do início de atividade e a origem fica registrada.
  const activities = [{ ...d.primaryCnae, primary: true }, ...d.secondaryCnaes.map((s) => ({ ...s, primary: false }))];
  for (const a of activities) {
    await tx.query(
      `INSERT INTO activity_history (id, tenant_id, establishment_id, cnae, description, is_primary, valid_from, source)
       VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7)`,
      [newId(), establishmentId, a.code, a.description, a.primary, started, source],
    );
  }

  for (const p of d.partners) {
    await tx.query(
      `INSERT INTO partner_history (id, tenant_id, entity_id, name, document_masked, qualification_code, qualification,
                                    is_administrator, valid_from, source)
       VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        newId(),
        entityId,
        p.name,
        p.documentMasked,
        p.qualificationCode,
        p.qualification,
        /administrador/i.test(p.qualification ?? ""),
        p.since ?? started,
        source,
      ],
    );
  }

  const entityType = entityTypeFromLegalNature(d.legalNatureCode);
  if (entityType) {
    await setEntityType(tx, { entityId, entityType: entityType as never, validFrom: started, source }, actor);
  } else {
    await openPendingItem(
      tx,
      {
        type: "ENTITY_TYPE_UNKNOWN",
        entityId,
        caseId: c.id,
        responsibleSource: "OFFICE",
        requiredInformation: `Classificar o tipo de entidade: natureza jurídica ${d.legalNatureCode} (${d.legalNature}) sem mapeamento`,
        impact: "Regras e obrigações dependentes do tipo de entidade ficam suspensas",
      },
      actor,
    );
  }

  let regime: string | null = null;
  if (d.mei.optant && d.mei.since) {
    regime = "MEI";
    await setTaxRegime(tx, { entityId, regime: "MEI", validFrom: d.mei.since, source }, actor);
  } else if (d.simples.optant && d.simples.since) {
    regime = "SIMPLES_NACIONAL";
    await setTaxRegime(tx, { entityId, regime: "SIMPLES_NACIONAL", validFrom: d.simples.since, source }, actor);
  } else {
    if (d.simples.since && d.simples.excludedAt) {
      await setTaxRegime(
        tx,
        {
          entityId,
          regime: "SIMPLES_NACIONAL",
          validFrom: d.simples.since,
          validTo: dayBefore(d.simples.excludedAt),
          source,
        },
        actor,
      );
    }
    await openPendingItem(
      tx,
      {
        type: "TAX_REGIME_UNKNOWN",
        entityId,
        caseId: c.id,
        responsibleSource: "OFFICE",
        requiredInformation: d.simples.excludedAt
          ? `Informar o regime vigente após a exclusão do Simples em ${d.simples.excludedAt} (Presumido, Real ou Arbitrado)`
          : "Informar o regime tributário (Presumido, Real ou Arbitrado): não é optante do Simples",
        impact: "Apuração e mapa de obrigações não podem ser montados",
      },
      actor,
    );
  }

  await appendEvent(tx, {
    type: "ENTITY_PROFILE_CREATED",
    schemaVersion: 1,
    producer: PRODUCER,
    idempotencyKey: `entity:${entityId}:profile-created`,
    entityId,
    caseId: c.id,
    correlationId: c.id,
    payload: {
      entity_id: entityId,
      cnpj: d.cnpj,
      entity_type: entityType,
      regime,
      establishments: 1,
      activities: activities.length,
      partners: d.partners.length,
      source,
    },
  });

  return { entityId, entityType, regime, activities: activities.length };
}

async function checkPowerOfAttorney(
  deps: OnboardingDeps,
  tenantId: string,
  c: CaseRow,
  entityId: string,
  cnpj: string,
  actor: Actor,
): Promise<void> {
  if (!deps.integra) {
    await withTenant(deps.appPool, tenantId, (tx) =>
      openPendingItem(
        tx,
        {
          type: "POWER_OF_ATTORNEY_CHECK",
          entityId,
          caseId: c.id,
          responsibleSource: "EXTERNAL",
          requiredInformation: "Verificar procuração e-CAC: conector Integra Contador ainda não configurado",
          impact: "Consultas ao e-CAC, PGDAS-D e DCTFWeb aguardam a verificação",
        },
        actor,
      ),
    );
    return;
  }

  // Procuração vigente já verificada: não consulta de novo (a consulta é cobrada).
  const known = await withTenant(deps.appPool, tenantId, async (tx) => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
    const { rowCount } = await tx.query(
      `SELECT 1 FROM power_of_attorney
        WHERE entity_id = $1 AND system = 'ECAC' AND $2::date <@ daterange(valid_from, valid_to, '[]')`,
      [entityId, today],
    );
    if (rowCount) {
      for (const p of (await openPendingItems(tx, { entityId })).filter((x) => x.type === "POWER_OF_ATTORNEY_CHECK")) {
        await resolvePendingItem(tx, { id: p.id, resolution: "procuração vigente já verificada" }, actor);
      }
    }
    return Boolean(rowCount);
  });
  if (known) return;

  if (deps.metering) {
    await reserveBilledCalls(
      deps.appPool,
      tenantId,
      deps.metering,
      [{ entityId, system: "PROCURACOES", service: "OBTERPROCURACAO41", requestRef: { cnpj } }],
      actor,
    );
  }
  // Consulta de procurações é feita com a identidade do escritório; não exige
  // procuração prévia do cliente.
  const result = await deps.integra.checkPowerOfAttorney(cnpj);
  await withTenant(deps.appPool, tenantId, async (tx) => {
    const snap = await storeExternalSnapshot(tx, {
      source: result.source,
      requestKey: `procuracao:${cnpj}`,
      payload: result.raw,
      fetchedAt: result.fetchedAt,
      entityId,
    });
    const v = result.value;
    // Data civil de São Paulo: vencimento de procuração é contado por dia.
    const verifiedOn = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(result.fetchedAt);

    // A verificação aconteceu: a pendência de "verificar" deixa de existir.
    const open = await openPendingItems(tx, { entityId });
    for (const p of open.filter((x) => x.type === "POWER_OF_ATTORNEY_CHECK")) {
      await resolvePendingItem(tx, { id: p.id, resolution: `verificada via ${result.source} (evidência ${snap.id})` }, actor);
    }

    if (v.active) {
      for (const p of open.filter((x) => x.type === "POWER_OF_ATTORNEY_MISSING")) {
        await resolvePendingItem(tx, { id: p.id, resolution: `procuração vigente via ${result.source} (evidência ${snap.id})` }, actor);
      }
      // Uma linha por procuração vigente; reexecução não duplica.
      for (const g of v.grants) {
        const exists = await tx.query(
          `SELECT 1 FROM power_of_attorney
            WHERE entity_id = $1 AND system = 'ECAC' AND grantee_document = $2
              AND valid_to IS NOT DISTINCT FROM $3::date AND scopes = $4::text[]`,
          [entityId, v.grantee, g.validTo, g.services],
        );
        if (exists.rowCount) continue;
        await tx.query(
          `INSERT INTO power_of_attorney (id, tenant_id, entity_id, system, grantee_document, scopes, valid_from,
                                          valid_to, source, verified_at, snapshot_id)
           VALUES ($1, current_tenant(), $2, 'ECAC', $3, $4, $5, $6, $7, $8, $9)`,
          [newId(), entityId, v.grantee, g.services, g.validFrom ?? verifiedOn, g.validTo, result.source, result.fetchedAt, snap.id],
        );
      }
    } else {
      await openPendingItem(
        tx,
        {
          type: "POWER_OF_ATTORNEY_MISSING",
          entityId,
          caseId: c.id,
          responsibleSource: "CLIENT",
          requiredInformation:
            `Outorgar procuração eletrônica no e-CAC para o CNPJ do escritório (${v.grantee}). ` +
            "Se a procuração atual foi dada ao CPF do contador, é preciso outorgar ao CNPJ ou assinar o termo de autorização",
          impact: "Sem procuração o escritório não consulta nem transmite em nome da empresa",
          channel: "portal",
        },
        actor,
      );
    }
    await appendEvent(tx, {
      type: "POWER_OF_ATTORNEY_VERIFIED",
      schemaVersion: 1,
      producer: PRODUCER,
      idempotencyKey: `entity:${entityId}:poa:${snap.sha256}`,
      entityId,
      caseId: c.id,
      correlationId: c.id,
      evidenceRefs: [snap.id],
      payload: { entity_id: entityId, system: "ECAC", active: v.active, services: v.services, source: result.source },
    });
  });
}

/** Decide o próximo estado do Case a partir das pendências abertas. */
function nextStatus(pending: PendingItemRow[]): CaseStatus {
  if (pending.some((p) => p.responsible_source === "CLIENT")) return "WAITING_CLIENT";
  if (pending.some((p) => p.responsible_source === "OFFICE")) return "WAITING_HUMAN";
  if (pending.some((p) => p.responsible_source === "EXTERNAL")) return "WAITING_EXTERNAL";
  return "IN_REVIEW";
}

export async function onboardByCnpj(
  deps: OnboardingDeps,
  tenantId: string,
  input: { cnpj: string; requester: string; origin?: string },
  actor: Actor = ONBOARDING_AGENT,
): Promise<OnboardingResult> {
  const cnpj = normalizeCnpj(input.cnpj);
  if (!isValidCnpj(cnpj)) throw new Error(`CNPJ inválido: ${input.cnpj}`);

  // 1. Case (idempotente pelo CNPJ) e início do processamento.
  const c = await withTenant(deps.appPool, tenantId, async (tx) => {
    const { case: opened } = await openCase(
      tx,
      {
        type: "CLIENT_ONBOARDING",
        idempotencyKey: `onboarding:${cnpj}`,
        origin: input.origin ?? "office",
        requester: input.requester,
      },
      actor,
    );
    if (opened.status === "COMPLETED" || opened.status === "CANCELLED") return opened;
    return (await transitionCase(tx, { caseId: opened.id, to: "IN_PROGRESS", reason: "onboarding iniciado" }, actor)).case;
  });
  if (c.status === "COMPLETED" || c.status === "CANCELLED") {
    return { caseId: c.id, caseStatus: c.status, entityId: c.entity_id, entityCreated: false, profile: null, pending: [] };
  }

  // 2. Dados públicos (fora da transação: rede não segura conexão do banco).
  let lookup;
  try {
    lookup = await deps.publicData.lookup(cnpj);
  } catch (err) {
    if (!(err instanceof CnpjNotFoundError)) throw err;
    return withTenant(deps.appPool, tenantId, async (tx) => {
      await openPendingItem(
        tx,
        {
          type: "CNPJ_NOT_FOUND",
          caseId: c.id,
          responsibleSource: "OFFICE",
          requiredInformation: `CNPJ ${cnpj} não encontrado na base pública: confirmar o número`,
          impact: "Onboarding não pode prosseguir",
        },
        actor,
      );
      const after = await transitionCase(tx, { caseId: c.id, to: "WAITING_HUMAN", reason: "CNPJ não encontrado" }, actor);
      return { caseId: c.id, caseStatus: after.case.status, entityId: null, entityCreated: false, profile: null, pending: await openPendingItems(tx, { caseId: c.id }) };
    });
  }
  const d = lookup.data;

  // 3. Evidência + perfil da entidade.
  const built = await withTenant(deps.appPool, tenantId, async (tx) => {
    const existing = await findEntityByCnpj(tx, cnpj);
    const snapshot = (entityId: string | null) =>
      storeExternalSnapshot(tx, {
        source: lookup.source,
        requestKey: `cnpj:${cnpj}`,
        payload: lookup.raw,
        fetchedAt: lookup.fetchedAt,
        entityId,
      });

    if (existing) {
      await snapshot(existing);
      return { entityId: existing, created: false };
    }

    if (!d.isHeadOffice) {
      await snapshot(null);
      await openPendingItem(
        tx,
        {
          type: "CNPJ_IS_BRANCH",
          caseId: c.id,
          responsibleSource: "OFFICE",
          requiredInformation: `O CNPJ ${cnpj} é de filial: iniciar o onboarding pela matriz`,
          impact: "Onboarding não pode prosseguir",
        },
        actor,
      );
      return { entityId: null, created: false };
    }
    if (d.registrationStatus.toUpperCase() !== "ATIVA") {
      await snapshot(null);
      await openPendingItem(
        tx,
        {
          type: "CNPJ_NOT_ACTIVE",
          caseId: c.id,
          responsibleSource: "OFFICE",
          requiredInformation: `Situação cadastral ${d.registrationStatus}: decidir se o onboarding segue (ex.: regularização)`,
          impact: "Onboarding suspenso até decisão",
        },
        actor,
      );
      return { entityId: null, created: false };
    }

    const r = await buildEntity(tx, c, d, lookup.source, actor);
    const snap = await snapshot(r.entityId);
    await tx.query(`UPDATE "case" SET entity_id = $2 WHERE id = $1`, [c.id, r.entityId]);
    await openPendingItem(
      tx,
      {
        type: "CONTRACTED_SERVICES",
        entityId: r.entityId,
        caseId: c.id,
        responsibleSource: "OFFICE",
        requiredInformation: "Informar os serviços contratados (contábil, fiscal, folha, societário) e a data de início",
        impact: "Sem os serviços contratados o mapa de obrigações não é gerado",
      },
      actor,
    );
    await audit(tx, {
      actor,
      action: "onboarding.profile_built",
      resourceType: "entity",
      resourceId: r.entityId,
      entityId: r.entityId,
      caseId: c.id,
      evidenceRefs: [snap.id],
      data: { cnpj, entity_type: r.entityType, regime: r.regime, activities: r.activities },
    });
    return { entityId: r.entityId, created: true };
  });

  // 4. Procuração.
  if (built.entityId) {
    await checkPowerOfAttorney(deps, tenantId, c, built.entityId, cnpj, actor);
  }

  // 5. Próximo estado do Case.
  return withTenant(deps.appPool, tenantId, async (tx) => {
    const pending = await openPendingItems(tx, { caseId: c.id });
    const target = nextStatus(pending);
    const current = await getCase(tx, c.id);
    let status = current!.status;
    if (status !== target) {
      status = (await transitionCase(tx, { caseId: c.id, to: target, reason: `${pending.length} pendência(s)` }, actor)).case.status;
    }
    return {
      caseId: c.id,
      caseStatus: status,
      entityId: built.entityId,
      entityCreated: built.created,
      profile: d,
      profileSource: lookup.source,
      pending,
    };
  });
}
