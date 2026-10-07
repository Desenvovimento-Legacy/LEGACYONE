import { createHmac, randomBytes } from "node:crypto";

/** Autenticador de 2 etapas (RFC 6238: SHA-1, 6 dígitos, 30 s) — Google Authenticator, Microsoft Authenticator etc. */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_PERIOD = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Chave base32 inválida");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): Buffer {
  return randomBytes(20);
}

export function totpCode(secret: Buffer, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", secret).update(msg).digest();
  const off = h[h.length - 1]! & 15;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 1_000_000).padStart(6, "0");
}

export function currentStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD);
}

/** Aceita o passo atual e um de cada lado (relógio do celular adiantado/atrasado). Devolve o passo usado ou null. */
export function matchTotp(secret: Buffer, code: string, now: Date): number | null {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const s = currentStep(now);
  for (const step of [s, s - 1, s + 1]) if (totpCode(secret, step) === c) return step;
  return null;
}

export function otpauthUri(secret: Buffer, account: string, issuer = "IARIS"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_PERIOD}`;
}
