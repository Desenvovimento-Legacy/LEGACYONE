-- 0045 — Itens das NF-e/NFC-e (CFOP, CST, ST) e créditos das entradas.
--
-- Cada item lido do XML autorizado (NF-e da SEFAZ ou XML enviado) com as
-- conferências de CFOP/CST, o sentido da operação para a empresa e o CFOP de
-- entrada proposto. O crédito de cada tributo vem do regime da empresa na data
-- da nota (Simples: não se aplica). Versão do leitor/regra muda = linhas novas.

CREATE TABLE nfe_item (
  id               uuid NOT NULL PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  entity_id        uuid NOT NULL,
  source           text NOT NULL CHECK (source IN ('SEFAZ', 'XML')),
  source_id        uuid NOT NULL,
  access_key       char(44) NOT NULL CHECK (access_key ~ '^[0-9]{44}$'),
  model            text,
  direction        text NOT NULL CHECK (direction IN ('ENTRADA', 'SAIDA')),
  issued_at        timestamptz,
  competence       date CHECK (competence IS NULL OR extract(day FROM competence) = 1),
  issuer_doc       text,
  issuer_name      text,
  issuer_crt       text,
  counterpart_doc  text,
  n_item           int NOT NULL,
  product_code     text,
  description      text,
  ncm              text,
  cest             text,
  cfop             text,
  quantity         numeric(18,4),
  total            numeric(15,2) NOT NULL,
  discount         numeric(15,2) NOT NULL DEFAULT 0,
  freight          numeric(15,2) NOT NULL DEFAULT 0,
  other            numeric(15,2) NOT NULL DEFAULT 0,
  origin           text,
  icms_cst         text,
  icms_csosn       text,
  icms_base        numeric(15,2) NOT NULL DEFAULT 0,
  icms_rate        numeric(9,4),
  icms_value       numeric(15,2) NOT NULL DEFAULT 0,
  st_base          numeric(15,2) NOT NULL DEFAULT 0,
  st_value         numeric(15,2) NOT NULL DEFAULT 0,
  st_retained      numeric(15,2) NOT NULL DEFAULT 0,
  sn_credit_rate   numeric(9,4),
  sn_credit_value  numeric(15,2) NOT NULL DEFAULT 0,
  ipi_cst          text,
  ipi_value        numeric(15,2) NOT NULL DEFAULT 0,
  pis_cst          text,
  pis_value        numeric(15,2) NOT NULL DEFAULT 0,
  cofins_cst       text,
  cofins_value     numeric(15,2) NOT NULL DEFAULT 0,
  has_st           boolean NOT NULL,
  monophasic       boolean NOT NULL,
  entry_cfop       text,
  entry_cfop_why   text,
  checks           jsonb NOT NULL DEFAULT '[]',
  parser           text NOT NULL,
  rules            text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, entity_id, access_key, n_item, parser, rules),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX nfe_item_comp_ix ON nfe_item (tenant_id, entity_id, competence, direction);
SELECT apply_tenant_rls('nfe_item');

CREATE TABLE nfe_item_credit (
  id          uuid NOT NULL PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  entity_id   uuid NOT NULL,
  item_id     uuid NOT NULL,
  tax         text NOT NULL CHECK (tax IN ('ICMS', 'IPI', 'PIS', 'COFINS')),
  regime      text,
  status      text NOT NULL CHECK (status IN ('APROPRIAVEL', 'NAO_SE_APLICA', 'A_CONFERIR')),
  base        numeric(15,2),
  rate        numeric(9,4),
  value       numeric(15,2) NOT NULL,
  reason      text NOT NULL,
  rules       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, item_id, tax, rules),
  FOREIGN KEY (tenant_id, item_id) REFERENCES nfe_item (tenant_id, id),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
SELECT apply_tenant_rls('nfe_item_credit');

GRANT SELECT, INSERT ON nfe_item, nfe_item_credit TO legacy_app;
