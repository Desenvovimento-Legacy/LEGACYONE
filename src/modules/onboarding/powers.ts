import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { audit } from "../../platform/audit/audit.js";
import { appendEvent } from "../../platform/events/outbox.js";
import { openPendingItem, resolvePendingItem } from "../../platform/pending/pending.js";
import type { Actor } from "../../shared/actor.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";
import { entityFacts } from "./plan.js";

/**
 * Agente Identidade digital — procurações estaduais (SEFAZ) e municipais (Prefeitura).
 *
 * Quais a empresa precisa (com serviço Fiscal contratado), pelo estabelecimento matriz:
 *   SEFAZ da UF      comércio ou indústria: anexo I/II declarado no PGDAS-D ou CNAE das divisões 01–33 e 45–47
 *   Prefeitura       serviço (CNAE), NFS-e prestada, ou ISS retido como tomadora
 * Falta ou vencida → pedido ao cliente (pendência). Vence em até 30 dias → Fila humana.
 * Registro só por pessoa, com o termo/print anexado ou declarado.
 */

export const DI_AGENT: Actor = { kind: "AGENT", id: "digital-identity" };
export const POWER_WARN_DAYS = 30;
export type LocalSystem = "SEFAZ" | "PREFEITURA";

export class PowerError extends Error {}

export interface PowerRequirement {
  system: LocalSystem;
  jurisdiction: string;
  name: string;
  reason: string;
  current: { validFrom: string; validTo: string | null; verification: string; protocol: string | null; registeredBy: string | null } | null;
  status: "OK" | "VENCE_EM_BREVE" | "VENCIDA" | "FALTA";
}

const PENDING_TYPE: Record<LocalSystem, string> = { SEFAZ: "PROCURACAO_SEFAZ", PREFEITURA: "PROCURACAO_PREFEITURA" };
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const br = (iso: string) => iso.split("-").reverse().join("/");

async function cityName(tx: PoolClient, entityId: string, code: string): Promise<string> {
  const r = await tx.query<{ n: string | null }>(
    `SELECT coalesce(
       (SELECT incidence_city_name FROM nfse_tax WHERE entity_id = $1 AND incidence_city = $2 AND incidence_city_name IS NOT NULL LIMIT 1),
       (SELECT incidence_city_name FROM nfse_tax WHERE incidence_city = $2 AND incidence_city_name IS NOT NULL LIMIT 1)) AS n`,
    [entityId, code],
  );
  return r.rows[0]?.n ?? `município IBGE ${code}`;
}

