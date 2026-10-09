import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Actor } from "../../shared/actor.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";
import { audit } from "../audit/audit.js";
import { appendEvent, type Producer } from "../events/outbox.js";
import { DUMMY_PASSWORD_HASH, hashPassword, open, passwordProblem, randomToken, seal, sha256, verifyPassword } from "./crypto.js";
import { base32Encode, matchTotp, newTotpSecret, otpauthUri } from "./totp.js";

/**
 * Authorization Service — pessoas. Login com senha + autenticador de 2 etapas,
 * perfil de acesso e sessão. Toda ação de usuário passa a ter nome e e-mail
 * na auditoria (Actor USER com id = e-mail).
 *
 * Perfis:
 *  - LEITURA: vê tudo do escritório, não executa nada.
 *  - OPERADOR: + Buscar na Receita (consulta cobrada) e confirmar dados de implantação.
 *  - RESPONSAVEL_TECNICO: + aprovar regras e conclusões de Case.
 */

export const Role = z.enum(["LEITURA", "OPERADOR", "RESPONSAVEL_TECNICO"]);
export type Role = z.infer<typeof Role>;
export type Permission = "ver" | "buscar" | "confirmar" | "aprovar" | "usuarios";

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  LEITURA: ["ver"],
  OPERADOR: ["ver", "buscar", "confirmar"],
  RESPONSAVEL_TECNICO: ["ver", "buscar", "confirmar", "aprovar", "usuarios"],
};
export const ROLE_LABEL: Record<Role, string> = {
  LEITURA: "Leitura",
  OPERADOR: "Operador",
  RESPONSAVEL_TECNICO: "Responsável técnico",
};

export const INVITE_HOURS = 72;
export const SESSION_HOURS = 12;
export const SESSION_IDLE_MINUTES = 240;
/** "Confiar neste computador": dias sem pedir o código do autenticador nesse computador. */
export const TRUST_DAYS = 30;
/** Link pessoal de acesso (sem senha e sem código): dias de validade. */
export const LINK_DAYS = 90;
export const MAX_FAILURES = 5;
export const FAILURE_WINDOW_MINUTES = 15;

export interface AccessDeps {
  appPool: Pool;
  tenantId: string;
  /** IARIS_AUTH_KEY do cofre (32 bytes). Cifra o segredo do autenticador. */
  authKey: Buffer;
  now?: () => Date;
  /**
   * Código do autenticador no login e no primeiro acesso. Padrão: ligado.
   * Desligado (IARIS_2FA=off, decisão do escritório): entra só com e-mail e senha.
   */
  twoFactor?: boolean;
}

const twoFactorOn = (deps: Pick<AccessDeps, "twoFactor">) => deps.twoFactor !== false;

export interface SessionUser {
  sessionId: string;
  userId: string;
  email: string;
  name: string;
  role: Role;
  permissions: Permission[];
}

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** Erro mostrado à pessoa como está (nunca cita senha, código ou token). */
export class AccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessError";
  }
}

const PRODUCER: Producer = { kind: "service", name: "access", version: "1" };
const LOGIN_FAILED = "E-mail, senha ou código inválidos";
const Email = z.string().trim().toLowerCase().pipe(z.email("E-mail inválido"));

export function userActor(u: Pick<SessionUser, "email">): Actor {
  return { kind: "USER", id: u.email };
}

const clock = (deps: AccessDeps) => (deps.now ? deps.now() : new Date());

async function currentAccess(tx: PoolClient, userId: string): Promise<{ role: Role; active: boolean } | null> {
  const { rows } = await tx.query<{ role: Role; active: boolean }>(
    "SELECT role, active FROM user_access WHERE user_id = $1 ORDER BY changed_at DESC, id DESC LIMIT 1",
    [userId],
  );
  return rows[0] ?? null;
}

async function endSessions(tx: PoolClient, userId: string, reason: string, now: Date): Promise<number> {
  const r = await tx.query(
    "UPDATE user_session SET ended_at = $2, end_reason = $3 WHERE user_id = $1 AND ended_at IS NULL",
    [userId, now, reason],
  );
  return r.rowCount ?? 0;
}

