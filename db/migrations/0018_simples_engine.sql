-- 0018 — Motor do Simples Nacional: tabelas dos Anexos como regra versionada,
-- débito declarado por tributo (lido do PDF oficial do PGDAS-D) e histórico
-- dos cálculos do motor.
--
-- As tabelas entram como PROPOSTA: só valem para um escritório depois da
-- aprovação do responsável técnico (simples_rule_approval). Mudança de lei vira
-- nova versão; a anterior recebe superseded_at e continua no histórico.

CREATE TABLE simples_rule (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL CHECK (code IN ('ANEXO_I', 'ANEXO_II', 'ANEXO_III', 'ANEXO_IV', 'ANEXO_V', 'PARAMETROS')),
  version        int  NOT NULL CHECK (version > 0),
  name           text NOT NULL,
  definition     jsonb NOT NULL,
  legal_basis    text NOT NULL,
  notes          text,
  valid_from     date NOT NULL,
  valid_to       date CHECK (valid_to IS NULL OR valid_to >= valid_from),
  superseded_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (code, version)
);
GRANT SELECT ON simples_rule TO legacy_app;

CREATE TABLE simples_rule_approval (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  rule_id      uuid NOT NULL REFERENCES simples_rule (id),
  approved_by  text NOT NULL,
  approved_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, rule_id)
);
SELECT apply_tenant_rls('simples_rule_approval');

-- Débito declarado por atividade, como está no PDF da declaração (seções 2.1 e 2.7).
CREATE TABLE pgdas_declared_tax (
  id                  uuid NOT NULL PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  entity_id           uuid NOT NULL,
  competence          date NOT NULL CHECK (extract(day FROM competence) = 1),
  declaration_number  text,
  pdf_id              uuid NOT NULL REFERENCES pgdas_declaration_pdf (id),
  seq                 int  NOT NULL CHECK (seq > 0),
  activity            text NOT NULL,
  annex               text CHECK (annex IN ('I', 'II', 'III', 'IV', 'V')),
  local_withheld      boolean,
  factor_r            boolean NOT NULL DEFAULT false,
  revenue             numeric(15,2) NOT NULL,
  irpj                numeric(15,2) NOT NULL,
  csll                numeric(15,2) NOT NULL,
  cofins              numeric(15,2) NOT NULL,
  pis                 numeric(15,2) NOT NULL,
  cpp                 numeric(15,2) NOT NULL,
  icms                numeric(15,2) NOT NULL,
  ipi                 numeric(15,2) NOT NULL,
  iss                 numeric(15,2) NOT NULL,
  total               numeric(15,2) NOT NULL,
  rbt12               numeric(15,2),
  rba                 numeric(15,2),
  rbaa                numeric(15,2),
  sublimit            numeric(15,2),
  local_impeded       boolean,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, pdf_id, seq),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX pgdas_declared_tax_ix ON pgdas_declared_tax (tenant_id, entity_id, competence);
SELECT apply_tenant_rls('pgdas_declared_tax');

-- Cálculos do motor. Só INSERT: uma linha nova quando entrada ou resultado mudam.
--   CONFERENCIA = competência já declarada: recalcula com a receita declarada e
--                 compara com o débito declarado (ou o DAS pago).
--   APURACAO    = competência ainda não declarada: calcula com a receita das notas.
CREATE TABLE simples_calculation (
  id               uuid NOT NULL PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  entity_id        uuid NOT NULL,
  competence       date NOT NULL CHECK (extract(day FROM competence) = 1),
  mode             text NOT NULL CHECK (mode IN ('CONFERENCIA', 'APURACAO')),
  status           text NOT NULL CHECK (status IN ('CONFERE', 'DIVERGE', 'CALCULADO', 'SEM_REFERENCIA', 'REGRA_PENDENTE', 'SEM_ANEXO', 'NAO_SUPORTADO')),
  rule_refs        text[] NOT NULL DEFAULT '{}',
  engine_version   text NOT NULL,
  inputs           jsonb NOT NULL,
  result           jsonb,
  total            numeric(15,2),
  reference_kind   text CHECK (reference_kind IN ('DECLARACAO', 'DAS_PAGO')),
  reference_total  numeric(15,2),
  difference       numeric(15,2),
  fingerprint      text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, entity_id, competence, fingerprint),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX simples_calculation_ix ON simples_calculation (tenant_id, entity_id, competence, created_at DESC);