export async function powerRequirements(tx: PoolClient, entityId: string, on = today()): Promise<PowerRequirement[]> {
  const est = await tx.query<{ uf: string; municipio_ibge: string }>(
    "SELECT uf, municipio_ibge FROM establishment WHERE entity_id = $1 AND kind = 'MATRIZ' LIMIT 1",
    [entityId],
  );
  const m = est.rows[0];
  if (!m) return [];
  const facts = await entityFacts(tx, entityId, on);
  if (!facts.services.includes("FISCAL")) return [];
  const f = await tx.query<{ goods: boolean; goods_cnae: boolean; service_cnae: boolean; prestada: boolean; iss_taken: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pgdas_declared_tax WHERE entity_id = $1 AND annex IN ('I', 'II')) AS goods,
            EXISTS (SELECT 1 FROM activity_history a JOIN establishment s ON s.id = a.establishment_id
                     WHERE s.entity_id = $1 AND a.valid_to IS NULL
                       AND (substr(a.cnae, 1, 2)::int BETWEEN 1 AND 33 OR substr(a.cnae, 1, 2)::int BETWEEN 45 AND 47)) AS goods_cnae,
            EXISTS (SELECT 1 FROM activity_history a JOIN establishment s ON s.id = a.establishment_id
                     WHERE s.entity_id = $1 AND a.valid_to IS NULL
                       AND (substr(a.cnae, 1, 2)::int BETWEEN 41 AND 43 OR substr(a.cnae, 1, 2)::int >= 58)) AS service_cnae,
            EXISTS (SELECT 1 FROM nfse_document WHERE entity_id = $1 AND role = 'PRESTADA') AS prestada,
            EXISTS (SELECT 1 FROM nfse_tax WHERE entity_id = $1 AND role = 'TOMADA' AND iss_withheld > 0) AS iss_taken`,
    [entityId],
  );
  const x = f.rows[0]!;
  const needs: { system: LocalSystem; jurisdiction: string; name: string; reason: string }[] = [];
  if (x.goods || x.goods_cnae) {
    needs.push({ system: "SEFAZ", jurisdiction: m.uf, name: `SEFAZ-${m.uf}`, reason: x.goods ? "vende mercadorias (anexo I/II no PGDAS-D): ICMS" : "CNAE de comércio ou indústria: ICMS" });
  }
  if (x.service_cnae || x.prestada || x.iss_taken) {
    const reasons = [x.prestada && "emite NFS-e", x.iss_taken && "retém ISS como tomadora", !x.prestada && x.service_cnae && "CNAE de serviço"].filter(Boolean);
    needs.push({ system: "PREFEITURA", jurisdiction: m.municipio_ibge, name: `Prefeitura de ${await cityName(tx, entityId, m.municipio_ibge)}`, reason: reasons.join(" e ") });
  }
  const out: PowerRequirement[] = [];
  for (const n of needs) {
    const p = await tx.query<{ valid_from: string; valid_to: string | null; verification: string; protocol: string | null; registered_by: string | null }>(
      `SELECT valid_from::text, valid_to::text, verification, protocol, registered_by FROM power_of_attorney
        WHERE entity_id = $1 AND system = $2 AND jurisdiction = $3 AND valid_from <= $4
        ORDER BY created_at DESC LIMIT 1`,
      [entityId, n.system, n.jurisdiction, on],
    );
    const c = p.rows[0];
    const current = c ? { validFrom: c.valid_from, validTo: c.valid_to, verification: c.verification, protocol: c.protocol, registeredBy: c.registered_by } : null;
    const status: PowerRequirement["status"] = !c ? "FALTA" : c.valid_to && c.valid_to < on ? "VENCIDA" : c.valid_to && c.valid_to <= addDays(on, POWER_WARN_DAYS) ? "VENCE_EM_BREVE" : "OK";
    out.push({ ...n, current, status });
  }
  return out;
}

/** Abre o pedido ao cliente para o que falta ou venceu; fecha o pedido quando já há procuração vigente. */
export async function refreshPowerRequirements(pool: Pool, tenantId: string, entityId: string, actor: Actor = DI_AGENT) {
  return withTenant(pool, tenantId, async (tx) => {
    const reqs = await powerRequirements(tx, entityId);
    let opened = 0;
    let resolved = 0;
    const office = await officeDocument(tx);
    for (const r of reqs) {
      const type = PENDING_TYPE[r.system];
      if (r.status === "FALTA" || r.status === "VENCIDA") {
        const o = await openPendingItem(tx, {
          type, entityId, responsibleSource: "CLIENT", channel: "portal",
          requiredInformation: `${r.status === "VENCIDA" ? "Renovar" : "Outorgar"} procuração eletrônica na ${r.name} para o escritório${office ? ` (CNPJ ${office})` : ""} e enviar o termo ou print`,
          impact: `Necessária porque a empresa ${r.reason}. Sem ela, o escritório não acessa as declarações e guias desse órgão.`,
        }, actor);
        if (o.created) opened++;
      } else {
        const open = await tx.query<{ id: string }>("SELECT id FROM pending_item WHERE entity_id = $1 AND type = $2 AND status = 'OPEN'", [entityId, type]);
        for (const p of open.rows) {
          await resolvePendingItem(tx, { id: p.id, resolution: `Procuração na ${r.name} registrada${r.current?.validTo ? `, válida até ${br(r.current.validTo)}` : ""}` }, actor);
          resolved++;
        }
      }
    }
    return { required: reqs.length, opened, resolved };
  });
}

async function officeDocument(tx: PoolClient): Promise<string | null> {
  const r = await tx.query<{ d: string }>("SELECT grantee_document AS d FROM power_of_attorney WHERE system = 'ECAC' ORDER BY created_at DESC LIMIT 1");
  return r.rows[0]?.d ?? null;
}

export interface RegisterPowerInput {
  entityId: string;
  system: LocalSystem;
  validFrom: string;
  validTo: string | null;
  protocol: string | null;
  scopes: string[];
  file: { name: string; bytes: Buffer } | null;
}

/** Registro pela tela (decisão de pessoa). Órgão pelo estabelecimento matriz. */
export async function registerPower(pool: Pool, tenantId: string, input: RegisterPowerInput, actor: Actor) {
  if (actor.kind !== "USER") throw new PowerError("Só uma pessoa registra procuração");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.validFrom)) throw new PowerError("Informe o início da validade");
  if (input.validTo && (!/^\d{4}-\d{2}-\d{2}$/.test(input.validTo) || input.validTo < input.validFrom)) throw new PowerError("Fim da validade inválido");
  if (input.file && input.file.bytes.length > 5 * 1024 * 1024) throw new PowerError("Arquivo acima de 5 MB");
  const r = await withTenant(pool, tenantId, async (tx) => {
    const reqs = await powerRequirements(tx, input.entityId);
    const est = await tx.query<{ uf: string; municipio_ibge: string }>("SELECT uf, municipio_ibge FROM establishment WHERE entity_id = $1 AND kind = 'MATRIZ'", [input.entityId]);
    const m = est.rows[0];
    if (!m) throw new PowerError("Empresa sem estabelecimento matriz");
    const jurisdiction = input.system === "SEFAZ" ? m.uf : m.municipio_ibge;
    const name = reqs.find((x) => x.system === input.system)?.name
      ?? (input.system === "SEFAZ" ? `SEFAZ-${m.uf}` : `Prefeitura de ${await cityName(tx, input.entityId, m.municipio_ibge)}`);
    const office = (await officeDocument(tx)) ?? "";
    const id = newId();
    const sha = input.file ? createHash("sha256").update(input.file.bytes).digest() : null;
    await tx.query(
      `INSERT INTO power_of_attorney (id, tenant_id, entity_id, system, grantee_document, scopes, valid_from, valid_to, source, verified_at,
                                      jurisdiction, jurisdiction_name, protocol, file_name, document, document_sha256, registered_by, verification)
       VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, 'TELA', clock_timestamp(), $8, $9, $10, $11, $12, $13, $14, $15)`,
      [id, input.entityId, input.system, office, input.scopes, input.validFrom, input.validTo, jurisdiction, name, input.protocol,
        input.file?.name.slice(0, 200) ?? null, input.file?.bytes ?? null, sha, actor.id, input.file ? "DOCUMENTO" : "DECLARACAO"],
    );
    await appendEvent(tx, {
      type: "POWER_OF_ATTORNEY_REGISTERED",
      schemaVersion: 1,
      producer: { kind: "user", name: actor.id, version: "1" },
      idempotencyKey: `procuracao:${id}`,
      entityId: input.entityId,
      payload: { entity_id: input.entityId, system: input.system, jurisdiction, name, valid_from: input.validFrom, valid_to: input.validTo, verification: input.file ? "DOCUMENTO" : "DECLARACAO" },
    });
    await audit(tx, {
      actor, action: "identity.power_registered", resourceType: "power_of_attorney", resourceId: id, entityId: input.entityId,
      data: { system: input.system, jurisdiction, name, valid_from: input.validFrom, valid_to: input.validTo, protocol: input.protocol, file: input.file?.name ?? null, sha256: sha?.toString("hex") ?? null },
      evidenceRefs: input.file ? [`power_of_attorney:${id}`] : [],
    });
    return { id, name };
  });
  await refreshPowerRequirements(pool, tenantId, input.entityId, actor);
  return r;
}

/** Procurações estaduais/municipais vencendo em até 30 dias (para a Fila humana). */
export async function powersExpiringSoon(tx: PoolClient, on = today()) {
  const { rows } = await tx.query<{ entity_id: string; entity: string; name: string; valid_to: string; created_at: Date }>(
    `SELECT p.entity_id, coalesce(e.trade_name, e.legal_name) AS entity, p.jurisdiction_name AS name, p.valid_to::text, p.created_at
       FROM (SELECT DISTINCT ON (entity_id, system, jurisdiction) * FROM power_of_attorney
              WHERE system IN ('SEFAZ', 'PREFEITURA') ORDER BY entity_id, system, jurisdiction, created_at DESC) p
       JOIN entity e ON e.id = p.entity_id
      WHERE p.valid_to IS NOT NULL AND p.valid_to >= $1 AND p.valid_to <= $2
      ORDER BY p.valid_to`,
    [on, addDays(on, POWER_WARN_DAYS)],
  );
  return rows;
}
