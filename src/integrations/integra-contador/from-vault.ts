import { existsSync, readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { createSecureContext } from "node:tls";
import type { SecretStore } from "../../shared/secrets/secrets-file.js";
import { SerproIntegraContador } from "./serpro.js";

export const SERPRO_SECRET_KEYS = [
  "SERPRO_CONTRACT",
  "SERPRO_CONSUMER_KEY",
  "SERPRO_CONSUMER_SECRET",
  "OFFICE_CNPJ",
  "CERT_PFX_PATH",
  "CERT_PFX_PASSWORD",
] as const;

export interface VaultCheck {
  location: string;
  /** Campo → preenchido. Nunca o valor. */
  fields: Record<string, boolean>;
  certificateFileFound: boolean;
  /** Certificado abriu com a senha do cofre. */
  certificateOpened: boolean;
  certificateError?: string;
  /** Dados públicos do certificado (titular e validade), sem chave privada. */
  certificate?: { subject: string; validFrom: string; validTo: string; expired: boolean };
}

/**
 * Confere o cofre sem expor conteúdo: campos preenchidos, .pfx existente e
 * abrindo com a senha. O titular e a validade do certificado são dados
 * públicos (vão em qualquer assinatura) e podem ser exibidos.
 */
export function checkVault(store: SecretStore, now = new Date()): VaultCheck {
  const fields = Object.fromEntries(SERPRO_SECRET_KEYS.map((k) => [k, store.has(k)]));
  const out: VaultCheck = { location: store.location, fields, certificateFileFound: false, certificateOpened: false };
  if (!store.has("CERT_PFX_PATH")) return out;
  const path = store.require("CERT_PFX_PATH");
  out.certificateFileFound = existsSync(path);
  if (!out.certificateFileFound || !store.has("CERT_PFX_PASSWORD")) return out;
  try {
    const pfx = readFileSync(path);
    const ctx = createSecureContext({ pfx, passphrase: store.require("CERT_PFX_PASSWORD") });
    out.certificateOpened = true;
    const der = (ctx.context as unknown as { getCertificate(): Buffer | null }).getCertificate();
    if (der) {
      const x = new X509Certificate(der);
      out.certificate = {
        subject: x.subject.replace(/\n/g, ", "),
        validFrom: new Date(x.validFrom).toISOString().slice(0, 10),
        validTo: new Date(x.validTo).toISOString().slice(0, 10),
        expired: new Date(x.validTo).getTime() < now.getTime(),
      };
    }
  } catch (e) {
    const msg = (e as Error).message ?? "";
    out.certificateError = /mac verify failure|bad decrypt/i.test(msg)
      ? "senha não confere com o .pfx"
      : /unsupported/i.test(msg)
        ? "pfx com criptografia legada: reexportar marcando AES256-SHA256"
        : "arquivo não é um .pfx válido";
  }
  return out;
}

/** Monta o conector real a partir do cofre. Lança erro citando só o nome do campo faltante. */
export function serproFromVault(store: SecretStore): SerproIntegraContador {
  const pfxPath = store.require("CERT_PFX_PATH");
  if (!existsSync(pfxPath)) throw new Error("Arquivo do certificado (CERT_PFX_PATH) não encontrado");
  return new SerproIntegraContador({
    consumerKey: store.require("SERPRO_CONSUMER_KEY"),
    consumerSecret: store.require("SERPRO_CONSUMER_SECRET"),
    officeCnpj: store.require("OFFICE_CNPJ"),
    certificate: { pfx: readFileSync(pfxPath), passphrase: store.require("CERT_PFX_PASSWORD") },
  });
}