SELECT apply_tenant_rls('simples_calculation');

GRANT SELECT, INSERT ON simples_rule_approval, pgdas_declared_tax, simples_calculation TO legacy_app;

INSERT INTO simples_rule (code, version, name, definition, legal_basis, notes, valid_from) VALUES
('ANEXO_I', 1, 'Anexo I — Comércio', '{"kind": "ANEXO", "annex": "I", "localTax": "ICMS", "brackets": [{"n": 1, "upTo": "180000.00", "rate": "4.00", "deduction": "0.00", "shares": {"IRPJ": "5.50", "CSLL": "3.50", "COFINS": "12.74", "PIS": "2.76", "CPP": "41.50", "ICMS": "34.00"}}, {"n": 2, "upTo": "360000.00", "rate": "7.30", "deduction": "5940.00", "shares": {"IRPJ": "5.50", "CSLL": "3.50", "COFINS": "12.74", "PIS": "2.76", "CPP": "41.50", "ICMS": "34.00"}}, {"n": 3, "upTo": "720000.00", "rate": "9.50", "deduction": "13860.00", "shares": {"IRPJ": "5.50", "CSLL": "3.50", "COFINS": "12.74", "PIS": "2.76", "CPP": "42.00", "ICMS": "33.50"}}, {"n": 4, "upTo": "1800000.00", "rate": "10.70", "deduction": "22500.00", "shares": {"IRPJ": "5.50", "CSLL": "3.50", "COFINS": "12.74", "PIS": "2.76", "CPP": "42.00", "ICMS": "33.50"}}, {"n": 5, "upTo": "3600000.00", "rate": "14.30", "deduction": "87300.00", "shares": {"IRPJ": "5.50", "CSLL": "3.50", "COFINS": "12.74", "PIS": "2.76", "CPP": "42.00", "ICMS": "33.50"}}, {"n": 6, "upTo": "4800000.00", "rate": "19.00", "deduction": "378000.00", "shares": {"IRPJ": "13.50", "CSLL": "10.00", "COFINS": "28.27", "PIS": "6.13", "CPP": "42.10"}}]}',
 'LC 123/2006, art. 18 e Anexo I (LC 155/2016); Res. CGSN 140/2018, arts. 21 a 25', 'Transcrito da LC 123/2006 (redação da LC 155/2016); conferir com o texto oficial antes de aprovar.', '2018-01-01'),
('ANEXO_II', 1, 'Anexo II — Indústria', '{"kind": "ANEXO", "annex": "II", "localTax": "ICMS", "brackets": [{"n": 1, "upTo": "180000.00", "rate": "4.50", "deduction": "0.00", "shares": {"IRPJ": "5.50", "CSLL": "3.50", "COFINS": "11.51", "PIS": "2.49", "CPP": "37.50", "IPI": "7.50", "ICMS": "32.00"}}, {"n": 2, "upTo": "360000.00", "rate": "7.80", "deduction": "5940.00", "shares": {"IRPJ": "5.50", "CSLL": "3.50", "COFINS": "11.51", "PIS": "2.49", "CPP": "37.50", "IPI": "7.50", "ICMS": "32.00"}}, {"n": 3, "upTo": "720000.00", "rate": "10.00", "deduction": "13860.00", "shares": {"IRPJ": "5.50", "CSLL": "3.50", "COFINS": "11.51", "PIS": "2.49", "CPP": "37.50", "IPI": "7.50", "ICMS": "32.00"}}, {"n": 4, "upTo": "1800000.00", "rate": "11.20", "deduction": "22500.00", "shares": {"IRPJ": "5.50", "CSLL": "3.50", "COFINS": "11.51", "PIS": "2.49", "CPP": "37.50", "IPI": "7.50", "ICMS": "32.00"}}, {"n": 5, "upTo": "3600000.00", "rate": "14.70", "deduction": "85500.00", "shares": {"IRPJ": "5.50", "CSLL": "3.50", "COFINS": "11.51", "PIS": "2.49", "CPP": "37.50", "IPI": "7.50", "ICMS": "32.00"}}, {"n": 6, "upTo": "4800000.00", "rate": "30.00", "deduction": "720000.00", "shares": {"IRPJ": "8.50", "CSLL": "7.50", "COFINS": "20.96", "PIS": "4.54", "CPP": "23.50", "IPI": "35.00"}}]}',
 'LC 123/2006, art. 18 e Anexo II (LC 155/2016); Res. CGSN 140/2018, arts. 21 a 25', 'Transcrito da LC 123/2006 (redação da LC 155/2016); conferir com o texto oficial antes de aprovar.', '2018-01-01'),
