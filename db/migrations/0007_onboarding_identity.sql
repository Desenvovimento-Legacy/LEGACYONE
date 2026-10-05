-- Fase 1: cadastro completo da entidade, identidade digital, pendências e autorização.

ALTER TABLE entity ADD COLUMN activity_started_at date;

-- ---------------------------------------------------------------- CNAEs por estabelecimento
CREATE TABLE activity_history (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  establishment_id  uuid NOT NULL,
  cnae              char(7) NOT NULL CHECK (cnae ~ '^[0-9]{7}$'),
  description       text,
  is_primary        boolean NOT NULL,
  valid_from        date NOT NULL,
  valid_to          date CHECK (valid_to IS NULL OR valid_to >= valid_from),
  source            text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, establishment_id) REFERENCES establishment (tenant_id, id),
  -- o mesmo CNAE não aparece duas vezes no mesmo período
  EXCLUDE USING gist (tenant_id WITH =, establishment_id WITH =, cnae WITH =,
                      daterange(valid_from, valid_to, '[]') WITH &&)
);
-- um único CNAE principal por vez
CREATE UNIQUE INDEX activity_one_primary_open_uq ON activity_history (tenant_id, establishment_id)
  WHERE is_primary AND valid_to IS NULL;
SELECT apply_tenant_rls('activity_history');

-- ---------------------------------------------------------------- quadro societário
-- Documento do sócio vem mascarado da base pública; o completo entra pelo cadastro do cliente.
CREATE TABLE partner_history (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  entity_id           uuid NOT NULL,
  name                text NOT NULL,
  document_masked     text,
  qualification_code  int,
  qualification       text,
  is_administrator    boolean NOT NULL DEFAULT false,
  valid_from          date NOT NULL,
  valid_to            date CHECK (valid_to IS NULL OR valid_to >= valid_from),
  source              text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX partner_entity_ix ON partner_history (tenant_id, entity_id);
SELECT apply_tenant_rls('partner_history');

-- ---------------------------------------------------------------- evidência de consulta externa
-- Resposta bruta de órgão ou base pública, com hash. Nunca alterada.
CREATE TABLE external_snapshot (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  entity_id    uuid,
  source       text NOT NULL,
  request_key  text NOT NULL,
  fetched_at   timestamptz NOT NULL,
  sha256       bytea NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, source, sha256)
);
CREATE INDEX external_snapshot_entity_ix ON external_snapshot (tenant_id, entity_id, source, fetched_at DESC);
SELECT apply_tenant_rls('external_snapshot');

-- ---------------------------------------------------------------- procurações
CREATE TABLE power_of_attorney (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL,
  entity_id          uuid NOT NULL,
  system             text NOT NULL CHECK (system IN ('ECAC', 'ESOCIAL', 'SEFAZ', 'PREFEITURA', 'OUTRO')),
  grantee_document   text NOT NULL,
  scopes             text[] NOT NULL DEFAULT '{}',
  valid_from         date NOT NULL,
  valid_to           date CHECK (valid_to IS NULL OR valid_to >= valid_from),
  source             text NOT NULL,
  verified_at        timestamptz NOT NULL,
  snapshot_id        uuid REFERENCES external_snapshot (id),
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX power_of_attorney_entity_ix ON power_of_attorney (tenant_id, entity_id, system);
SELECT apply_tenant_rls('power_of_attorney');

-- ---------------------------------------------------------------- certificados digitais
-- Só metadados. Chave privada e senha ficam no cofre (vault_ref), nunca no banco.
CREATE TABLE digital_certificate (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenant (id),
  owner_kind       text NOT NULL CHECK (owner_kind IN ('OFFICE', 'ENTITY', 'PERSON')),
  entity_id        uuid,
  holder_document  text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('A1', 'A3')),
  subject          text NOT NULL,
  serial_number    text NOT NULL,
  valid_from       timestamptz NOT NULL,
  valid_to         timestamptz NOT NULL CHECK (valid_to > valid_from),
  vault_ref        text,
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'REPLACED')),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id),
  CHECK (kind = 'A3' OR vault_ref IS NOT NULL),
  UNIQUE (tenant_id, serial_number)
);
SELECT apply_tenant_rls('digital_certificate');

-- ---------------------------------------------------------------- pendências (Pending Engine)
CREATE TABLE pending_item (
  id                     uuid PRIMARY KEY,
  tenant_id              uuid NOT NULL,
  entity_id              uuid,
  case_id                uuid,
  type                   text NOT NULL CHECK (type ~ '^[A-Z][A-Z0-9_]+$'),
  required_information   text NOT NULL,
  responsible_source     text NOT NULL CHECK (responsible_source IN ('CLIENT', 'OFFICE', 'EXTERNAL')),
  channel                text,
  impact                 text NOT NULL,
  status                 text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED', 'WAIVED')),
  deadline               timestamptz,
  attempts               int NOT NULL DEFAULT 0,
  resolution             text,
  created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at            timestamptz,
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES "case" (tenant_id, id),
  CHECK ((status = 'OPEN') = (resolved_at IS NULL))
);
-- a mesma pendência não abre duas vezes para a mesma entidade
CREATE UNIQUE INDEX pending_item_open_uq ON pending_item (tenant_id, coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid), type)
  WHERE status = 'OPEN';
SELECT apply_tenant_rls('pending_item');

-- ---------------------------------------------------------------- capacidades e autorização
-- Quem pode aprovar o quê (ex.: responsável técnico libera regras e transmissões).
CREATE TABLE user_capability (
  tenant_id    uuid NOT NULL,
  user_id      uuid NOT NULL,
  capability   text NOT NULL CHECK (capability IN ('RULE_RELEASE', 'TRANSMISSION_APPROVAL', 'AUTONOMY_PROMOTION', 'PERIOD_REOPEN')),
  granted_by   text NOT NULL,
  valid_from   date NOT NULL,
  valid_to     date CHECK (valid_to IS NULL OR valid_to >= valid_from),
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, capability, valid_from),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user (tenant_id, id)
);
SELECT apply_tenant_rls('user_capability');

-- Autorização de uso único emitida pelo Authorization Service.
CREATE TABLE authorization_grant (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenant (id),
  actor_kind     text NOT NULL CHECK (actor_kind IN ('USER', 'AGENT', 'SYSTEM')),
  actor_id       text NOT NULL,
  action         text NOT NULL,
  entity_id      uuid,
  scope          jsonb NOT NULL DEFAULT '{}',
  policy_ref     text NOT NULL,
  issued_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  CHECK (expires_at > issued_at)
);
SELECT apply_tenant_rls('authorization_grant');

GRANT SELECT, INSERT ON activity_history, partner_history, power_of_attorney, digital_certificate,
  pending_item, user_capability, authorization_grant, external_snapshot TO legacy_app;
GRANT UPDATE (valid_to) ON activity_history, partner_history, power_of_attorney, user_capability TO legacy_app;
GRANT UPDATE (status) ON digital_certificate TO legacy_app;
GRANT UPDATE (status, attempts, resolution, resolved_at, deadline) ON pending_item TO legacy_app;
GRANT UPDATE (consumed_at) ON authorization_grant TO legacy_app;
GRANT UPDATE (activity_started_at) ON entity TO legacy_app;