async function setAccess(tx: PoolClient, userId: string, role: Role, active: boolean, reason: string | null, actor: Actor) {
  const id = newId();
  await tx.query(
    "INSERT INTO user_access (id, tenant_id, user_id, role, active, reason, changed_by) VALUES ($1, current_tenant(), $2, $3, $4, $5, $6)",
    [id, userId, role, active, reason, actor.id],
  );
  await appendEvent(tx, {
    type: "USER_ACCESS_CHANGED",
    schemaVersion: 1,
    producer: PRODUCER,
    idempotencyKey: `user-access:${id}`,
    payload: { user_id: userId, role, active, reason },
  });
}

// ---------------------------------------------------------------- convite

export interface InviteInput {
  email: string;
  name: string;
  role: Role;
}

/**
 * Cria a pessoa (se ainda não existe), define o perfil e gera um convite de uso
 * único. O token volta só para quem chamou; o banco guarda o hash.
 * Um convite novo invalida os anteriores ainda não usados.
 */
export async function inviteUser(deps: AccessDeps, input: InviteInput, actor: Actor) {
  const email = Email.parse(input.email);
  const name = z.string().trim().min(2, "Informe o nome").parse(input.name);
  const role = Role.parse(input.role);
  const now = clock(deps);
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + INVITE_HOURS * 3600_000);

  return withTenant(deps.appPool, deps.tenantId, async (tx) => {
    const found = await tx.query<{ id: string }>("SELECT id FROM app_user WHERE email = $1", [email]);
    let userId = found.rows[0]?.id;
    const created = !userId;
    if (!userId) {
      userId = newId();
      await tx.query(
        "INSERT INTO app_user (id, tenant_id, email, name, created_by) VALUES ($1, current_tenant(), $2, $3, $4)",
        [userId, email, name, actor.id],
      );
    }
    const access = await currentAccess(tx, userId);
    if (!access || access.role !== role || !access.active) await setAccess(tx, userId, role, true, "convite", actor);

    await tx.query("UPDATE user_invitation SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL", [userId, now]);
    const invitationId = newId();
    await tx.query(
      `INSERT INTO user_invitation (id, tenant_id, user_id, token_hash, totp_secret_enc, created_by, expires_at)
       VALUES ($1, current_tenant(), $2, $3, $4, $5, $6)`,
      [invitationId, userId, sha256(token), seal(deps.authKey, newTotpSecret()), actor.id, expiresAt],
    );
    await appendEvent(tx, {
      type: "USER_INVITED",
      schemaVersion: 1,
      producer: PRODUCER,
      idempotencyKey: `user-invite:${invitationId}`,
      payload: { user_id: userId, role, expires_at: expiresAt.toISOString() },
    });
    await audit(tx, {
      actor,
      action: "user.invite",
      resourceType: "app_user",
      resourceId: userId,
      data: { email, name, role, created, expires_at: expiresAt.toISOString() },
    });
    return { userId, created, token, expiresAt };
  });
}

/**
 * Link pessoal de acesso: quem abrir entra como esta pessoa, sem senha e sem
 * código. Cria a pessoa se ainda não existe; um link novo cancela os anteriores.
 * O token volta só para quem chamou; o banco guarda o hash.
 */
