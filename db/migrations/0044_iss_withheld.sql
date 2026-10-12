-- 0043 — ISS retido nas NFS-e tomadas: prazo por município e recolhimento.
--
-- Cada município fixa o próprio vencimento do ISS retido pelo tomador. Uma
-- pessoa do escritório informa o dia e o fundamento (lei/decreto municipal);
-- vale para todas as empresas do escritório a partir de valid_from. Mudança é
-- nova linha (nada é sobrescrito). A situação de cada ISS retido entra em
-- withholding_observation como "ISS:<código IBGE do município>".

CREATE TABLE municipal_iss_due (
  id              uuid NOT NULL PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenant (id),
  municipio_ibge  char(7) NOT NULL CHECK (municipio_ibge ~ '^[0-9]{7}$'),
  municipio_name  text NOT NULL,
  day             int NOT NULL CHECK (day BETWEEN 1 AND 31),
  adjust          text NOT NULL CHECK (adjust IN ('NONE', 'NEXT_BUSINESS_DAY', 'PREVIOUS_BUSINESS_DAY')),
  legal_basis     text NOT NULL CHECK (length(legal_basis) >= 3),
  valid_from      date NOT NULL CHECK (extract(day FROM valid_from) = 1),
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, municipio_ibge, valid_from)
);
SELECT apply_tenant_rls('municipal_iss_due');
GRANT SELECT, INSERT ON municipal_iss_due TO legacy_app;

ALTER TABLE withholding_observation DROP CONSTRAINT withholding_observation_tax_check;
ALTER TABLE withholding_observation ADD CONSTRAINT withholding_observation_tax_check
  CHECK (tax IN ('IRRF', 'CSRF') OR tax ~ '^ISS:[0-9]{7}$');