('ANEXO_III', 1, 'Anexo III — Serviços (locação de bens móveis e serviços do art. 18, § 5º-B)', '{"kind": "ANEXO", "annex": "III", "localTax": "ISS", "brackets": [{"n": 1, "upTo": "180000.00", "rate": "6.00", "deduction": "0.00", "shares": {"IRPJ": "4.00", "CSLL": "3.50", "COFINS": "12.82", "PIS": "2.78", "CPP": "43.40", "ISS": "33.50"}}, {"n": 2, "upTo": "360000.00", "rate": "11.20", "deduction": "9360.00", "shares": {"IRPJ": "4.00", "CSLL": "3.50", "COFINS": "14.05", "PIS": "3.05", "CPP": "43.40", "ISS": "32.00"}}, {"n": 3, "upTo": "720000.00", "rate": "13.50", "deduction": "17640.00", "shares": {"IRPJ": "4.00", "CSLL": "3.50", "COFINS": "13.64", "PIS": "2.96", "CPP": "43.40", "ISS": "32.50"}}, {"n": 4, "upTo": "1800000.00", "rate": "16.00", "deduction": "35640.00", "shares": {"IRPJ": "4.00", "CSLL": "3.50", "COFINS": "13.64", "PIS": "2.96", "CPP": "43.40", "ISS": "32.50"}}, {"n": 5, "upTo": "3600000.00", "rate": "21.00", "deduction": "125640.00", "shares": {"IRPJ": "4.00", "CSLL": "3.50", "COFINS": "12.82", "PIS": "2.78", "CPP": "43.40", "ISS": "33.50"}}, {"n": 6, "upTo": "4800000.00", "rate": "33.00", "deduction": "648000.00", "shares": {"IRPJ": "35.00", "CSLL": "15.00", "COFINS": "16.03", "PIS": "3.47", "CPP": "30.50"}}], "localCap": {"rate": "5.00", "transfer": {"IRPJ": "6.02", "CSLL": "5.26", "COFINS": "19.28", "PIS": "4.18", "CPP": "65.26"}}}',
 'LC 123/2006, art. 18 e Anexo III (LC 155/2016); Res. CGSN 140/2018, arts. 21 a 25', 'Transcrito da LC 123/2006 (redação da LC 155/2016); conferir com o texto oficial antes de aprovar.', '2018-01-01'),
