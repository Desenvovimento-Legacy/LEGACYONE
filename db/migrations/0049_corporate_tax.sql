-- 0049 — Tributos do lucro: Lucro Presumido e Lucro Real (IRPJ, CSLL, PIS e COFINS).
--
-- Regras versionadas como no Simples: entram como PROPOSTA e só valem para o
-- escritório depois da aprovação do responsável técnico. Mudança de lei vira
-- nova versão (a anterior fica no histórico com valid_to/superseded_at).
--
-- Por empresa (temporal ou insert-only):
--   entity_presumption   grupo de presunção de cada fonte de receita (NFS-e, NF-e)
--   corporate_tax_option forma de apuração do ano (trimestral/estimativa, quotas, competência/caixa)
--   lalur_entry          e-LALUR/e-LACS Parte A: adições e exclusões (pessoa, com fundamento)
--   lalur_opening        Parte B: prejuízo fiscal e base negativa herdados
--   pis_cofins_credit_entry  bases de crédito não cumulativo fora das NF-e (energia, aluguel...)
--   corporate_tax_calc   resultado do motor (insert-only, fotografia por impressão digital)

CREATE TABLE corporate_tax_rule (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL CHECK (code IN ('PRESUNCAO', 'PRESUNCAO_LC224', 'IRPJ_CSLL', 'PIS_COFINS_CUMULATIVO', 'PIS_COFINS_NAO_CUMULATIVO',
                                               'COMPENSACAO_PREJUIZO', 'PAGAMENTO', 'DARF_CODIGOS')),
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
GRANT SELECT ON corporate_tax_rule TO legacy_app;

CREATE TABLE corporate_tax_rule_approval (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  rule_id      uuid NOT NULL REFERENCES corporate_tax_rule (id),
  approved_by  text NOT NULL,
  approved_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, rule_id)
);
SELECT apply_tenant_rls('corporate_tax_rule_approval');
GRANT SELECT, INSERT ON corporate_tax_rule_approval TO legacy_app;

-- Grupo de presunção por fonte de receita: NFSE (serviços prestados), NFE (vendas), OUTRAS.
CREATE TABLE entity_presumption (
  id           uuid NOT NULL PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  entity_id    uuid NOT NULL,
  scope        text NOT NULL CHECK (scope IN ('NFSE', 'NFE')),
  grp          text NOT NULL,
  valid_from   date NOT NULL,
  valid_to     date CHECK (valid_to IS NULL OR valid_to >= valid_from),
  reason       text NOT NULL,
  set_by       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id),
  EXCLUDE USING gist (tenant_id WITH =, entity_id WITH =, scope WITH =, daterange(valid_from, valid_to, '[]') WITH &&)
);
SELECT apply_tenant_rls('entity_presumption');
GRANT SELECT, INSERT ON entity_presumption TO legacy_app;
GRANT UPDATE (valid_to) ON entity_presumption TO legacy_app;

