-- 0023 — Tributos e retenções das NFS-e (agente Fiscal) e situação do
-- recolhimento das retenções federais feitas como tomadora.
--
-- nfse_tax: leitura determinística de cada NFS-e (prestada ou tomada), por versão
-- do leitor. Só INSERT; versão nova do leitor gera linha nova, a anterior fica.
-- withholding_observation: situação por competência e tributo (IRRF, CSRF), uma
-- linha nova quando muda. Nunca se afirma inadimplência.

ALTER TABLE nfse_document ADD CONSTRAINT nfse_document_tenant_id_uk UNIQUE (tenant_id, id);

CREATE TABLE nfse_tax (
  id                      uuid NOT NULL PRIMARY KEY,
  tenant_id               uuid NOT NULL,
  entity_id               uuid NOT NULL,
  nfse_id                 uuid NOT NULL,
  parser                  text NOT NULL,
  role                    text NOT NULL CHECK (role IN ('PRESTADA', 'TOMADA')),
  -- mês de emissão (Brasília): mesma base da apuração do Simples
  competence              date NOT NULL CHECK (extract(day FROM competence) = 1),
  service_date            date,
  provider_simples        text,
  provider_special_regime text,
  national_code           text,
  nbs_code                text,
  incidence_city          text,
  incidence_city_name     text,
  service_value           numeric(15,2),
  unconditional_discount  numeric(15,2) NOT NULL,
  deductions              numeric(15,2) NOT NULL,
  iss_base                numeric(15,2),
  iss_rate                numeric(7,2),
  iss_value               numeric(15,2),
  iss_withheld_type       text,
  iss_withheld            numeric(15,2) NOT NULL,
  irrf                    numeric(15,2) NOT NULL,
  cp                      numeric(15,2) NOT NULL,
  csll_field              numeric(15,2) NOT NULL,
  pis_due                 numeric(15,2) NOT NULL,
  cofins_due              numeric(15,2) NOT NULL,
  pis_cofins_code         text,
  csrf                    numeric(15,2) NOT NULL,
  federal_withheld        numeric(15,2) NOT NULL,
  total_withheld_read     numeric(15,2),
  total_withheld_calc     numeric(15,2) NOT NULL,
  net_value               numeric(15,2),
  ibs                     numeric(15,2),
  cbs                     numeric(15,2),
  read_check              text NOT NULL CHECK (read_check IN ('OK', 'DIVERGENTE', 'SEM_TOTAL')),
  notes                   jsonb NOT NULL DEFAULT '[]',
  created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, nfse_id, parser),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id),
  FOREIGN KEY (tenant_id, nfse_id) REFERENCES nfse_document (tenant_id, id)
);
CREATE INDEX nfse_tax_comp_ix ON nfse_tax (tenant_id, entity_id, role, competence);
SELECT apply_tenant_rls('nfse_tax');

CREATE TABLE withholding_observation (
  id           uuid NOT NULL PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  entity_id    uuid NOT NULL,
  competence   date NOT NULL CHECK (extract(day FROM competence) = 1),
  tax          text NOT NULL CHECK (tax IN ('IRRF', 'CSRF')),
  status       text NOT NULL CHECK (status IN ('PRAZO_A_APROVAR', 'A_VENCER', 'ABAIXO_DO_MINIMO', 'PAGAMENTO_NAO_IDENTIFICADO',
                                               'PAGO', 'PAGO_EM_ATRASO', 'PAGO_DIVERGENTE', 'PAGO_SEM_NOTA')),
  withheld     numeric(15,2) NOT NULL,
  paid         numeric(15,2),
  due_on       date,
  details      jsonb NOT NULL,
  fingerprint  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, entity_id, competence, tax, fingerprint),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX withholding_observation_ix ON withholding_observation (tenant_id, entity_id, competence, tax, created_at DESC);
SELECT apply_tenant_rls('withholding_observation');

GRANT SELECT, INSERT ON nfse_tax, withholding_observation TO legacy_app;

-- Prazo do recolhimento: entra como proposta; vale depois da aprovação do responsável técnico.
INSERT INTO obligation_rule (code, version, name, sphere, periodicity, due, conditions, legal_basis, notes, valid_from) VALUES
('RETENCOES_FEDERAIS', 1, 'IRRF e PIS/COFINS/CSLL retidos de serviços tomados (PJ)', 'FEDERAL', 'MENSAL',
 '{"kind":"next_month_day","day":20,"adjust":"PREVIOUS_BUSINESS_DAY","min_payment":"10.00"}',
 '{"services_any":["FISCAL"],"requires":["withholding_taken"]}',
 'Lei 10.833/2003, arts. 30 e 35 (PIS/COFINS/CSLL); Lei 11.196/2005, art. 70, I (IRRF); Lei 9.430/1996, art. 68 (DARF abaixo de R$ 10,00)',
 'Recolhimento até o último dia útil do 2º decêndio do mês seguinte ao do pagamento ao prestador (dia 20, antecipa se não for dia útil). DARF abaixo de R$ 10,00 acumula para o mês seguinte. A IARIS usa o mês de emissão da nota até ter a data do pagamento (extrato). Declarado na EFD-Reinf (R-4020) e na DCTFWeb.',
 '2025-01-01');
