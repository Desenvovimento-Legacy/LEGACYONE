-- 0051 — Tributos próprios fora do Simples: ISS próprio (NFS-e prestadas) e
-- ICMS próprio (prévia da apuração pelas NF-e: débitos − créditos).
--
-- Valem para empresas fora do Simples e para as do Simples impedidas de recolher
-- ISS/ICMS no DAS (sublimite). O cálculo é determinístico e lê o banco:
--   ISS  = ISS destacado nas NFS-e prestadas sem retenção, por município de incidência
--   ICMS = ICMS das saídas − créditos apropriáveis das entradas − saldo credor anterior
--          (sem ajustes de apuração, CIAP, DIFAL e ST, que ficam indicados para conferência)
-- O vencimento é informado por pessoa: ISS por município (agora com o alcance:
-- retido, próprio ou ambos) e ICMS por UF. A situação de cada tributo é
-- insert-only em local_tax_observation (linha nova quando muda).

ALTER TABLE municipal_iss_due ADD COLUMN applies_to text NOT NULL DEFAULT 'RETIDO'
  CHECK (applies_to IN ('RETIDO', 'PROPRIO', 'AMBOS'));
ALTER TABLE municipal_iss_due DROP CONSTRAINT municipal_iss_due_tenant_id_municipio_ibge_valid_from_key;
ALTER TABLE municipal_iss_due ADD CONSTRAINT municipal_iss_due_scope_uk UNIQUE (tenant_id, municipio_ibge, applies_to, valid_from);

CREATE TABLE state_icms_due (
  id           uuid NOT NULL PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  uf           char(2) NOT NULL CHECK (uf ~ '^[A-Z]{2}$'),
  day          int NOT NULL CHECK (day BETWEEN 1 AND 31),
  adjust       text NOT NULL CHECK (adjust IN ('NONE', 'NEXT_BUSINESS_DAY', 'PREVIOUS_BUSINESS_DAY')),
  legal_basis  text NOT NULL CHECK (length(legal_basis) >= 3),
  valid_from   date NOT NULL CHECK (extract(day FROM valid_from) = 1),
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, uf, valid_from)
);
SELECT apply_tenant_rls('state_icms_due');
GRANT SELECT, INSERT ON state_icms_due TO legacy_app;

CREATE TABLE local_tax_observation (
  id           uuid NOT NULL PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  entity_id    uuid NOT NULL,
  competence   date NOT NULL CHECK (extract(day FROM competence) = 1),
  -- ISSP:<IBGE> (ISS próprio do município) ou ICMS:<UF>
  tax          text NOT NULL CHECK (tax ~ '^ISSP:[0-9]{7}$' OR tax ~ '^ICMS:[A-Z]{2}$'),
  status       text NOT NULL CHECK (status IN ('SEM_IMPOSTO', 'SALDO_CREDOR', 'PRAZO_A_APROVAR', 'A_VENCER', 'GUIA_NAO_ENVIADA',
                                               'PAGAMENTO_NAO_IDENTIFICADO', 'PAGO', 'PAGO_EM_ATRASO', 'A_CONFERIR')),
  amount       numeric(15,2) NOT NULL,
  paid         numeric(15,2),
  due_on       date,
  details      jsonb NOT NULL,
  fingerprint  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, entity_id, competence, tax, fingerprint),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX local_tax_observation_ix ON local_tax_observation (tenant_id, entity_id, competence, tax, created_at DESC);
SELECT apply_tenant_rls('local_tax_observation');
GRANT SELECT, INSERT ON local_tax_observation TO legacy_app;

-- guia enviada ao cliente também para o ISS próprio e o ICMS
ALTER TABLE guide_dispatch DROP CONSTRAINT guide_dispatch_tax_check;
ALTER TABLE guide_dispatch ADD CONSTRAINT guide_dispatch_tax_check
  CHECK (tax IN ('IRRF', 'CSRF', 'SIMPLES') OR tax ~ '^ISS:[0-9]{7}$' OR tax ~ '^ISSP:[0-9]{7}$' OR tax ~ '^ICMS:[A-Z]{2}$');