export async function createAccessLink(deps: AccessDeps, input: InviteInput, actor: Actor) {
  const email = Email.parse(input.email);
  const name = z.string().trim().min(2, "Informe o nome").parse(input.name);
  const role = Role.parse(input.role);
  const now = clock(deps);
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + LINK_DAYS * 86_400_000);
  return withTenant(deps.appPool, deps.tenantId, async (tx) => {
    const found = await tx.query<{ id: string }>("SELECT id FROM app_user WHERE email = $1", [email]);
    let userId = found.rows[0]?.id;
    const created = !userId;
    if (!userId) {
      userId = newId();
      await tx.query("INSERT INTO app_user (id, tenant_id, email, name, created_by) VALUES ($1, current_tenant(), $2, $3, $4)", [userId, email, name, actor.id]);
    }
    const access = await currentAccess(tx, userId);
    if (access?.active && access.role === "RESPONSAVEL_TECNICO" && role !== "RESPONSAVEL_TECNICO" && (await otherActiveRts(tx, userId)) === 0) {
      throw new AccessError("O escritório precisa de ao menos um Responsável técnico ativo");
    }
    if (!access || access.role !== role || !access.active) await setAccess(tx, userId, role, true, "link de acesso", actor);
    await tx.query("UPDATE access_link SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL", [userId, now]);
    const linkId = newId();
    await tx.query(
      "INSERT INTO access_link (id, tenant_id, user_id, token_hash, created_by, created_at, expires_at) VALUES ($1, current_tenant(), $2, $3, $4, $5, $6)",
      [linkId, userId, sha256(token), actor.id, now, expiresAt],
    );
    await appendEvent(tx, {
      type: "USER_ACCESS_LINK_CREATED", schemaVersion: 1, producer: PRODUCER, idempotencyKey: `access-link:${linkId}`,
      payload: { user_id: userId, role, expires_at: expiresAt.toISOString() },
    });
    await audit(tx, { actor, action: "user.access_link", resourceType: "app_user", resourceId: userId, data: { email, name, role, created, expires_at: expiresAt.toISOString() } });
    return { userId, created, token, expiresAt };
  });
}

/** Entrada pelo link pessoal: abre sessão em nome da pessoa (auditada). */
export async function loginWithLink(deps: AccessDeps, token: string, meta: RequestMeta = {}): Promise<{ token: string; expiresAt: Date; user: SessionUser }> {
  const now = clock(deps);
  if (!token || token.length > 200) throw new AccessError("Link inválido ou vencido. Peça um novo ao escritório.");
  return withTenant(deps.appPool, deps.tenantId, async (tx) => {
    const { rows } = await tx.query<{ id: string; user_id: string; email: string; name: string }>(
      `SELECT l.id, l.user_id, u.email, u.name FROM access_link l JOIN app_user u ON u.id = l.user_id
        WHERE l.token_hash = $1 AND l.revoked_at IS NULL AND l.expires_at > $2`,
      [sha256(token), now],
    );
    const l = rows[0];
    const access = l ? await currentAccess(tx, l.user_id) : null;
    if (!l || !access?.active) throw new AccessError("Link inválido ou vencido. Peça um novo ao escritório.");
    const session = randomToken();
    const expiresAt = new Date(now.getTime() + SESSION_HOURS * 3600_000);
    const sessionId = newId();
    await tx.query("UPDATE access_link SET last_used_at = $2 WHERE id = $1", [l.id, now]);
    await tx.query(
      `INSERT INTO user_session (id, tenant_id, user_id, token_hash, ip, user_agent, created_at, last_seen_at, expires_at)
       VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $6, $7)`,
      [sessionId, l.user_id, sha256(session), meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null, now, expiresAt],
    );
    await audit(tx, {
      actor: { kind: "USER", id: l.email }, action: "auth.login", resourceType: "user_session", resourceId: sessionId,
      data: { role: access.role, ip: meta.ip ?? null, expires_at: expiresAt.toISOString(), via: "link", link_id: l.id },
    });
    return { token: session, expiresAt, user: { sessionId, userId: l.user_id, email: l.email, name: l.name, role: access.role, permissions: ROLE_PERMISSIONS[access.role] } };
  });
}

async function findInvitation(tx: PoolClient, token: string, now: Date) {
  const { rows } = await tx.query<{ id: string; user_id: string; totp_secret_enc: string; email: string; name: string; expires_at: Date }>(
    `SELECT i.id, i.user_id, i.totp_secret_enc, u.email, u.name, i.expires_at
       FROM user_invitation i JOIN app_user u ON u.id = i.user_id
      WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > $2`,
    [sha256(token), now],
  );
  const inv = rows[0];
  if (!inv) throw new AccessError("Convite inválido, já usado ou vencido. Peça um novo ao escritório.");
  const access = await currentAccess(tx, inv.user_id);
  if (!access?.active) throw new AccessError("Convite inválido, já usado ou vencido. Peça um novo ao escritório.");
  return { ...inv, role: access.role };
}

