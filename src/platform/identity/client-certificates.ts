import { createHash, X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSecureContext } from "node:tls";
import type { Pool } from "pg";
import type { Actor } from "../../shared/actor.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";
import type { SecretStore } from "../../shared/secrets/secrets-file.js";
import { audit } from "../audit/audit.js";
import { appendEvent, type Producer } from "../events/outbox.js";
import { resolvePendingItem } from "../pending/pending.js";

/**
 * Digital Identity — certificados A1 dos clientes no cofre local.
 *
 * Convenção do cofre (fase piloto):
 *   <pasta do cofre>\clientes\<CNPJ>.pfx    arquivo do certificado
 *   CERT_<CNPJ>_PASSWORD=...                 senha, no segredos.env
 *
 * A AIRES abre o .pfx só para conferir: senha, CNPJ do titular e validade.
 * No banco ficam apenas dados públicos (titular, série, validade, impressão
 * digital) e a referência ao arquivo — nunca a chave privada nem a senha.
 */

export type CertificateCheckStatus =
  | "OK"
  | "NAO_ENCONTRADO"
  | "SEM_SENHA"
  | "SENHA_INCORRETA"
  | "CRIPTOGRAFIA_LEGADA"
  | "ARQUIVO_INVALIDO"
  | "CNPJ_DIFERENTE"
  | "VENCIDO";

export interface PfxInfo {
  subject: string;
  serialNumber: string;
  validFrom: Date;
  validTo: Date;
  /** CNPJ do titular, tirado do nome do certificado ICP-Brasil (RAZÃO SOCIAL:CNPJ). */
  holderDocument: string | null;
  fingerprint256: string;
}

export class PfxError extends Error {
  constructor(readonly status: CertificateCheckStatus) {
    super(status);
    this.name = "PfxError";
  }
}

const PRODUCER: Producer = { kind: "service", name: "digital-identity", version: "1" };
export const EXPIRY_WARNING_DAYS = 30;

/** Abre o .pfx em memória e devolve só dados públicos. */
export function inspectPfx(pfx: Buffer, passphrase: string): PfxInfo {
  let der: Buffer | null;
  try {
    const ctx = createSecureContext({ pfx, passphrase });
    der = (ctx.context as unknown as { getCertificate(): Buffer | null }).getCertificate();
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (/mac verify failure|bad decrypt|invalid password/i.test(msg)) throw new PfxError("SENHA_INCORRETA");
    if (/unsupported/i.test(msg)) throw new PfxError("CRIPTOGRAFIA_LEGADA");
    throw new PfxError("ARQUIVO_INVALIDO");
  }
  if (!der) throw new PfxError("ARQUIVO_INVALIDO");
  const x = new X509Certificate(der);
  const cn = /(?:^|\n)CN=([^\n]+)/.exec(x.subject)?.[1] ?? "";
  const doc = /:([0-9A-Z]{12}[0-9]{2})$/.exec(cn.trim())?.[1] ?? null;
  return {
    subject: x.subject.replace(/\n/g, ", "),
    serialNumber: x.serialNumber,
    validFrom: new Date(x.validFrom),
    validTo: new Date(x.validTo),
    holderDocument: doc,
    fingerprint256: createHash("sha256").update(der).digest("hex"),
  };
}

export function clientCertificatePath(store: SecretStore, cnpj: string): string {
  return join(dirname(store.location), "clientes", `${cnpj}.pfx`);
}

export function clientPasswordKey(cnpj: string): string {
  return `CERT_${cnpj}_PASSWORD`;
}

export interface CertificateCheckResult {
  entityId: string;
  name: string;
  cnpj: string;
  status: CertificateCheckStatus;
  message: string;
  validTo?: string;
  expiresInDays?: number;
  /** Certificado novo registrado agora (false = já estava registrado). */
  registered?: boolean;
}

const MESSAGES: Record<CertificateCheckStatus, string> = {
  OK: "certificado conferido",
  NAO_ENCONTRADO: "arquivo não está no cofre",
  SEM_SENHA: "falta a senha no segredos.env",
  SENHA_INCORRETA: "senha não confere com o arquivo",
  CRIPTOGRAFIA_LEGADA: "arquivo com criptografia antiga: reexportar o .pfx com AES-256",
  ARQUIVO_INVALIDO: "arquivo não é um certificado .pfx válido",
  CNPJ_DIFERENTE: "certificado é de outro CNPJ",
  VENCIDO: "certificado vencido",
};

/**
 * Confere o cofre para todas as empresas do escritório e registra os
 * certificados válidos. Idempotente: o mesmo certificado não é registrado duas
 * vezes; um certificado novo substitui o anterior (status REPLACED).
 * Não consulta nenhum órgão externo.
 */
