-- 0050 — Simples Nacional: fator r e impedimento de ICMS/ISS no DAS.
--
-- Folha de salários (com encargos) por mês, base do fator r (LC 123/2006, art. 18,
-- §§ 5º-J, 5º-M e 24; Res. CGSN 140/2018, art. 26):
--   pgdas_declared_payroll  lida do PDF da declaração (seção 2.3, "Folha de Salários Anteriores")
--   payroll_informed        informada por pessoa (meses ainda não declarados), insert-only:
--                           vale a linha mais recente de cada mês
--
-- PARAMETROS v2: acrescenta o fator r (limite de 28% e os casos sem folha ou sem
-- receita). Entra como PROPOSTA; a v1 continua valendo até a aprovação.

CREATE TABLE pgdas_declared_payroll (
  id                  uuid NOT NULL PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  entity_id           uuid NOT NULL,
  -- mês da folha
  competence          date NOT NULL CHECK (extract(day FROM competence) = 1),
  -- PA da declaração de onde o valor saiu
  declared_in         date NOT NULL CHECK (extract(day FROM declared_in) = 1),
  pdf_id              uuid NOT NULL REFERENCES pgdas_declaration_pdf (id),
  source              text NOT NULL CHECK (source IN ('ANTERIOR', 'PA')),
  total               numeric(15,2) NOT NULL CHECK (total >= 0),
  parser              text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, pdf_id, competence, parser),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX pgdas_declared_payroll_ix ON pgdas_declared_payroll (tenant_id, entity_id, competence, declared_in DESC);
SELECT apply_tenant_rls('pgdas_declared_payroll');

CREATE TABLE payroll_informed (
  id           uuid NOT NULL PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  entity_id    uuid NOT NULL,
  competence   date NOT NULL CHECK (extract(day FROM competence) = 1),
  total        numeric(15,2) NOT NULL CHECK (total >= 0),
  reason       text NOT NULL CHECK (length(trim(reason)) > 0),
  informed_by  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX payroll_informed_ix ON payroll_informed (tenant_id, entity_id, competence, created_at DESC);
SELECT apply_tenant_rls('payroll_informed');

GRANT SELECT, INSERT ON pgdas_declared_payroll, payroll_informed TO legacy_app;

-- Impedimento declarado por atividade já é lido (pgdas_declared_tax.local_impeded).

INSERT INTO simples_rule (code, version, name, definition, legal_basis, notes, valid_from) VALUES
('PARAMETROS', 2, 'Limite, sublimite, tolerância de excesso e fator r',
 '{"kind": "PARAMETROS", "limit": "4800000.00", "sublimit": "3600000.00", "excessTolerance": "20.00", "factorR": {"threshold": "28.00", "withoutPayroll": "1.00", "withoutRevenue": "28.00"}}',
 'LC 123/2006, art. 3º, II, § 9º-A, arts. 19 e 20; art. 18, §§ 5º-J, 5º-M e 24 (fator r); Res. CGSN 140/2018, arts. 12, 24, 25, § 1º, V, e 26',
 'Fator r = folha de salários dos 12 meses anteriores ao PA (com encargos: pró-labore, CPP e FGTS) ÷ RBT12. r ≥ 28% → Anexo III; abaixo → Anexo V. Sem folha: r = 1% (Anexo V). Com folha e sem receita: r = 28% (Anexo III). No 1º mês de atividade: folha do PA ÷ receita do PA. Casos sem folha/sem receita conforme o manual do PGDAS-D: conferir antes de aprovar.',
 '2018-01-01');

UPDATE simples_rule SET superseded_at = clock_timestamp() WHERE code = 'PARAMETROS' AND version = 1;
