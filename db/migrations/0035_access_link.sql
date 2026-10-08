-- 0035 — Link pessoal de acesso.
--
-- O responsável pelo escritório gera um link para uma pessoa; quem abre o link
-- entra como essa pessoa, sem senha e sem código. O link vale até expires_at,
-- até ser revogado ou até um link novo ser gerado para a mesma pessoa.
-- Guardado só o SHA-256 do token. Toda entrada fica na auditoria em nome da pessoa.

CREATE TABLE access_link (
  id            uuid NOT NULL PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  user_id       uuid NOT NULL,
  token_hash    bytea NOT NULL UNIQUE,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user (tenant_id, id)
);
CREATE INDEX access_link_user_ix ON access_link (tenant_id, user_id);
SELECT apply_tenant_rls('access_link');

GRANT SELECT, INSERT ON access_link TO legacy_app;
GRANT UPDATE (revoked_at, last_used_at) ON access_link TO legacy_app;
