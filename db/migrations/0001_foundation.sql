-- Fundação: extensões, papéis e contexto de tenant.
--
-- Papéis:
--   legacy_app   aplicação; sujeita a RLS; nunca lê dados sem app.tenant_id definido.
--   legacy_relay relay do outbox; enxerga o outbox de todos os tenants e nada mais.
-- Os dois são NOLOGIN. Usuários de login são criados por ambiente (ver dev-roles.ts)
-- e recebem apenas a participação no papel.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legacy_app') THEN
    CREATE ROLE legacy_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legacy_relay') THEN
    CREATE ROLE legacy_relay NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO legacy_app, legacy_relay;

-- Tenant da transação corrente. NULL quando não definido: nenhuma política casa.
CREATE OR REPLACE FUNCTION current_tenant() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

-- updated_at automático.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;
