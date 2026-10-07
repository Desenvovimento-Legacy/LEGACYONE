-- 0020 — Usuários, perfis de acesso, credenciais (senha + 2 etapas) e sessões.
--
-- Nada é sobrescrito: perfil e credencial são históricos (vale a linha mais
-- recente); convite e sessão só ganham a data de uso/encerramento.
-- Senha guardada só como hash scrypt; segredo do autenticador (TOTP) cifrado
-- com chave que fica no cofre, nunca no banco. Token de convite e de sessão
-- guardados só como SHA-256.

-- app_user já existe desde a 0003 (vínculo com o escritório). O perfil de
-- acesso passa a ser histórico em user_access; as colunas role/status da 0003
-- ficam (nada é apagado), mas deixam de ser obrigatórias e não valem para login.
ALTER TABLE app_user ALTER COLUMN role DROP NOT NULL;
ALTER TABLE app_user ADD COLUMN created_by text;
ALTER TABLE app_user ADD CONSTRAINT app_user_email_lower_ck CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') NOT VALID;
COMMENT ON COLUMN app_user.role IS 'Legado (0003). Perfil vigente: última linha de user_access.';

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

GRANT SELECT, INSERT ON user_access, user_credential, user_invitation, user_session, login_attempt, totp_use TO legacy_app;
GRANT UPDATE (used_at) ON user_invitation TO legacy_app;
GRANT UPDATE (last_seen_at, ended_at, end_reason) ON user_session TO legacy_app;
