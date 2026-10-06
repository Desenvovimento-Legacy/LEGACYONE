-- 0010 — Regulatory Engine (catálogo versionado de obrigações) e mapa de
-- obrigações por empresa.
--
-- obligation_rule é base regulatória da plataforma (sem tenant): cada regra tem
-- versão, vigência, fundamento legal e condições de aplicação. Nenhuma regra é
-- usada por um escritório sem aprovação do seu responsável técnico
-- (obligation_rule_approval): DETECTAR → COMPARAR → TESTAR → APROVAR → VERSÃO.
-- Mudança de regra = nova versão; a anterior fica com valid_to.

CREATE TABLE obligation_rule (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]+$'),
  version      int  NOT NULL CHECK (version > 0),
  name         text NOT NULL,
  sphere       text NOT NULL CHECK (sphere IN ('FEDERAL', 'ESTADUAL', 'MUNICIPAL')),
  periodicity  text NOT NULL CHECK (periodicity IN ('MENSAL', 'ANUAL')),
  -- {"kind":"next_month_day","day":20} | {"kind":"annual","month":3,"day":31} | null (prazo a cadastrar)
  due          jsonb,
  -- {"regimes":[...], "services_any":[...], "requires":["remuneration"|"employees"|"service_activity"]}
  conditions   jsonb NOT NULL,
  legal_basis  text NOT NULL,
  notes        text,
  valid_from   date NOT NULL,
  valid_to     date CHECK (valid_to IS NULL OR valid_to >= valid_from),
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (code, version)
);
GRANT SELECT ON obligation_rule TO legacy_app;

CREATE TABLE obligation_rule_approval (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  rule_id      uuid NOT NULL REFERENCES obligation_rule (id),
  approved_by  text NOT NULL,
  approved_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, rule_id)
);
SELECT apply_tenant_rls('obligation_rule_approval');

-- Mapa de obrigações: quais regras se aplicam a cada empresa, desde quando e por quê.
CREATE TABLE entity_obligation (
  id          uuid NOT NULL PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  entity_id   uuid NOT NULL,
  rule_id     uuid NOT NULL REFERENCES obligation_rule (id),
  rule_code   text NOT NULL,
  valid_from  date NOT NULL,
  valid_to    date CHECK (valid_to IS NULL OR valid_to >= valid_from),
  -- fatos que fizeram a regra se aplicar (regime, serviços, remuneração...)
  reason      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id),
  EXCLUDE USING gist (tenant_id WITH =, entity_id WITH =, rule_code WITH =,
                      daterange(valid_from, valid_to, '[]') WITH &&)
);
SELECT apply_tenant_rls('entity_obligation');

GRANT SELECT, INSERT ON obligation_rule_approval, entity_obligation TO legacy_app;
GRANT UPDATE (valid_to) ON entity_obligation TO legacy_app;

-- Regras iniciais (Simples Nacional, piloto). Entram como propostas: só valem
-- para um escritório depois da aprovação do responsável técnico.
INSERT INTO obligation_rule (code, version, name, sphere, periodicity, due, conditions, legal_basis, notes, valid_from) VALUES
('PGDAS_D', 1, 'PGDAS-D (apuração do Simples Nacional)', 'FEDERAL', 'MENSAL',
 '{"kind":"next_month_day","day":20}',
 '{"regimes":["SIMPLES_NACIONAL"],"services_any":["FISCAL","CONTABIL"]}',
 'LC 123/2006, art. 18 e art. 21; Resolução CGSN 140/2018, art. 38', 'Entrega até o dia 20 do mês seguinte ao período de apuração; o DAS vence na mesma data.', '2018-01-01'),
('DEFIS', 1, 'DEFIS (declaração anual do Simples Nacional)', 'FEDERAL', 'ANUAL',
 '{"kind":"annual","month":3,"day":31}',
 '{"regimes":["SIMPLES_NACIONAL"],"services_any":["FISCAL","CONTABIL"]}',
 'LC 123/2006, art. 25; Resolução CGSN 140/2018, art. 72', 'Até 31 de março do ano seguinte ao ano-calendário.', '2018-01-01'),
('ESOCIAL_PERIODICOS', 1, 'eSocial — eventos periódicos (folha)', 'FEDERAL', 'MENSAL',
 '{"kind":"next_month_day","day":15}',
 '{"services_any":["FOLHA"],"requires":["remuneration"]}',
 'Decreto 8.373/2014; Manual de Orientação do eSocial', 'Eventos de remuneração e fechamento até o dia 15 do mês seguinte.', '2018-01-01'),
('DCTFWEB', 1, 'DCTFWeb (contribuições previdenciárias)', 'FEDERAL', 'MENSAL',
 '{"kind":"next_month_day","day":15}',
 '{"services_any":["FOLHA"],"requires":["remuneration"]}',
 'IN RFB 2.005/2021', 'Conferir o prazo vigente antes de aprovar.', '2021-01-01'),
('FGTS_DIGITAL', 1, 'FGTS Digital (recolhimento mensal)', 'FEDERAL', 'MENSAL',
 '{"kind":"next_month_day","day":20}',
 '{"services_any":["FOLHA"],"requires":["employees"]}',
 'Lei 8.036/1990, art. 15 (redação da Lei 14.438/2022)', 'Guia gerada no FGTS Digital a partir do eSocial.', '2024-03-01'),
('ISS_MUNICIPAL', 1, 'ISS e declaração de serviços (municipal)', 'MUNICIPAL', 'MENSAL',
 NULL,
 '{"services_any":["FISCAL"],"requires":["service_activity"]}',
 'Lei Complementar 116/2003 e legislação do município', 'Prazo e obrigação acessória variam por município: cadastrar por município.', '2018-01-01');