/** Dados para a tela de primeiro acesso: QR do autenticador e a chave para digitar. */
export async function openInvitation(deps: AccessDeps, token: string) {
  const now = clock(deps);
  return withTenant(deps.appPool, deps.tenantId, async (tx) => {
    const inv = await findInvitation(tx, token, now);
    const secret = open(deps.authKey, inv.totp_secret_enc);
    return {
      email: inv.email,
      name: inv.name,
      role: inv.role,
      roleLabel: ROLE_LABEL[inv.role],
      expiresAt: inv.expires_at.toISOString(),
      twoFactor: twoFactorOn(deps),
      otpauthUri: otpauthUri(secret, inv.email),
      secretBase32: base32Encode(secret).replace(/(.{4})/g, "$1 ").trim(),
    };
  });
}

/** Primeiro acesso: define a senha e (com 2 etapas ligado) confirma o autenticador com um código. */
export async function acceptInvitation(deps: AccessDeps, input: { token: string; password: string; code: string }) {
  const now = clock(deps);
  const problem = passwordProblem(input.password ?? "");
  if (problem) throw new AccessError(problem);
  const hash = await hashPassword(input.password);
  return withTenant(deps.appPool, deps.tenantId, async (tx) => {
    const inv = await findInvitation(tx, input.token ?? "", now);
    if (twoFactorOn(deps)) {
      const secret = open(deps.authKey, inv.totp_secret_enc);
      const step = matchTotp(secret, input.code ?? "", now);
      if (step === null) throw new AccessError("Código do autenticador não confere. Confira a hora do celular e tente de novo.");
      await tx.query("INSERT INTO totp_use (tenant_id, user_id, step) VALUES (current_tenant(), $1, $2) ON CONFLICT DO NOTHING", [
        inv.user_id,
        step,
      ]);
    }
    await tx.query(
      "INSERT INTO user_credential (id, tenant_id, user_id, password_hash, totp_secret_enc) VALUES ($1, current_tenant(), $2, $3, $4)",
      [newId(), inv.user_id, hash, inv.totp_secret_enc],
    );
    await tx.query("UPDATE user_invitation SET used_at = $2 WHERE id = $1", [inv.id, now]);
    const ended = await endSessions(tx, inv.user_id, "nova credencial", now);
    const actor: Actor = { kind: "USER", id: inv.email };
    await appendEvent(tx, {
      type: "USER_ENROLLED",
      schemaVersion: 1,
      producer: PRODUCER,
      idempotencyKey: `user-enroll:${inv.id}`,
      payload: { user_id: inv.user_id },
    });
    await audit(tx, {
      actor,
      action: "user.enroll",
      resourceType: "app_user",
      resourceId: inv.user_id,
      data: { invitation_id: inv.id, sessions_ended: ended },
    });
    return { userId: inv.user_id, email: inv.email };
  });
}

// ---------------------------------------------------------------- login e sessão

