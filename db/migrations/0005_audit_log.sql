-- Audit log imutável com hash encadeado por tenant.
--
-- seq, prev_hash e hash são calculados pelo banco no INSERT, sob lock por tenant:
-- a aplicação não consegue gravar um hash forjado nem furar a sequência.
-- UPDATE, DELETE e TRUNCATE são bloqueados por trigger, inclusive para o dono.
-- Adulteração direta (ex.: trigger desabilitada por superusuário) é detectada por
-- audit_verify_chain(), que recalcula a cadeia.

CREATE TABLE audit_log (
  tenant_id        uuid NOT NULL REFERENCES tenant (id),
  seq              bigint NOT NULL,
  occurred_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_kind       text NOT NULL CHECK (actor_kind IN ('USER', 'AGENT', 'SYSTEM')),
  actor_id         text NOT NULL,
  ai_model         text,
  action           text NOT NULL,
  resource_type    text NOT NULL,
  resource_id      text,
  entity_id        uuid,
  establishment_id uuid,
  competence       date,
  case_id          uuid,
  rule_ref         text,
  confidence       numeric(5,4),
  data             jsonb NOT NULL DEFAULT '{}',
  evidence_refs    jsonb NOT NULL DEFAULT '[]',
  approved_by      text,
  correlation_id   uuid,
  prev_hash        bytea NOT NULL,
  hash             bytea NOT NULL,
  PRIMARY KEY (tenant_id, seq)
);
CREATE INDEX audit_case_ix ON audit_log (tenant_id, case_id);

-- Representação canônica de uma linha para o hash. jsonb::text é determinístico
-- (chaves normalizadas); o timestamp é fixado em UTC para independer da sessão.
CREATE OR REPLACE FUNCTION audit_row_digest(a audit_log) RETURNS bytea
LANGUAGE sql IMMUTABLE
AS $$
  SELECT digest(
    convert_to(
      jsonb_build_array(
        a.tenant_id, a.seq,
        to_char(a.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        a.actor_kind, a.actor_id, a.ai_model, a.action, a.resource_type, a.resource_id,
        a.entity_id, a.establishment_id, a.competence, a.case_id, a.rule_ref, a.confidence,
        a.data, a.evidence_refs, a.approved_by, a.correlation_id
      )::text, 'UTF8')
    || a.prev_hash,
    'sha256')
$$;

CREATE OR REPLACE FUNCTION audit_chain_before_insert() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  last_seq  bigint;
  last_hash bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('audit:' || NEW.tenant_id::text, 0));
  SELECT seq, hash INTO last_seq, last_hash
    FROM audit_log WHERE tenant_id = NEW.tenant_id ORDER BY seq DESC LIMIT 1;
  NEW.seq := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := coalesce(last_hash, '\x00'::bytea);
  NEW.occurred_at := date_trunc('microseconds', clock_timestamp());
  NEW.hash := audit_row_digest(NEW);
  RETURN NEW;
END
$$;
CREATE TRIGGER audit_chain BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_chain_before_insert();

CREATE OR REPLACE FUNCTION audit_block_changes() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log é imutável (%)', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_block_changes();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_block_changes();

-- Devolve a primeira posição quebrada da cadeia do tenant, ou NULL se íntegra.
CREATE OR REPLACE FUNCTION audit_verify_chain(p_tenant uuid) RETURNS bigint
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  r        audit_log;
  expected bytea := '\x00'::bytea;
  n        bigint := 0;
BEGIN
  FOR r IN SELECT * FROM audit_log WHERE tenant_id = p_tenant ORDER BY seq LOOP
    n := n + 1;
    IF r.seq <> n OR r.prev_hash <> expected OR r.hash <> audit_row_digest(r) THEN
      RETURN r.seq;
    END IF;
    expected := r.hash;
  END LOOP;
  RETURN NULL;
END
$$;

SELECT apply_tenant_rls('audit_log');
GRANT SELECT, INSERT ON audit_log TO legacy_app;
