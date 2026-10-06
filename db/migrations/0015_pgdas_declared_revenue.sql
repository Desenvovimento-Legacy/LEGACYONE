-- 0015 — Conteúdo da declaração PGDAS-D (PDF oficial) e receita declarada mês a mês.
--
-- A última declaração de um PA (CONSULTIMADECREC14, consulta cobrada) traz o RPA
-- do mês e as receitas brutas dos 12 meses anteriores. O PDF fica guardado com
-- hash (evidência) e pode ser relido sem nova consulta. Cada mês declarado é uma
-- linha ligada à declaração de onde saiu; vale a da declaração mais recente.

CREATE TABLE pgdas_declaration_pdf (
  id                  uuid NOT NULL PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  entity_id           uuid NOT NULL,
  competence          date NOT NULL CHECK (extract(day FROM competence) = 1),
  declaration_number  text CHECK (declaration_number ~ '^[0-9]{17}$'),
  kind                text NOT NULL CHECK (kind IN ('DECLARACAO', 'RECIBO')),
  pdf                 bytea NOT NULL,
  sha256              bytea NOT NULL,
  snapshot_id         uuid REFERENCES external_snapshot (id),
  fetched_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, entity_id, sha256),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
SELECT apply_tenant_rls('pgdas_declaration_pdf');

CREATE TABLE pgdas_declared_revenue (
  id                  uuid NOT NULL PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  entity_id           uuid NOT NULL,
  -- mês da receita
  competence          date NOT NULL CHECK (extract(day FROM competence) = 1),
  -- PA da declaração de onde o valor saiu
  declared_in         date NOT NULL CHECK (extract(day FROM declared_in) = 1),
  declaration_number  text,
  pdf_id              uuid NOT NULL REFERENCES pgdas_declaration_pdf (id),
  source              text NOT NULL CHECK (source IN ('RPA', 'ANTERIOR')),
  regime              text CHECK (regime IN ('COMPETENCIA', 'CAIXA')),
  market_internal     numeric(15,2),
  market_external     numeric(15,2),
  total               numeric(15,2) NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, entity_id, competence, pdf_id),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX pgdas_declared_revenue_ix ON pgdas_declared_revenue (tenant_id, entity_id, competence, declared_in DESC);
SELECT apply_tenant_rls('pgdas_declared_revenue');

GRANT SELECT, INSERT ON pgdas_declaration_pdf, pgdas_declared_revenue TO legacy_app;
