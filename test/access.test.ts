import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FakeIntegraContador } from "../src/integrations/integra-contador/fake.js";
import { acceptInvitation, inviteUser, login, MAX_FAILURES, openInvitation, revokeUser, sessionFromToken } from "../src/platform/access/access.js";
import { base32Decode, currentStep, totpCode } from "../src/platform/access/totp.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { createWebServer } from "../src/web/server.js";
import { AUTH_KEY, enroll, loginCookie, PASSWORD } from "./auth-helpers.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const LUAN = { kind: "USER" as const, id: "luan@legacy.test" };
let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function server(t: string, publicOrigin: string | null = null) {
  const integra = new FakeIntegraContador("11222333000181", {}, {});
  const s = createWebServer({ appPool, tenantId: t, officeName: "Escritório Teste", integra, metering: { provider: "serpro", dailyLimit: 20 }, port: 0, authKey: AUTH_KEY, publicOrigin });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  close = () => new Promise((r) => s.close(() => r()));
  return { base, integra };
}

describe("login: senha + autenticador, perfis e sessão", () => {
  it("convite de uso único; senha fraca e código errado recusados; segredos nunca no banco em texto", async () => {
    const t = await newTenant();
    const deps = { appPool, tenantId: t, authKey: AUTH_KEY };
    const inv = await inviteUser(deps, { email: "Ana@Escritorio.test", name: "Ana", role: "LEITURA" }, LUAN);
    const o = await openInvitation(deps, inv.token);
    expect(o).toMatchObject({ email: "ana@escritorio.test", roleLabel: "Leitura" });
    const secret = base32Decode(o.secretBase32.replace(/\s/g, ""));
    await expect(acceptInvitation(deps, { token: inv.token, password: "curta", code: "000000" })).rejects.toThrow(/12 caracteres/);
    await expect(acceptInvitation(deps, { token: inv.token, password: PASSWORD, code: "000000" })).rejects.toThrow(/não confere/);
    await acceptInvitation(deps, { token: inv.token, password: PASSWORD, code: totpCode(secret, currentStep(new Date())) });
    await expect(openInvitation(deps, inv.token)).rejects.toThrow(/já usado/);

    await withTenant(appPool, t, async (tx) => {
      const c = await tx.query("SELECT password_hash, totp_secret_enc FROM user_credential");
      expect(c.rows[0].password_hash).toMatch(/^scrypt\$/);
      expect(c.rows[0].totp_secret_enc).toMatch(/^v1\./);
      expect(JSON.stringify(c.rows)).not.toContain(PASSWORD);
      const s = await tx.query("SELECT count(*)::int AS n FROM user_invitation WHERE token_hash = convert_to($1, 'UTF8')", [inv.token]);
      expect(s.rows[0].n).toBe(0); // token guardado só como hash
    });

    // O mesmo código não vale duas vezes.
    const step = currentStep(new Date()) + 1;
    const ok = await login(deps, { email: "ana@escritorio.test", password: PASSWORD, code: totpCode(secret, step) });
    expect(ok.user).toMatchObject({ role: "LEITURA", permissions: ["ver"] });
    await expect(login(deps, { email: "ana@escritorio.test", password: PASSWORD, code: totpCode(secret, step) })).rejects.toThrow(/inválidos/);
    expect(await sessionFromToken(deps, ok.token)).toMatchObject({ email: "ana@escritorio.test" });

    // Revogar encerra a sessão aberta.
    await revokeUser(deps, "ana@escritorio.test", "saiu do projeto", LUAN);
    expect(await sessionFromToken(deps, ok.token)).toBeNull();
    await expect(login(deps, { email: "ana@escritorio.test", password: PASSWORD, code: totpCode(secret, step - 1) })).rejects.toThrow(/inválidos/);
  });

  it(`bloqueia depois de ${MAX_FAILURES} erros, mesmo com a senha certa`, async () => {
    const t = await newTenant();
    const deps = { appPool, tenantId: t, authKey: AUTH_KEY };
    const u = await enroll(t, "bia@escritorio.test", "OPERADOR");
    for (let i = 0; i < MAX_FAILURES; i++) {
      await expect(login(deps, { email: u.email, password: "senha-errada-123456", code: "123456" })).rejects.toThrow(/inválidos/);
    }
    await expect(login(deps, { email: u.email, password: PASSWORD, code: totpCode(u.secret, currentStep(new Date()) + 1) })).rejects.toThrow(/Muitas tentativas/);
  });

  it("tela: sem sessão só a página de entrada; perfil Leitura vê mas não age; Sair encerra", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    const { base, integra } = await server(t);

    const home = await (await fetch(`${base}/`)).text();
    expect(home).toContain("Entrar");
    expect(home).not.toContain("Central de agentes");
    expect((await fetch(`${base}/api/central`)).status).toBe(401);
    // Host de outro domínio (DNS rebinding) é recusado antes de qualquer coisa.
    const status = await new Promise<number>((resolve, reject) => {
      const r = request(`${base}/api/central`, { headers: { host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      r.on("error", reject);
      r.end();
    });
    expect(status).toBe(421);

    const u = await enroll(t, "leitor@escritorio.test", "LEITURA");
    const cookie = await loginCookie(base, u.email, u.secret);
    const get = (p: string) => fetch(`${base}${p}`, { headers: { cookie } });
    expect(await (await get("/")).text()).toContain("Central de agentes");
    expect(await (await get("/api/sessao")).json()).toMatchObject({ roleLabel: "Leitura", permissions: ["ver"] });
    expect((await get("/api/central")).status).toBe(200);

    const buscar = await fetch(`${base}/api/empresa/${entityId}/competencia/2026-08/buscar`, { method: "POST", headers: { cookie, "X-IARIS-Acao": "buscar" } });
    expect(buscar.status).toBe(403);
    expect((await buscar.json()).erro).toMatch(/Leitura/);
    expect(integra.calls).toEqual([]);
    expect((await fetch(`${base}/api/simples/regras/aprovar`, { method: "POST", headers: { cookie, "X-IARIS-Acao": "aprovar" } })).status).toBe(403);

    const sair = await fetch(`${base}/api/sair`, { method: "POST", headers: { cookie, "X-IARIS-Acao": "sair" } });
    expect(sair.status).toBe(200);
    expect((await get("/api/central")).status).toBe(401);

    await withTenant(appPool, t, async (tx) => {
      const a = await tx.query("SELECT action FROM audit_log WHERE action LIKE 'auth.%' OR action LIKE 'user.%' ORDER BY seq");
      expect(a.rows.map((r) => r.action)).toEqual(["user.invite", "user.enroll", "auth.login", "auth.logout"]);
    });
  });

  it("tela de usuários: só o Responsável técnico convida, troca perfil e revoga; nunca fica sem responsável", async () => {
    const t = await newTenant();
    const { base } = await server(t);
    const rt = await enroll(t, "luan@escritorio.test", "RESPONSAVEL_TECNICO");
    const cookie = await loginCookie(base, rt.email, rt.secret);
    const call = (path: string, body: unknown, c = cookie) =>
      fetch(`${base}${path}`, { method: "POST", headers: { cookie: c, "X-IARIS-Acao": "usuarios", "content-type": "application/json" }, body: JSON.stringify(body) });

    const inv = await call("/api/usuarios/convidar", { name: "Carla", email: "carla@escritorio.test", role: "LEITURA" });
    const ib = await inv.json();
    expect(inv.status, JSON.stringify(ib)).toBe(200);
    expect(ib.link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/convite#t=[A-Za-z0-9_-]{40,}$/);
    const list = await (await fetch(`${base}/api/usuarios`, { headers: { cookie } })).json();
    expect(list.users.map((u: { email: string; status: string }) => [u.email, u.status])).toEqual(
      expect.arrayContaining([["carla@escritorio.test", "CONVITE_PENDENTE"], ["luan@escritorio.test", "ATIVO"]]),
    );

    // Leitura não administra usuários.
    const le = await enroll(t, "leo@escritorio.test", "LEITURA");
    const lc = await loginCookie(base, le.email, le.secret);
    expect((await fetch(`${base}/api/usuarios`, { headers: { cookie: lc } })).status).toBe(403);
    expect((await call("/api/usuarios/convidar", { name: "X", email: "x@escritorio.test", role: "LEITURA" }, lc)).status).toBe(403);

    // Perfil e revogação, com as travas.
    expect((await call("/api/usuarios/perfil", { email: "leo@escritorio.test", role: "OPERADOR" })).status).toBe(200);
    expect(await (await fetch(`${base}/api/sessao`, { headers: { cookie: lc } })).json()).toMatchObject({ role: "OPERADOR" });
    const last = await call("/api/usuarios/perfil", { email: "luan@escritorio.test", role: "LEITURA" });
    expect(last.status).toBe(409);
    expect((await last.json()).erro).toMatch(/Responsável técnico/);
    expect((await call("/api/usuarios/revogar", { email: "luan@escritorio.test" })).status).toBe(409);
    expect((await call("/api/usuarios/revogar", { email: "leo@escritorio.test", reason: "teste" })).status).toBe(200);
    expect((await fetch(`${base}/api/central`, { headers: { cookie: lc } })).status).toBe(401);
  });

  it("com endereço público ligado, o convite sai com ele e o host público é aceito", async () => {
    const t = await newTenant();
    const { base } = await server(t, "https://exemplo-teste.trycloudflare.com");
    const rt = await enroll(t, "luan@escritorio.test", "RESPONSAVEL_TECNICO");
    const cookie = await loginCookie(base, rt.email, rt.secret);
    const r = await fetch(`${base}/api/usuarios/convidar`, {
      method: "POST",
      headers: { cookie, "X-IARIS-Acao": "usuarios", "content-type": "application/json" },
      body: JSON.stringify({ name: "Ana", email: "ana@escritorio.test", role: "LEITURA" }),
    });
    expect((await r.json()).link).toMatch(/^https:\/\/exemplo-teste\.trycloudflare\.com\/convite#t=/);
    const status = await new Promise<number>((resolve, reject) => {
      const q = request(`${base}/`, { headers: { host: "exemplo-teste.trycloudflare.com" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      q.on("error", reject);
      q.end();
    });
    expect(status).toBe(200);
  });
});