-- Opção do ano-calendário (a última linha do ano vale; insert-only).
CREATE TABLE corporate_tax_option (
  id            uuid NOT NULL PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  entity_id     uuid NOT NULL,
  year          int  NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  -- Lucro Real anual: estimativa mensal pela receita bruta
  real_annual_basis text CHECK (real_annual_basis IN ('RECEITA_BRUTA')),
  quotas        text NOT NULL CHECK (quotas IN ('UNICA', 'TRES')),
  revenue_basis text NOT NULL CHECK (revenue_basis IN ('COMPETENCIA', 'CAIXA')),
  set_by        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX corporate_tax_option_ix ON corporate_tax_option (tenant_id, entity_id, year, created_at DESC);
SELECT apply_tenant_rls('corporate_tax_option');
GRANT SELECT, INSERT ON corporate_tax_option TO legacy_app;

-- e-LALUR / e-LACS Parte A. Cancelar = nova linha com cancels_id (nada é apagado).
CREATE TABLE lalur_entry (
  id            uuid NOT NULL PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  entity_id     uuid NOT NULL,
  period_start  date NOT NULL CHECK (extract(day FROM period_start) = 1),
  period_end    date NOT NULL CHECK (period_end >= period_start),
  tax           text NOT NULL CHECK (tax IN ('IRPJ', 'CSLL', 'AMBOS')),
  kind          text NOT NULL CHECK (kind IN ('ADICAO', 'EXCLUSAO')),
  description   text NOT NULL CHECK (length(trim(description)) >= 3),
  amount        numeric(15,2) NOT NULL CHECK (amount > 0),
  legal_basis   text NOT NULL CHECK (length(trim(legal_basis)) >= 3),
  -- diferença temporária controlada na Parte B (ex.: provisão para contingências)
  part_b        text,
  account_code  text,
  cancels_id    uuid,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX lalur_entry_ix ON lalur_entry (tenant_id, entity_id, period_start);
SELECT apply_tenant_rls('lalur_entry');
GRANT SELECT, INSERT ON lalur_entry TO legacy_app;

-- Parte B: saldos herdados (ECF anterior). Cancelar = nova linha com cancels_id.
CREATE TABLE lalur_opening (
  id            uuid NOT NULL PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  entity_id     uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('PREJUIZO_FISCAL', 'BASE_NEGATIVA_CSLL')),
  amount        numeric(15,2) NOT NULL CHECK (amount > 0),
  as_of         date NOT NULL,
  evidence      text NOT NULL CHECK (length(trim(evidence)) >= 3),
  cancels_id    uuid,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
SELECT apply_tenant_rls('lalur_opening');
GRANT SELECT, INSERT ON lalur_opening TO legacy_app;

-- Bases de crédito do PIS/COFINS não cumulativo fora das NF-e de compra (Lei 10.637/2002 e 10.833/2003, art. 3º).
CREATE TABLE pis_cofins_credit_entry (
  id            uuid NOT NULL PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  entity_id     uuid NOT NULL,
  competence    date NOT NULL CHECK (extract(day FROM competence) = 1),
  kind          text NOT NULL CHECK (kind IN ('SERVICO_INSUMO', 'ENERGIA', 'ALUGUEL_PJ', 'ARRENDAMENTO', 'DEPRECIACAO', 'FRETE_VENDA', 'ARMAZENAGEM', 'DEVOLUCAO_VENDA', 'OUTRO')),
  base          numeric(15,2) NOT NULL CHECK (base > 0),
  description   text NOT NULL CHECK (length(trim(description)) >= 3),
  legal_basis   text NOT NULL CHECK (length(trim(legal_basis)) >= 3),
  cancels_id    uuid,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX pis_cofins_credit_entry_ix ON pis_cofins_credit_entry (tenant_id, entity_id, competence);
SELECT apply_tenant_rls('pis_cofins_credit_entry');
GRANT SELECT, INSERT ON pis_cofins_credit_entry TO legacy_app;

-- Resultado do motor por período e tributo. Só INSERT.
CREATE TABLE corporate_tax_calc (
  id             uuid NOT NULL PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  entity_id      uuid NOT NULL,
  regime         text NOT NULL CHECK (regime IN ('LUCRO_PRESUMIDO', 'LUCRO_REAL_TRIMESTRAL', 'LUCRO_REAL_ANUAL')),
  period_kind    text NOT NULL CHECK (period_kind IN ('MENSAL', 'TRIMESTRAL', 'ANUAL')),
  period_start   date NOT NULL CHECK (extract(day FROM period_start) = 1),
  period_end     date NOT NULL,
  tax            text NOT NULL CHECK (tax IN ('IRPJ', 'CSLL', 'PIS', 'COFINS')),
  status         text NOT NULL CHECK (status IN ('CALCULADO', 'BLOQUEADO', 'REGRA_PENDENTE')),
  base           numeric(15,2),
  gross          numeric(15,2),
  deductions     numeric(15,2),
  amount         numeric(15,2),
  darf_code      text,
  due_on         date,
  quotas         jsonb NOT NULL DEFAULT '[]',
  details        jsonb NOT NULL,
  blockers       jsonb NOT NULL DEFAULT '[]',
  rule_refs      text[] NOT NULL DEFAULT '{}',
  engine_version text NOT NULL,
  fingerprint    text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX corporate_tax_calc_ix ON corporate_tax_calc (tenant_id, entity_id, period_start, tax, created_at DESC);
SELECT apply_tenant_rls('corporate_tax_calc');
GRANT SELECT, INSERT ON corporate_tax_calc TO legacy_app;

-- ------------------------------------------------------------------ regras propostas
INSERT INTO corporate_tax_rule (code, version, name, definition, legal_basis, notes, valid_from) VALUES
('PRESUNCAO', 1, 'Percentuais de presunção do IRPJ e da CSLL por atividade',
 '{"groups": {
    "COMERCIO_INDUSTRIA":        {"label": "Venda de mercadorias e produtos (comércio e indústria)", "irpj": "8.00",  "csll": "12.00"},
    "COMBUSTIVEIS":              {"label": "Revenda de combustíveis derivados de petróleo, álcool e gás natural", "irpj": "1.60", "csll": "12.00"},
    "TRANSPORTE_CARGA":          {"label": "Transporte de cargas", "irpj": "8.00", "csll": "12.00"},
    "TRANSPORTE_PASSAGEIROS":    {"label": "Transporte de passageiros", "irpj": "16.00", "csll": "12.00"},
    "HOSPITALAR":                {"label": "Serviços hospitalares e de saúde do art. 15, § 1º, III, a (sociedade empresária, normas da Anvisa)", "irpj": "8.00", "csll": "12.00"},
    "CONSTRUCAO_COM_MATERIAIS":  {"label": "Construção por empreitada com fornecimento de todos os materiais", "irpj": "8.00", "csll": "12.00"},
    "ATIVIDADE_IMOBILIARIA":     {"label": "Venda de imóveis (loteamento, incorporação, construção para venda)", "irpj": "8.00", "csll": "12.00"},
    "SERVICOS_GERAIS":           {"label": "Prestação de serviços em geral (inclui licenciamento de software, intermediação, administração e locação)", "irpj": "32.00", "csll": "32.00"},
    "CONSTRUCAO_SEM_MATERIAIS":  {"label": "Construção sem fornecimento de materiais (mão de obra)", "irpj": "32.00", "csll": "32.00"}
  }}',
 'Lei 9.249/1995, arts. 15 e 20; Lei 9.430/1996, art. 25; IN RFB 1.700/2017, arts. 33 e 34',
 'Atividades diversificadas: cada receita com o seu percentual (art. 15, § 2º). Prestadora exclusiva de serviços com receita anual até R$ 120.000,00 (art. 15, § 4º, 16%) ainda não entra: a IARIS aplica 32%.', '1996-01-01'),
('PRESUNCAO_LC224', 1, 'Acréscimo de 10% nos percentuais de presunção sobre a receita acima de R$ 5 milhões',
 '{"increase": "10.00", "annualLimit": "5000000.00", "quarterLimit": "1250000.00", "irpjFrom": "2026-01-01", "csllFrom": "2026-04-01", "appliesToEstimate": false}',
 'LC 224/2025, art. 4º, § 4º, VII e § 5º; IN RFB 2.306/2026',
 'Percentual × 1,10 só sobre a receita do trimestre acima de R$ 1.250.000,00; o limite não usado passa para os trimestres seguintes do mesmo ano; em início ou fim de atividade, limite proporcional aos trimestres. CSLL a partir de 01/04/2026 (anterioridade nonagesimal). Empresa com decisão judicial afastando a majoração: registrar exceção. O ajuste do 4º trimestre (IN 2.306, art. 15, § 5º) aparece como alerta para conferência.', '2026-01-01'),
('IRPJ_CSLL', 1, 'Alíquotas do IRPJ (com adicional) e da CSLL',
 '{"irpj": "15.00", "additional": "10.00", "additionalMonthly": "20000.00", "csll": "9.00"}',
 'Lei 9.249/1995, art. 3º; Lei 9.430/1996, arts. 2º, 4º e 25; Lei 7.689/1988, art. 3º, III',
 'Adicional de 10% sobre a parcela do lucro que exceder R$ 20.000,00 por mês do período (R$ 60.000,00 no trimestre).', '1996-01-01'),
('PIS_COFINS_CUMULATIVO', 1, 'PIS e COFINS no regime cumulativo (Lucro Presumido)',
 '{"pis": "0.65", "cofins": "3.00", "excludeIcms": true, "monophasicZero": true}',
 'Lei 9.715/1998, art. 8º, I; Lei 9.718/1998, arts. 2º, 3º e 8º; Lei 10.833/2003, art. 10; STF RE 574.706 (Tema 69)',
 'Base: receita bruta (faturamento). Excluídas vendas canceladas, descontos incondicionais, IPI, ICMS-ST e o ICMS destacado (Tema 69). Receita financeira fora da base. Revenda de produto monofásico com alíquota zero.', '2017-03-15'),
('PIS_COFINS_NAO_CUMULATIVO', 1, 'PIS e COFINS no regime não cumulativo (Lucro Real)',
 '{"pis": "1.65", "cofins": "7.60", "financialPis": "0.65", "financialCofins": "4.00", "excludeIcms": true, "monophasicZero": true}',
 'Lei 10.637/2002, arts. 1º a 3º; Lei 10.833/2003, arts. 1º a 3º; Decreto 8.426/2015 (receitas financeiras); STF RE 574.706 (Tema 69)',
 'Créditos: NF-e de compra com crédito apropriável e as bases lançadas por pessoa (energia, aluguel PJ, depreciação, serviços-insumo...). Saldo credor passa para o mês seguinte.', '2015-07-01'),
('COMPENSACAO_PREJUIZO', 1, 'Compensação de prejuízo fiscal e base negativa (trava de 30%)',
 '{"limit": "30.00"}',
 'Lei 9.065/1995, arts. 15 e 16; Lei 8.981/1995, arts. 42 e 58',
 'Compensação limitada a 30% do lucro real (ou base da CSLL) ajustado do período.', '1995-01-01'),
('PAGAMENTO', 1, 'Vencimentos e quotas',
 '{"pisCofinsDay": 25, "pisCofinsAdjust": "PREVIOUS_BUSINESS_DAY", "irpjCsll": "LAST_BUSINESS_DAY_NEXT_MONTH", "minQuota": "1000.00", "singleBelow": "2000.00", "maxQuotas": 3}',
 'Lei 9.430/1996, arts. 5º e 6º; MP 2.158-35/2001, art. 18 (red. Lei 11.933/2009)',
 'PIS/COFINS até o dia 25 do mês seguinte (antecipa se não for dia útil). IRPJ/CSLL trimestral: quota única no último dia útil do mês seguinte ao trimestre ou 3 quotas mensais (nenhuma abaixo de R$ 1.000,00; imposto abaixo de R$ 2.000,00 só em quota única); 2ª e 3ª quotas com juros Selic (calculados na emissão). Estimativa mensal: último dia útil do mês seguinte.', '2009-01-01'),
('DARF_CODIGOS', 1, 'Códigos de receita do DARF',
 '{"LUCRO_PRESUMIDO": {"IRPJ": "2089", "CSLL": "2372", "PIS": "8109", "COFINS": "2172"},
   "LUCRO_REAL_TRIMESTRAL": {"IRPJ": "3373", "CSLL": "6012", "PIS": "6912", "COFINS": "5856"},
   "LUCRO_REAL_ANUAL": {"IRPJ": "5993", "CSLL": "2484", "PIS": "6912", "COFINS": "5856", "IRPJ_AJUSTE": "2456", "CSLL_AJUSTE": "6773"}}',
 'Tabela de códigos de receita da RFB (Sicalc)',
 'Lucro Real: códigos das PJ não obrigadas ao Lucro Real (3373 trimestral, 5993 estimativa, 2456 ajuste). PJ obrigada (art. 14 da Lei 9.718/1998) usa 0220, 2362 e 2430: conferir antes de aprovar.', '2000-01-01');
