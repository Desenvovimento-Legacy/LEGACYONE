-- 0008 — Dados federais do contribuinte obtidos pelo Integra Contador:
-- índice de declarações PGDAS-D, DAS emitidos e pagamentos (PagtoWeb).
--
-- São fatos externos observados: só INSERT. Situação que muda (DAS pago ou não)
-- vira nova observação, nunca UPDATE. Cada linha aponta para a resposta bruta
-- guardada em external_snapshot.

-- ---------------------------------------------------------------- PGDAS-D: declarações
CREATE TABLE pgdas_declaration (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenant (id),
  entity_id           uuid NOT NULL,
  competence          date NOT NULL CHECK (extract(day FROM competence) = 1),
  declaration_number  text NOT NULL CHECK (declaration_number ~ '^[0-9]{17}$'),
  operation           text NOT NULL CHECK (operation IN ('ORIGINAL', 'RETIFICADORA')),
  transmitted_at      timestamptz,
  malha               text,
  source              text NOT NULL,
  snapshot_id         uuid NOT NULL REFERENCES external_snapshot (id),
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, declaration_number),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX pgdas_declaration_entity_ix ON pgdas_declaration (tenant_id, entity_id, competence);
SELECT apply_tenant_rls('pgdas_declaration');

-- ---------------------------------------------------------------- PGDAS-D: DAS emitidos
CREATE TABLE pgdas_das (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  entity_id    uuid NOT NULL,
  competence   date NOT NULL CHECK (extract(day FROM competence) = 1),
  das_number   text NOT NULL CHECK (das_number ~ '^[0-9]{17}$'),
  operation    text NOT NULL CHECK (operation IN ('GERACAO_DAS', 'DAS_AVULSO', 'DAS_MEDIDA_JUDICIAL', 'DAS_COBRANCA', 'OUTRO')),
  issued_at    timestamptz,
  source       text NOT NULL,
  snapshot_id  uuid NOT NULL REFERENCES external_snapshot (id),
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, das_number),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX pgdas_das_entity_ix ON pgdas_das (tenant_id, entity_id, competence);
SELECT apply_tenant_rls('pgdas_das');

-- Observações da situação de pagamento informada pelo PGDAS-D ("dasPago").
-- Uma linha nova só quando a situação muda.
CREATE TABLE pgdas_das_status (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  das_id       uuid NOT NULL,
  paid         boolean NOT NULL,
  observed_at  timestamptz NOT NULL,
  snapshot_id  uuid NOT NULL REFERENCES external_snapshot (id),
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, das_id) REFERENCES pgdas_das (tenant_id, id)
);
CREATE INDEX pgdas_das_status_ix ON pgdas_das_status (tenant_id, das_id, observed_at DESC);
SELECT apply_tenant_rls('pgdas_das_status');

-- ---------------------------------------------------------------- PagtoWeb: pagamentos
CREATE TABLE federal_payment (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenant (id),
  entity_id            uuid NOT NULL,
  document_number      text NOT NULL,
  document_type_code   text,
  document_type        text,
  competence           date CHECK (competence IS NULL OR extract(day FROM competence) = 1),
  collected_on         date NOT NULL,
  due_on               date,
  revenue_code         text,
  revenue_description  text,
  amount_total         numeric(15, 2) NOT NULL,
  amount_principal     numeric(15, 2),
  amount_fine          numeric(15, 2),
  amount_interest      numeric(15, 2),
  -- Composição (desmembramentos) como veio da Receita: tributo por tributo.
  breakdown            jsonb NOT NULL DEFAULT '[]',
  source               text NOT NULL,
  snapshot_id          uuid NOT NULL REFERENCES external_snapshot (id),
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, entity_id, document_number),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX federal_payment_entity_ix ON federal_payment (tenant_id, entity_id, collected_on);
SELECT apply_tenant_rls('federal_payment');

GRANT SELECT, INSERT ON pgdas_declaration, pgdas_das, pgdas_das_status, federal_payment TO legacy_app;
