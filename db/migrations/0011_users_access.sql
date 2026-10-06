-- 0011 — Usuários, perfis de acesso, credenciais (senha + 2 etapas) e sessões.
--
-- Nada é sobrescrito: perfil e credencial são históricos (vale a linha mais
-- recente); convite e sessão só ganham a data de uso/encerramento.
-- Senha guardada só como hash scrypt; segredo do autenticador (TOTP) cifrado
-- com chave que fica no cofre, nunca no banco. Token de convite e de sessão
-- guardados só como SHA-256.

CREATE TABLE app_user (
  id          uuid NOT NULL PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  email       text NOT NULL CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, email)
);
SELECT apply_tenant_rls('app_user');

-- Perfil vigente = linha mais recente. active = false revoga o acesso.
CREATE TABLE user_access (
  id          uuid NOT NULL PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  role        text NOT NULL CHECK (role IN ('LEITURA', 'OPERADOR', 'RESPONSAVEL_TECNICO')),
  active      boolean NOT NULL,
  reason      text,
  changed_by  text NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user (tenant_id, id)
);
CREATE INDEX user_access_ix ON user_access (tenant_id, user_id, changed_at DESC);
SELECT apply_tenant_rls('user_access');

-- Credencial vigente = linha mais recente.
CREATE TABLE user_credential (
  id               uuid NOT NULL PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  user_id          uuid NOT NULL,
  password_hash    text NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  totp_secret_enc  text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user (tenant_id, id)
);
CREATE INDEX user_credential_ix ON user_credential (tenant_id, user_id, created_at DESC);
SELECT apply_tenant_rls('user_credential');

CREATE TABLE user_invitation (
  id               uuid NOT NULL PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  user_id          uuid NOT NULL,
  token_hash       bytea NOT NULL UNIQUE,
  totp_secret_enc  text NOT NULL,
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz,
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user (tenant_id, id)
);
SELECT apply_tenant_rls('user_invitation');

CREATE TABLE user_session (
  id            uuid NOT NULL PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  user_id       uuid NOT NULL,
  token_hash    bytea NOT NULL UNIQUE,
  ip            text,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at    timestamptz NOT NULL,
  ended_at      timestamptz,
  end_reason    text,
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user (tenant_id, id)
);
SELECT apply_tenant_rls('user_session');

-- Tentativas de login (base do bloqueio por excesso de erros).
CREATE TABLE login_attempt (
  id          uuid NOT NULL PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  email       text NOT NULL,
  ip          text,
  success     boolean NOT NULL,
  at          timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX login_attempt_ix ON login_attempt (tenant_id, email, at DESC);
SELECT apply_tenant_rls('login_attempt');

-- Cada código do autenticador vale uma única vez.
CREATE TABLE totp_use (
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  step        bigint NOT NULL,
  used_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, step),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user (tenant_id, id)
);
SELECT apply_tenant_rls('totp_use');

GRANT SELECT, INSERT ON app_user, user_access, user_credential, user_invitation, user_session, login_attempt, totp_use TO legacy_app;
GRANT UPDATE (used_at) ON user_invitation TO legacy_app;
GRANT UPDATE (last_seen_at, ended_at, end_reason) ON user_session TO legacy_app;
