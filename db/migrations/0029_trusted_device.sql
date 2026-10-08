-- 0029 — Computador confiável: depois de entrar com senha + código, a pessoa
-- pode marcar "confiar neste computador por 30 dias"; nesse computador o login
-- passa a pedir só e-mail e senha. Vale até vencer, ser esquecido ou a pessoa
-- trocar de credencial (novo convite). Acesso revogado continua barrando.

CREATE TABLE trusted_device (
  id            uuid NOT NULL PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  user_id       uuid NOT NULL,
  token_hash    bytea NOT NULL UNIQUE,
  ip            text,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at  timestamptz,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user (tenant_id, id)
);
SELECT apply_tenant_rls('trusted_device');
GRANT SELECT, INSERT ON trusted_device TO legacy_app;
GRANT UPDATE (last_used_at, revoked_at) ON trusted_device TO legacy_app;
