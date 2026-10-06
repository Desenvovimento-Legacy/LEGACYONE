import { createHash, X509Certificate } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
 *   <pasta do cofre>\clientes\...\*<CNPJ>*.pfx   arquivo (qualquer subpasta; o CNPJ
 *                                               no nome do arquivo identifica a empresa)
 *   CERT_<CNPJ>_PASSWORD=...                     senha, no segredos.env
 * Com mais de um arquivo para o mesmo CNPJ (cópias, renovações), vale o que
 * abre com a senha e tem a validade mais longa.
 *
 * O nome do arquivo nunca é gravado nem exibido (há escritórios que anotam a
 * senha no nome): a referência no banco é pelo CNPJ.
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

export function clientCertificatesDir(store: SecretStore): string {
  return join(dirname(store.location), "clientes");
}

export function clientCertificatePath(store: SecretStore, cnpj: string): string {
  return join(clientCertificatesDir(store), `${cnpj}.pfx`);
}

/** Todos os .pfx da pasta de clientes (com subpastas), com o "nome só de letras e números" para casar o CNPJ. */
function listPfx(dir: string, depth = 0): { path: string; key: string }[] {
  if (depth > 4 || !existsSync(dir)) return [];
  const out: { path: string; key: string }[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...listPfx(full, depth + 1));
    else if (/\.(pfx|p12)$/i.test(name)) out.push({ path: full, key: name.toUpperCase().replace(/[^0-9A-Z]/g, "") });
  }
  return out;
}

/** Arquivos candidatos para o CNPJ: nome exato primeiro, depois qualquer nome que contenha o CNPJ. */
export function findClientCertificateFiles(store: SecretStore, cnpj: string, all = listPfx(clientCertificatesDir(store))): string[] {
  const exact = clientCertificatePath(store, cnpj);
  const found = all.filter((f) => f.key.includes(cnpj)).map((f) => f.path);
  return [...new Set([...(existsSync(exact) ? [exact] : []), ...found])];
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
  /** Quantos arquivos com o CNPJ no nome foram encontrados. */
  files?: number;
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
  const all = listPfx(clientCertificatesDir(store));
  for (const e of entities.rows) {
    const base = { entityId: e.id, name: e.name, cnpj: e.cnpj };
    const files = findClientCertificateFiles(store, e.cnpj, all);
    const fail = (status: CertificateCheckStatus, extra: Partial<CertificateCheckResult> = {}) =>
      out.push({ ...base, status, message: MESSAGES[status], ...extra });
    if (!files.length) {
      fail("NAO_ENCONTRADO");
      continue;
    }
    if (!store.has(clientPasswordKey(e.cnpj))) {
      fail("SEM_SENHA", { files: files.length });
      continue;
    }
    // Abre cada candidato; fica o que abre, é do CNPJ e vence por último.
    const password = store.require(clientPasswordKey(e.cnpj));
    let info: PfxInfo | null = null;
    let file: string | null = null;
    let worst: CertificateCheckStatus = "ARQUIVO_INVALIDO";
    const rank: CertificateCheckStatus[] = ["ARQUIVO_INVALIDO", "CRIPTOGRAFIA_LEGADA", "SENHA_INCORRETA", "CNPJ_DIFERENTE"];
    for (const f of files) {
      try {
        const i = inspectPfx(readFileSync(f), password);
        // e-CNPJ da matriz vale para as filiais: basta a mesma raiz (8 primeiros caracteres).
        if (!i.holderDocument || i.holderDocument.slice(0, 8) !== e.cnpj.slice(0, 8)) {
          worst = "CNPJ_DIFERENTE";
          continue;
        }
        if (!info || i.validTo > info.validTo) {
          info = i;
          file = f;
        }
      } catch (err) {
        const st = err instanceof PfxError ? err.status : "ARQUIVO_INVALIDO";
        if (rank.indexOf(st) > rank.indexOf(worst)) worst = st;
      }
    }
    if (!info || !file) {
      fail(worst, { files: files.length });
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
        [certId, e.id, info.holderDocument, info.subject, info.serialNumber, info.validFrom, info.validTo, `cofre-local:clientes/cnpj=${e.cnpj}`],
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
      files: files.length,
    });
  }
  return out;
}

/**
 * Certificado para TLS mútuo com órgão externo: o arquivo do CNPJ que abre com a
 * senha do cofre, é da mesma raiz e vence por último. Fica só em memória.
 * Devolve null (sem detalhes) quando não há certificado utilizável.
 */
export function loadClientCertificate(store: SecretStore, cnpj: string, now = new Date()): { pfx: Buffer; passphrase: string; validTo: Date } | null {
  if (!store.has(clientPasswordKey(cnpj))) return null;
  const passphrase = store.require(clientPasswordKey(cnpj));
  let best: { pfx: Buffer; passphrase: string; validTo: Date } | null = null;
  for (const f of findClientCertificateFiles(store, cnpj)) {
    try {
      const pfx = readFileSync(f);
      const i = inspectPfx(pfx, passphrase);
      if (!i.holderDocument || i.holderDocument.slice(0, 8) !== cnpj.slice(0, 8) || i.validTo <= now) continue;
      if (!best || i.validTo > best.validTo) best = { pfx, passphrase, validTo: i.validTo };
    } catch {
      // arquivo que não abre não serve; a conferência (syncClientCertificates) explica o motivo
    }
  }
  return best;
}
