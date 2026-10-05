-- Tenancy e cadastro de entidades.
--
-- Regras desta migração que valem para todo o schema:
--   1. Toda tabela de negócio tem tenant_id e RLS FORÇADA (inclusive para o dono).
--   2. Referência entre tabelas de tenant usa FK composta (tenant_id, id): o banco
--      recusa apontar para registro de outro escritório, mesmo por FK.
--   3. Informação que muda no tempo vive em tabela *_history com valid_from/valid_to
--      (valid_to inclusivo, NULL = vigente) e sem sobreposição de vigência.

-- Aplica isolamento por tenant a uma tabela.
CREATE OR REPLACE FUNCTION apply_tenant_rls(t regclass) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s FOR ALL TO legacy_app '
    'USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
END
$$;

-- ---------------------------------------------------------------- tenant
CREATE TABLE tenant (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
-- A aplicação só enxerga o próprio escritório e não cria escritórios.
CREATE POLICY tenant_self ON tenant FOR SELECT TO legacy_app USING (id = current_tenant());
GRANT SELECT ON tenant TO legacy_app;

-- ---------------------------------------------------------------- usuários
-- Autenticação e MFA ficam no provedor de identidade (OIDC); aqui ficam vínculo e papel.
CREATE TABLE app_user (
  id          uuid NOT NULL,
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  email       text NOT NULL,
  name        text NOT NULL,
  role        text NOT NULL CHECK (role IN ('ADMIN', 'MANAGER', 'ACCOUNTANT', 'ANALYST', 'CLIENT')),
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX app_user_email_uq ON app_user (tenant_id, lower(email));
CREATE TRIGGER app_user_touch BEFORE UPDATE ON app_user FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
SELECT apply_tenant_rls('app_user');

-- ---------------------------------------------------------------- cliente
-- Relação comercial do escritório. Um cliente pode ter várias entidades (grupo econômico).
CREATE TABLE client (
  id          uuid NOT NULL,
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id)
);
CREATE TRIGGER client_touch BEFORE UPDATE ON client FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
SELECT apply_tenant_rls('client');

-- ---------------------------------------------------------------- entidade
-- CNPJ e CPF em colunas de texto distintas. CNPJ aceita o formato alfanumérico.
CREATE TABLE entity (
  id           uuid NOT NULL,
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  client_id    uuid NOT NULL,
  person_kind  text NOT NULL CHECK (person_kind IN ('PJ', 'PF')),
  cnpj         char(14),
  cpf          char(11),
  legal_name   text NOT NULL,
  trade_name   text,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, id),
  CONSTRAINT entity_document_ck CHECK (
    (person_kind = 'PJ' AND cnpj IS NOT NULL AND cpf IS NULL AND cnpj_is_valid(cnpj))
    OR (person_kind = 'PF' AND cpf IS NOT NULL AND cnpj IS NULL AND cpf_is_valid(cpf))
  )
);
CREATE UNIQUE INDEX entity_cnpj_uq ON entity (tenant_id, cnpj) WHERE cnpj IS NOT NULL;
CREATE UNIQUE INDEX entity_cpf_uq ON entity (tenant_id, cpf) WHERE cpf IS NOT NULL;
CREATE TRIGGER entity_touch BEFORE UPDATE ON entity FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
SELECT apply_tenant_rls('entity');

-- ---------------------------------------------------------------- estabelecimento
CREATE TABLE establishment (
  id               uuid NOT NULL,
  tenant_id        uuid NOT NULL,
  entity_id        uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('MATRIZ', 'FILIAL', 'OBRA_CNO', 'RURAL_CAEPF')),
  cnpj             char(14) CHECK (cnpj IS NULL OR cnpj_is_valid(cnpj)),
  cno              text,
  caepf            text,
  uf               char(2) NOT NULL CHECK (uf ~ '^[A-Z]{2}$'),
  municipio_ibge   char(7) NOT NULL CHECK (municipio_ibge ~ '^[0-9]{7}$'),
  opened_at        date NOT NULL,
  closed_at        date CHECK (closed_at IS NULL OR closed_at >= opened_at),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id),
  CONSTRAINT establishment_identifier_ck CHECK (
    (kind IN ('MATRIZ', 'FILIAL') AND cnpj IS NOT NULL)
    OR (kind = 'OBRA_CNO' AND cno IS NOT NULL)
    OR (kind = 'RURAL_CAEPF' AND caepf IS NOT NULL)
  )
);
CREATE UNIQUE INDEX establishment_cnpj_uq ON establishment (tenant_id, cnpj) WHERE cnpj IS NOT NULL;
CREATE UNIQUE INDEX establishment_one_matriz_uq ON establishment (tenant_id, entity_id) WHERE kind = 'MATRIZ';
CREATE TRIGGER establishment_touch BEFORE UPDATE ON establishment FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Estabelecimento com CNPJ precisa compartilhar a raiz (8 primeiras posições) da entidade.
CREATE OR REPLACE FUNCTION establishment_check_root() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  root char(8);
BEGIN
  IF NEW.cnpj IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT left(cnpj, 8) INTO root FROM entity WHERE tenant_id = NEW.tenant_id AND id = NEW.entity_id;
  IF root IS NULL OR left(NEW.cnpj, 8) <> root THEN
    RAISE EXCEPTION 'CNPJ % não pertence à raiz da entidade', NEW.cnpj
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER establishment_root BEFORE INSERT OR UPDATE OF cnpj, entity_id ON establishment
  FOR EACH ROW EXECUTE FUNCTION establishment_check_root();
