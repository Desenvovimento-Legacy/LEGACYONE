-- 0036 — Plano de contas padrão do escritório (modelo) e configuração do plano da empresa.
--
-- chart_template: modelo importado (ex.: relatório do Domínio). O último
-- importado é o padrão para as empresas novas. Só INSERT.
-- chart_template_account: contas do modelo, com o código reduzido.
-- chart_layout: qual conta faz cada papel nos lançamentos automáticos e como a
-- DRE agrupa, gravado na empresa quando o plano é aplicado (histórico).

CREATE TABLE chart_template (
  id           uuid NOT NULL PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  name         text NOT NULL,
  file_name    text NOT NULL,
  sha256       bytea NOT NULL,
  accounts     int NOT NULL,
  config       jsonb NOT NULL,
  unresolved   jsonb NOT NULL DEFAULT '[]'::jsonb,
  imported_by  text NOT NULL,
  imported_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id)
);
SELECT apply_tenant_rls('chart_template');

CREATE TABLE chart_template_account (
  id           uuid NOT NULL PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  template_id  uuid NOT NULL,
  code         text NOT NULL CHECK (code ~ '^[0-9]+(\.[0-9]+)*$'),
  short_code   text,
  name         text NOT NULL,
  nature       text NOT NULL,
  analytic     boolean NOT NULL,
  parent_code  text,
  UNIQUE (tenant_id, template_id, code),
  FOREIGN KEY (tenant_id, template_id) REFERENCES chart_template (tenant_id, id)
);
SELECT apply_tenant_rls('chart_template_account');

CREATE TABLE chart_layout (
  id           uuid NOT NULL PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  entity_id    uuid NOT NULL,
  template_id  uuid,
  config       jsonb NOT NULL,
  valid_from   date NOT NULL,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id),
  FOREIGN KEY (tenant_id, template_id) REFERENCES chart_template (tenant_id, id)
);
CREATE INDEX chart_layout_entity_ix ON chart_layout (tenant_id, entity_id, valid_from DESC);
SELECT apply_tenant_rls('chart_layout');

ALTER TABLE chart_account ADD COLUMN short_code text;
ALTER TABLE chart_account DROP CONSTRAINT chart_account_nature_check;
ALTER TABLE chart_account ADD CONSTRAINT chart_account_nature_check CHECK (nature IN ('ATIVO', 'PASSIVO', 'PATRIMONIO_LIQUIDO', 'RECEITA', 'CUSTO', 'DESPESA', 'APURACAO'));
ALTER TABLE chart_account DROP CONSTRAINT chart_account_source_check;
ALTER TABLE chart_account ADD CONSTRAINT chart_account_source_check CHECK (source IN ('PADRAO_LEGACY', 'PADRAO_ESCRITORIO', 'MIGRACAO', 'MANUAL', 'BANCO'));

GRANT SELECT, INSERT ON chart_template, chart_template_account, chart_layout TO legacy_app;