export async function syncClientCertificates(
  appPool: Pool,
  tenantId: string,
  store: SecretStore,
  actor: Actor,
  now = new Date(),
): Promise<CertificateCheckResult[]> {
  const entities = await withTenant(appPool, tenantId, (tx) =>
    tx.query<{ id: string; name: string; cnpj: string }>(
      "SELECT id, coalesce(trade_name, legal_name) AS name, cnpj FROM entity WHERE cnpj IS NOT NULL ORDER BY legal_name",
    ),
  );
  const out: CertificateCheckResult[] = [];
  for (const e of entities.rows) {
    const base = { entityId: e.id, name: e.name, cnpj: e.cnpj };
    const path = clientCertificatePath(store, e.cnpj);
    const fail = (status: CertificateCheckStatus, extra: Partial<CertificateCheckResult> = {}) =>
      out.push({ ...base, status, message: MESSAGES[status], ...extra });
    if (!existsSync(path)) {
      fail("NAO_ENCONTRADO");
      continue;
    }
    if (!store.has(clientPasswordKey(e.cnpj))) {
      fail("SEM_SENHA");
      continue;
    }
    let info: PfxInfo;
    try {
      info = inspectPfx(readFileSync(path), store.require(clientPasswordKey(e.cnpj)));
    } catch (err) {
      fail(err instanceof PfxError ? err.status : "ARQUIVO_INVALIDO");
      continue;
    }
    // e-CNPJ da matriz vale para as filiais: basta a mesma raiz (8 primeiros caracteres).
    if (!info.holderDocument || info.holderDocument.slice(0, 8) !== e.cnpj.slice(0, 8)) {
      fail("CNPJ_DIFERENTE");
      continue;
    }
    const validTo = info.validTo.toISOString().slice(0, 10);
    const expiresInDays = Math.floor((info.validTo.getTime() - now.getTime()) / 86_400_000);
    if (info.validTo.getTime() <= now.getTime()) {
      fail("VENCIDO", { validTo, expiresInDays });
      continue;
    }

    const registered = await withTenant(appPool, tenantId, async (tx) => {
      const existing = await tx.query<{ id: string }>("SELECT id FROM digital_certificate WHERE serial_number = $1", [info.serialNumber]);
      if (existing.rows[0]) return false;
      const certId = newId();
      const replaced = await tx.query<{ id: string }>(
        "UPDATE digital_certificate SET status = 'REPLACED' WHERE entity_id = $1 AND status = 'ACTIVE' RETURNING id",
        [e.id],
      );
      await tx.query(
        `INSERT INTO digital_certificate (id, tenant_id, owner_kind, entity_id, holder_document, kind, subject, serial_number,
                                          valid_from, valid_to, vault_ref)
         VALUES ($1, current_tenant(), 'ENTITY', $2, $3, 'A1', $4, $5, $6, $7, $8)`,
        [certId, e.id, info.holderDocument, info.subject, info.serialNumber, info.validFrom, info.validTo, `cofre-local:clientes/${e.cnpj}.pfx`],
      );
      await appendEvent(tx, {
        type: "DIGITAL_CERTIFICATE_REGISTERED",
        schemaVersion: 1,
        producer: PRODUCER,
        idempotencyKey: `certificate:${info.serialNumber}`,
        entityId: e.id,
        payload: {
          entity_id: e.id,
          certificate_id: certId,
          kind: "A1",
          holder_document: info.holderDocument!,
          valid_to: validTo,
          replaced: replaced.rows.length,
        },
      });
      await audit(tx, {
        actor,
        action: "identity.certificate_registered",
        resourceType: "digital_certificate",
        resourceId: certId,
        entityId: e.id,
        data: { serial_number: info.serialNumber, fingerprint256: info.fingerprint256, valid_to: validTo, replaced: replaced.rows.map((r) => r.id) },
      });
      const pend = await tx.query<{ id: string }>(
        "SELECT id FROM pending_item WHERE entity_id = $1 AND type = 'CLIENT_CERTIFICATE' AND status = 'OPEN'",
        [e.id],
      );
      for (const p of pend.rows) {
        await resolvePendingItem(tx, { id: p.id, resolution: `Certificado A1 conferido no cofre, válido até ${validTo.split("-").reverse().join("/")}` }, actor);
      }
      return true;
    });
    out.push({
      ...base,
      status: "OK",
      message: expiresInDays <= EXPIRY_WARNING_DAYS ? `certificado conferido; vence em ${expiresInDays} dia(s)` : MESSAGES.OK,
      validTo,
      expiresInDays,
      registered,
    });
  }
  return out;
}