export async function login(
  deps: AccessDeps,
  input: { email: string; password: string; code: string; trust?: boolean; deviceToken?: string | null },
  meta: RequestMeta = {},
): Promise<{ token: string; expiresAt: Date; user: SessionUser; deviceToken: string | null }> {
  const now = clock(deps);
  const parsed = Email.safeParse(input.email ?? "");
  const email = parsed.success ? parsed.data : String(input.email ?? "").trim().toLowerCase().slice(0, 200);

  const fail = async (reason: string, userId: string | null): Promise<never> => {
    await withTenant(deps.appPool, deps.tenantId, async (tx) => {
      await tx.query("INSERT INTO login_attempt (id, tenant_id, email, ip, success) VALUES ($1, current_tenant(), $2, $3, false)", [
        newId(),
        email,
        meta.ip ?? null,
      ]);
      await audit(tx, {
        actor: { kind: "USER", id: email || "desconhecido" },
        action: "auth.login_failed",
        resourceType: "app_user",
        resourceId: userId,
        data: { reason, ip: meta.ip ?? null },
      });
    });
    throw new AccessError(reason === "bloqueado" ? `Muitas tentativas. Aguarde ${FAILURE_WINDOW_MINUTES} minutos.` : LOGIN_FAILED);
  };

  const found = await withTenant(deps.appPool, deps.tenantId, async (tx) => {
    const failures = await tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM login_attempt WHERE email = $1 AND NOT success AND at > $2::timestamptz - make_interval(mins => $3)",
      [email, now, FAILURE_WINDOW_MINUTES],
    );
    const { rows } = await tx.query<{ id: string; email: string; name: string; password_hash: string | null; totp_secret_enc: string | null; cred_at: Date | null }>(
      `SELECT u.id, u.email, u.name, c.password_hash, c.totp_secret_enc, c.created_at AS cred_at
         FROM app_user u
         LEFT JOIN LATERAL (SELECT password_hash, totp_secret_enc, created_at FROM user_credential
                             WHERE user_id = u.id ORDER BY created_at DESC, id DESC LIMIT 1) c ON true
        WHERE u.email = $1`,
      [email],
    );
    const u = rows[0] ?? null;
    // Computador confiável desta pessoa: vigente e criado depois da credencial atual.
    let device: string | null = null;
    if (u && input.deviceToken && input.deviceToken.length <= 200) {
      const d = await tx.query<{ id: string }>(
        `SELECT id FROM trusted_device WHERE token_hash = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > $3 AND created_at >= $4`,
        [sha256(input.deviceToken), u.id, now, u.cred_at ?? now],
      );
      device = d.rows[0]?.id ?? null;
    }
    return { blocked: (failures.rows[0]?.n ?? 0) >= MAX_FAILURES, user: u, access: u ? await currentAccess(tx, u.id) : null, device };
  });

  const passwordOk = await verifyPassword(input.password ?? "", found.user?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (found.blocked) return fail("bloqueado", found.user?.id ?? null);
  const u = found.user;
  const twoFactor = twoFactorOn(deps);
  if (!u || !u.password_hash || (twoFactor && !u.totp_secret_enc)) return fail("usuário ou credencial inexistente", u?.id ?? null);
  if (!passwordOk) return fail("senha incorreta", u.id);
  if (!found.access?.active) return fail("acesso revogado", u.id);
  const askCode = twoFactor && !found.device;
  const step = askCode ? matchTotp(open(deps.authKey, u.totp_secret_enc!), input.code ?? "", now) : null;
  if (askCode && step === null) return fail("código incorreto", u.id);

  const token = randomToken();
  const expiresAt = new Date(now.getTime() + SESSION_HOURS * 3600_000);
  const role = found.access.role;
  const sessionId = newId();
  let newDevice: string | null = null;
  const ok = await withTenant(deps.appPool, deps.tenantId, async (tx) => {
    if (!twoFactor) {
      // sem código: nada a registrar de autenticador nem de computador confiável
    } else if (found.device) {
      await tx.query("UPDATE trusted_device SET last_used_at = $1 WHERE id = $2", [now, found.device]);
    } else {
      const used = await tx.query(
        "INSERT INTO totp_use (tenant_id, user_id, step) VALUES (current_tenant(), $1, $2) ON CONFLICT DO NOTHING",
        [u.id, step],
      );
      if (!used.rowCount) return false;
      if (input.trust) {
        newDevice = randomToken();
        await tx.query(
          `INSERT INTO trusted_device (id, tenant_id, user_id, token_hash, ip, user_agent, created_at, expires_at)
           VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7)`,
          [newId(), u.id, sha256(newDevice), meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null, now, new Date(now.getTime() + TRUST_DAYS * 86_400_000)],
        );
      }
    }
    await tx.query(
      `INSERT INTO user_session (id, tenant_id, user_id, token_hash, ip, user_agent, created_at, last_seen_at, expires_at)
       VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $6, $7)`,
      [sessionId, u.id, sha256(token), meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null, now, expiresAt],
    );
    await tx.query("INSERT INTO login_attempt (id, tenant_id, email, ip, success) VALUES ($1, current_tenant(), $2, $3, true)", [
      newId(),
      email,
      meta.ip ?? null,
    ]);
    await audit(tx, {
      actor: { kind: "USER", id: u.email },
      action: "auth.login",
      resourceType: "user_session",
      resourceId: sessionId,
      data: { role, ip: meta.ip ?? null, expires_at: expiresAt.toISOString(), trusted_device: found.device, device_trusted_now: Boolean(newDevice), two_factor: twoFactor },
    });
    return true;
  });
  if (!ok) return fail("código já usado", u.id);
  return {
    token,
    expiresAt,
    deviceToken: newDevice,
    user: { sessionId, userId: u.id, email: u.email, name: u.name, role, permissions: ROLE_PERMISSIONS[role] },
  };
}

