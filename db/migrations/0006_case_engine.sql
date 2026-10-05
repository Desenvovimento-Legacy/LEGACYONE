-- Case Engine: toda operação relevante é um Case com ciclo de vida auditado.
-- As regras de transição vivem na aplicação (state-machine.ts) e são reforçadas
-- aqui: estado terminal não muda e a transição é registrada sempre.

CREATE TABLE "case" (
  id                 uuid NOT NULL,
  tenant_id          uuid NOT NULL REFERENCES tenant (id),
  type               text NOT NULL CHECK (type ~ '^[A-Z][A-Z0-9_]+$'),
  entity_id          uuid,
  establishment_id   uuid,
  competence         date CHECK (competence IS NULL OR extract(day FROM competence) = 1),
  origin             text NOT NULL,
  requester          text NOT NULL,
  status             text NOT NULL DEFAULT 'OPEN' CHECK (status IN (
    'OPEN', 'IN_PROGRESS', 'WAITING_CLIENT', 'WAITING_EXTERNAL', 'WAITING_HUMAN',
    'IN_REVIEW', 'COMPLETED', 'CANCELLED')),
  priority           smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  owner_agent        text NOT NULL,
  deadline_legal     timestamptz,
  deadline_internal  timestamptz,
  parent_case_id     uuid,
  idempotency_key    text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at          timestamptz,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id),
  FOREIGN KEY (tenant_id, establishment_id) REFERENCES establishment (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_case_id) REFERENCES "case" (tenant_id, id),
  CHECK ((status IN ('COMPLETED', 'CANCELLED')) = (closed_at IS NOT NULL))
);
CREATE INDEX case_open_ix ON "case" (tenant_id, status) WHERE status NOT IN ('COMPLETED', 'CANCELLED');
CREATE INDEX case_entity_ix ON "case" (tenant_id, entity_id, competence);
CREATE TRIGGER case_touch BEFORE UPDATE ON "case" FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE OR REPLACE FUNCTION case_guard_terminal() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('COMPLETED', 'CANCELLED') THEN
    RAISE EXCEPTION 'Case % já encerrado (%)', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.type <> OLD.type
     OR NEW.idempotency_key <> OLD.idempotency_key THEN
    RAISE EXCEPTION 'Case: identidade não pode ser alterada' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER case_guard BEFORE UPDATE ON "case" FOR EACH ROW EXECUTE FUNCTION case_guard_terminal();
SELECT apply_tenant_rls('"case"');

CREATE TABLE case_transition (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  case_id      uuid NOT NULL,
  from_status  text,
  to_status    text NOT NULL,
  reason       text,
  actor_kind   text NOT NULL CHECK (actor_kind IN ('USER', 'AGENT', 'SYSTEM')),
  actor_id     text NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, case_id) REFERENCES "case" (tenant_id, id)
);
CREATE INDEX case_transition_case_ix ON case_transition (tenant_id, case_id, occurred_at);
SELECT apply_tenant_rls('case_transition');

GRANT SELECT, INSERT, UPDATE ON "case" TO legacy_app;
GRANT SELECT, INSERT ON case_transition TO legacy_app;
