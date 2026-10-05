-- Event Bus: outbox transacional + inbox de deduplicação.
--
-- O módulo grava o dado e o evento na mesma transação. Um relay (papel legacy_relay)
-- publica o outbox no NATS JetStream e marca published_at. Evento nunca é alterado
-- depois de gravado: só os campos de controle de publicação mudam.

CREATE TABLE outbox (
  event_id         uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenant (id),
  type             text NOT NULL CHECK (type ~ '^[A-Z][A-Z0-9_]+$'),
  schema_version   int  NOT NULL CHECK (schema_version > 0),
  entity_id        uuid,
  establishment_id uuid,
  case_id          uuid,
  competence       date CHECK (competence IS NULL OR extract(day FROM competence) = 1),
  occurred_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  producer         jsonb NOT NULL,
  causation_id     uuid,
  correlation_id   uuid NOT NULL,
  idempotency_key  text NOT NULL,
  payload          jsonb NOT NULL,
  evidence_refs    jsonb NOT NULL DEFAULT '[]',
  confidence       numeric(5,4) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  -- controle de publicação
  published_at     timestamptz,
  attempts         int NOT NULL DEFAULT 0,
  last_error       text,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX outbox_pending_ix ON outbox (occurred_at) WHERE published_at IS NULL;
CREATE INDEX outbox_case_ix ON outbox (tenant_id, case_id);

SELECT apply_tenant_rls('outbox');
-- O relay atravessa tenants, mas só no outbox e só para ler e marcar publicação.
CREATE POLICY relay_all ON outbox FOR ALL TO legacy_relay USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON outbox TO legacy_app;
GRANT SELECT ON outbox TO legacy_relay;
GRANT UPDATE (published_at, attempts, last_error) ON outbox TO legacy_relay;

-- Conteúdo do evento é imutável, inclusive para o dono do schema.
CREATE OR REPLACE FUNCTION outbox_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'outbox: eventos não podem ser excluídos' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.event_id, NEW.tenant_id, NEW.type, NEW.schema_version, NEW.entity_id, NEW.establishment_id,
      NEW.case_id, NEW.competence, NEW.occurred_at, NEW.producer, NEW.causation_id, NEW.correlation_id,
      NEW.idempotency_key, NEW.payload, NEW.evidence_refs, NEW.confidence)
     IS DISTINCT FROM
     (OLD.event_id, OLD.tenant_id, OLD.type, OLD.schema_version, OLD.entity_id, OLD.establishment_id,
      OLD.case_id, OLD.competence, OLD.occurred_at, OLD.producer, OLD.causation_id, OLD.correlation_id,
      OLD.idempotency_key, OLD.payload, OLD.evidence_refs, OLD.confidence) THEN
    RAISE EXCEPTION 'outbox: conteúdo do evento é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER outbox_guard BEFORE UPDATE OR DELETE ON outbox FOR EACH ROW EXECUTE FUNCTION outbox_guard();

-- Inbox: cada consumidor processa cada evento uma única vez.
CREATE TABLE inbox (
  consumer      text NOT NULL,
  event_id      uuid NOT NULL,
  tenant_id     uuid NOT NULL REFERENCES tenant (id),
  processed_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (consumer, event_id)
);
SELECT apply_tenant_rls('inbox');
GRANT SELECT, INSERT ON inbox TO legacy_app;