('ANEXO_IV', 1, 'Anexo IV — Serviços (art. 18, § 5º-C: limpeza, vigilância, obras, advocacia...)', '{"kind": "ANEXO", "annex": "IV", "localTax": "ISS", "brackets": [{"n": 1, "upTo": "180000.00", "rate": "4.50", "deduction": "0.00", "shares": {"IRPJ": "18.80", "CSLL": "15.20", "COFINS": "17.67", "PIS": "3.83", "ISS": "44.50"}}, {"n": 2, "upTo": "360000.00", "rate": "9.00", "deduction": "8100.00", "shares": {"IRPJ": "19.80", "CSLL": "15.20", "COFINS": "20.55", "PIS": "4.45", "ISS": "40.00"}}, {"n": 3, "upTo": "720000.00", "rate": "10.20", "deduction": "12420.00", "shares": {"IRPJ": "20.80", "CSLL": "15.20", "COFINS": "19.73", "PIS": "4.27", "ISS": "40.00"}}, {"n": 4, "upTo": "1800000.00", "rate": "14.00", "deduction": "39780.00", "shares": {"IRPJ": "17.80", "CSLL": "19.20", "COFINS": "18.90", "PIS": "4.10", "ISS": "40.00"}}, {"n": 5, "upTo": "3600000.00", "rate": "22.00", "deduction": "183780.00", "shares": {"IRPJ": "18.80", "CSLL": "19.20", "COFINS": "18.08", "PIS": "3.92", "ISS": "40.00"}}, {"n": 6, "upTo": "4800000.00", "rate": "33.00", "deduction": "828000.00", "shares": {"IRPJ": "53.50", "CSLL": "21.50", "COFINS": "20.55", "PIS": "4.45"}}], "localCap": {"rate": "5.00", "transfer": {"IRPJ": "31.33", "CSLL": "32.00", "COFINS": "30.13", "PIS": "6.54"}}}',
 'LC 123/2006, art. 18 e Anexo IV (LC 155/2016); Res. CGSN 140/2018, arts. 21 a 25', 'Conferido centavo a centavo contra 11 PGDAS-D reais (faixas 1 a 6, teto do ISS e parcela acima do sublimite).', '2018-01-01'),
('ANEXO_V', 1, 'Anexo V — Serviços (art. 18, § 5º-I)', '{"kind": "ANEXO", "annex": "V", "localTax": "ISS", "brackets": [{"n": 1, "upTo": "180000.00", "rate": "15.50", "deduction": "0.00", "shares": {"IRPJ": "25.00", "CSLL": "15.00", "COFINS": "14.10", "PIS": "3.05", "CPP": "28.85", "ISS": "14.00"}}, {"n": 2, "upTo": "360000.00", "rate": "18.00", "deduction": "4500.00", "shares": {"IRPJ": "23.00", "CSLL": "15.00", "COFINS": "14.10", "PIS": "3.05", "CPP": "27.85", "ISS": "17.00"}}, {"n": 3, "upTo": "720000.00", "rate": "19.50", "deduction": "9900.00", "shares": {"IRPJ": "24.00", "CSLL": "15.00", "COFINS": "14.92", "PIS": "3.23", "CPP": "23.85", "ISS": "19.00"}}, {"n": 4, "upTo": "1800000.00", "rate": "20.50", "deduction": "17100.00", "shares": {"IRPJ": "21.00", "CSLL": "15.00", "COFINS": "15.74", "PIS": "3.41", "CPP": "23.85", "ISS": "21.00"}}, {"n": 5, "upTo": "3600000.00", "rate": "23.00", "deduction": "62100.00", "shares": {"IRPJ": "23.00", "CSLL": "12.50", "COFINS": "14.10", "PIS": "3.05", "CPP": "23.85", "ISS": "23.50"}}, {"n": 6, "upTo": "4800000.00", "rate": "30.50", "deduction": "540000.00", "shares": {"IRPJ": "35.00", "CSLL": "15.50", "COFINS": "16.44", "PIS": "3.56", "CPP": "29.50"}}]}',
 'LC 123/2006, art. 18 e Anexo V (LC 155/2016); Res. CGSN 140/2018, arts. 21 a 25', 'Transcrito da LC 123/2006 (redação da LC 155/2016); conferir com o texto oficial antes de aprovar.', '2018-01-01'),
('PARAMETROS', 1, 'Limite, sublimite e tolerância de excesso', '{"kind": "PARAMETROS", "limit": "4800000.00", "sublimit": "3600000.00", "excessTolerance": "20.00"}',
 'LC 123/2006, art. 3º, II, art. 3º, § 9º-A, art. 19 e art. 20 (LC 155/2016)', 'Limite R$ 4,8 milhões; sublimite de ICMS/ISS R$ 3,6 milhões; excesso de até 20% no ano mantém o regime até o fim do ano. Proporcionais no ano de início.', '2018-01-01');