SELECT apply_tenant_rls('establishment');

-- ---------------------------------------------------------------- históricos temporais
-- Tipo de entidade, regime tributário e serviços contratados são dimensões separadas.

CREATE TABLE entity_type_history (
  id           uuid NOT NULL PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  entity_id    uuid NOT NULL,
  entity_type  text NOT NULL CHECK (entity_type IN (
    'SOCIEDADE_EMPRESARIA', 'SOCIEDADE_SIMPLES', 'EMPRESARIO_INDIVIDUAL', 'SLU',
    'ASSOCIACAO', 'FUNDACAO', 'ORGANIZACAO_RELIGIOSA', 'COOPERATIVA', 'CONDOMINIO',
    'PRODUTOR_RURAL', 'PESSOA_FISICA')),
  valid_from   date NOT NULL,
  valid_to     date CHECK (valid_to IS NULL OR valid_to >= valid_from),
  source       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id),
  EXCLUDE USING gist (tenant_id WITH =, entity_id WITH =, daterange(valid_from, valid_to, '[]') WITH &&)
);
SELECT apply_tenant_rls('entity_type_history');

CREATE TABLE tax_regime_history (
  id           uuid NOT NULL PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  entity_id    uuid NOT NULL,
  regime       text NOT NULL CHECK (regime IN (
    'SIMPLES_NACIONAL', 'MEI', 'LUCRO_PRESUMIDO', 'LUCRO_REAL_ANUAL', 'LUCRO_REAL_TRIMESTRAL',
    'LUCRO_ARBITRADO', 'IMUNE', 'ISENTA')),
  valid_from   date NOT NULL,
  valid_to     date CHECK (valid_to IS NULL OR valid_to >= valid_from),
  source       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id),
  EXCLUDE USING gist (tenant_id WITH =, entity_id WITH =, daterange(valid_from, valid_to, '[]') WITH &&)
);
SELECT apply_tenant_rls('tax_regime_history');

CREATE TABLE contracted_service_history (
  id           uuid NOT NULL PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  entity_id    uuid NOT NULL,
  service      text NOT NULL CHECK (service IN (
    'CONTABIL', 'FISCAL', 'FOLHA', 'SOCIETARIO', 'FINANCEIRO', 'IRPF')),
  valid_from   date NOT NULL,
  valid_to     date CHECK (valid_to IS NULL OR valid_to >= valid_from),
  source       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id),
  EXCLUDE USING gist (tenant_id WITH =, entity_id WITH =, service WITH =,
                      daterange(valid_from, valid_to, '[]') WITH &&)
);
SELECT apply_tenant_rls('contracted_service_history');

-- "Qual era a configuração da entidade em uma data?" — responde com uma chamada.
-- SECURITY INVOKER: respeita a RLS de quem consulta.
CREATE OR REPLACE FUNCTION entity_profile_as_of(p_entity uuid, p_date date)
RETURNS TABLE (entity_type text, regime text, services text[])
LANGUAGE sql STABLE
AS $$
  SELECT
    (SELECT h.entity_type FROM entity_type_history h
      WHERE h.entity_id = p_entity AND p_date <@ daterange(h.valid_from, h.valid_to, '[]')),
    (SELECT h.regime FROM tax_regime_history h
      WHERE h.entity_id = p_entity AND p_date <@ daterange(h.valid_from, h.valid_to, '[]')),
    coalesce((SELECT array_agg(h.service ORDER BY h.service) FROM contracted_service_history h
      WHERE h.entity_id = p_entity AND p_date <@ daterange(h.valid_from, h.valid_to, '[]')), '{}')
$$;

-- Correção é nova linha ou encerramento de vigência, nunca exclusão.
GRANT SELECT, INSERT, UPDATE ON app_user, client, entity, establishment TO legacy_app;
GRANT SELECT, INSERT ON entity_type_history, tax_regime_history, contracted_service_history TO legacy_app;
GRANT UPDATE (valid_to) ON entity_type_history, tax_regime_history, contracted_service_history TO legacy_app;