/** Este computador está marcado como confiável (para a tela de entrada esconder o código)? */
export async function deviceTrusted(deps: AccessDeps, token: string | null | undefined): Promise<boolean> {
  if (!token || token.length > 200) return false;
  return withTenant(deps.appPool, deps.tenantId, async (tx) => {
    const r = await tx.query(
      `SELECT 1 FROM trusted_device d
        WHERE d.token_hash = $1 AND d.revoked_at IS NULL AND d.expires_at > $2
          AND d.created_at >= (SELECT max(c.created_at) FROM user_credential c WHERE c.user_id = d.user_id)`,
      [sha256(token), clock(deps)],
    );
    return Boolean(r.rowCount);
  });
}

/** "Esquecer este computador": volta a pedir o código nele. */
export async function forgetDevice(deps: AccessDeps, token: string | null | undefined): Promise<void> {
  if (!token || token.length > 200) return;
  await withTenant(deps.appPool, deps.tenantId, (tx) =>
    tx.query("UPDATE trusted_device SET revoked_at = $1 WHERE token_hash = $2 AND revoked_at IS NULL", [clock(deps), sha256(token)]),
  );
}

/** Sessão válida (não encerrada, dentro do prazo e da inatividade, acesso ativo) ou null. */
export async function sessionFromToken(deps: AccessDeps, token: string | null | undefined): Promise<SessionUser | null> {
  if (!token || token.length > 200) return null;
  const now = clock(deps);
  return withTenant(deps.appPool, deps.tenantId, async (tx) => {
    const { rows } = await tx.query<{ id: string; user_id: string; email: string; name: string; last_seen_at: Date }>(
      `SELECT s.id, s.user_id, u.email, u.name, s.last_seen_at
         FROM user_session s JOIN app_user u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.ended_at IS NULL AND s.expires_at > $2
          AND s.last_seen_at > $2::timestamptz - make_interval(mins => $3)`,
      [sha256(token), now, SESSION_IDLE_MINUTES],
    );
    const s = rows[0];
    if (!s) return null;
    const access = await currentAccess(tx, s.user_id);
    if (!access?.active) return null;
    if (now.getTime() - s.last_seen_at.getTime() > 60_000) {
      await tx.query("UPDATE user_session SET last_seen_at = $2 WHERE id = $1", [s.id, now]);
    }
    return { sessionId: s.id, userId: s.user_id, email: s.email, name: s.name, role: access.role, permissions: ROLE_PERMISSIONS[access.role] };
  });
}

export async function logout(deps: AccessDeps, user: SessionUser): Promise<void> {
  const now = clock(deps);
  await withTenant(deps.appPool, deps.tenantId, async (tx) => {
    await tx.query("UPDATE user_session SET ended_at = $2, end_reason = 'saiu' WHERE id = $1 AND ended_at IS NULL", [user.sessionId, now]);
    await audit(tx, { actor: userActor(user), action: "auth.logout", resourceType: "user_session", resourceId: user.sessionId });
  });
}

// ---------------------------------------------------------------- administração

/** Revoga o acesso (nova linha de perfil com active = false) e encerra as sessões abertas. */
export async function revokeUser(deps: AccessDeps, emailInput: string, reason: string, actor: Actor) {
  const email = Email.parse(emailInput);
  const now = clock(deps);
  return withTenant(deps.appPool, deps.tenantId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM app_user WHERE email = $1", [email]);
    const userId = rows[0]?.id;
    if (!userId) throw new AccessError(`Usuário ${email} não existe`);
    const access = await currentAccess(tx, userId);
    if (access?.active) await setAccess(tx, userId, access.role, false, reason, actor);
    await tx.query("UPDATE user_invitation SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL", [userId, now]);
    await tx.query("UPDATE access_link SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL", [userId, now]);
    const ended = await endSessions(tx, userId, "acesso revogado", now);
    await audit(tx, { actor, action: "user.revoke", resourceType: "app_user", resourceId: userId, data: { email, reason, sessions_ended: ended } });
    return { userId, sessionsEnded: ended };
  });
}

