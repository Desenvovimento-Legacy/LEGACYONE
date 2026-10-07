import { randomBytes } from "node:crypto";
import { acceptInvitation, inviteUser, openInvitation, type Role } from "../src/platform/access/access.js";
import { base32Decode, currentStep, totpCode } from "../src/platform/access/totp.js";
import { appPool } from "./helpers.js";

/** Chave de login dos testes (no sistema real vem do cofre). */
export const AUTH_KEY = randomBytes(32);
export const PASSWORD = "senha-de-teste-forte-123";

/** Convite + primeiro acesso. Devolve o segredo do autenticador para gerar códigos. */
export async function enroll(tenantId: string, email: string, role: Role) {
  const deps = { appPool, tenantId, authKey: AUTH_KEY };
  const inv = await inviteUser(deps, { email, name: "Pessoa Teste", role }, { kind: "USER", id: "luan@legacy.test" });
  const o = await openInvitation(deps, inv.token);
  const secret = base32Decode(o.secretBase32.replace(/\s/g, ""));
  await acceptInvitation(deps, { token: inv.token, password: PASSWORD, code: totpCode(secret, currentStep(new Date()) - 1) });
  return { email, secret, token: inv.token };
}

/** Entra pela tela e devolve o cookie de sessão. */
export async function loginCookie(base: string, email: string, secret: Buffer, step = currentStep(new Date()) + 1): Promise<string> {
  const r = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "X-IARIS-Acao": "login", "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, code: totpCode(secret, step) }),
  });
  if (r.status !== 200) throw new Error(`login ${r.status}: ${await r.text()}`);
  return r.headers.get("set-cookie")!.split(";")[0]!;
}

/** Pessoa com perfil e sessão aberta, pronta para chamar a tela. */
export async function session(base: string, tenantId: string, role: Role = "RESPONSAVEL_TECNICO", email = `luan.${role.toLowerCase()}@legacy.test`) {
  const u = await enroll(tenantId, email, role);
  return loginCookie(base, u.email, u.secret);
}
