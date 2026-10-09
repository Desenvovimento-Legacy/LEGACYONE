-- 0038 — Compatibilidade com Postgres gerenciado (Supabase).
--
-- 1. No Supabase o pgcrypto fica no schema "extensions", fora do search_path
--    dos papéis da aplicação. A função do hash da auditoria passa a fixar o
--    search_path e os papéis recebem USAGE no schema.
-- 2. O Supabase concede por padrão acesso às tabelas do schema public aos papéis
--    anon/authenticated (API REST pública). O IARIS não usa essa API: retira tudo.
-- Em Postgres comum (pgcrypto em public, sem anon) esta migração não faz nada.

DO $$
DECLARE
  s text;
BEGIN
  SELECT n.nspname INTO s
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'pgcrypto';
  IF s IS NOT NULL AND s <> 'public' THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO legacy_app, legacy_relay', s);
    EXECUTE format('ALTER FUNCTION audit_row_digest(audit_log) SET search_path = public, %I', s);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
  END IF;
END
$$;