/** Quantos responsáveis técnicos ativos sobram se este usuário deixar de ser um. */
async function otherActiveRts(tx: PoolClient, userId: string): Promise<number> {
  const { rows } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app_user u
       JOIN LATERAL (SELECT role, active FROM user_access WHERE user_id = u.id ORDER BY changed_at DESC, id DESC LIMIT 1) a ON true
      WHERE u.id <> $1 AND a.active AND a.role = 'RESPONSAVEL_TECNICO'`,
    [userId],
  );
  return rows[0]?.n ?? 0;
}

/** Troca o perfil (nova linha de histórico). Nunca deixa o escritório sem responsável técnico. */
export async function changeRole(deps: AccessDeps, emailInput: string, role: Role, actor: Actor) {
  const email = Email.parse(emailInput);
  const newRole = Role.parse(role);
  return withTenant(deps.appPool, deps.tenantId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM app_user WHERE email = $1", [email]);
    const userId = rows[0]?.id;
    if (!userId) throw new AccessError(`Usuário ${email} não existe`);
    const access = await currentAccess(tx, userId);
    if (!access?.active) throw new AccessError("Acesso revogado: envie um convite novo para reativar");
    if (access.role === newRole) return { userId, changed: false };
    if (access.role === "RESPONSAVEL_TECNICO" && (await otherActiveRts(tx, userId)) === 0) {
      throw new AccessError("O escritório precisa de ao menos um Responsável técnico ativo");
    }
    await setAccess(tx, userId, newRole, true, "perfil alterado", actor);
    await audit(tx, { actor, action: "user.role_changed", resourceType: "app_user", resourceId: userId, data: { email, from: access.role, to: newRole } });
    return { userId, changed: true };
  });
}

/** Revogação feita pela tela: não deixa revogar a si mesmo nem o último responsável técnico. */
export async function revokeUserGuarded(deps: AccessDeps, emailInput: string, reason: string, actor: Actor) {
  const email = Email.parse(emailInput);
  if (email === actor.id) throw new AccessError("Você não pode revogar o próprio acesso");
  await withTenant(deps.appPool, deps.tenantId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM app_user WHERE email = $1", [email]);
    if (!rows[0]) throw new AccessError(`Usuário ${email} não existe`);
    const access = await currentAccess(tx, rows[0].id);
    if (access?.active && access.role === "RESPONSAVEL_TECNICO" && (await otherActiveRts(tx, rows[0].id)) === 0) {
      throw new AccessError("O escritório precisa de ao menos um Responsável técnico ativo");
    }
  });
  return revokeUser(deps, email, reason, actor);
}

export async function listUsers(deps: Pick<AccessDeps, "appPool" | "tenantId">) {
  return withTenant(deps.appPool, deps.tenantId, async (tx) => {
    const { rows } = await tx.query<{
      email: string;
      name: string;
      role: Role | null;
      active: boolean | null;
      enrolled: boolean;
      last_login: Date | null;
      invite_expires: Date | null;
      link_expires: Date | null;
      link_used: Date | null;
    }>(
      `SELECT u.email, u.name, a.role, a.active,
              EXISTS (SELECT 1 FROM user_credential c WHERE c.user_id = u.id) AS enrolled,
              (SELECT max(expires_at) FROM user_invitation i WHERE i.user_id = u.id AND i.used_at IS NULL AND i.expires_at > now()) AS invite_expires,
              (SELECT max(expires_at) FROM access_link l WHERE l.user_id = u.id AND l.revoked_at IS NULL AND l.expires_at > now()) AS link_expires,
              (SELECT max(last_used_at) FROM access_link l WHERE l.user_id = u.id AND l.revoked_at IS NULL) AS link_used,
              (SELECT max(created_at) FROM user_session s WHERE s.user_id = u.id) AS last_login
         FROM app_user u
         LEFT JOIN LATERAL (SELECT role, active FROM user_access WHERE user_id = u.id ORDER BY changed_at DESC, id DESC LIMIT 1) a ON true
        ORDER BY u.name`,
    );
    return rows;
  });
}
