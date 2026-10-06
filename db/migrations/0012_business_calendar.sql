-- 0012 — Calendário de dias úteis e ajuste de vencimento em dia não útil.
--
-- calendar_day_off é base da plataforma (sem tenant), por jurisdição ('BR' =
-- nacional; municípios entram depois como 'BR-<IBGE>').
--   FERIADO_NACIONAL: feriado por lei federal.
--   SEM_EXPEDIENTE_BANCARIO: sem expediente bancário no calendário nacional
--     (Carnaval, Sexta-feira da Paixão, Corpus Christi).
--
-- Regra conservadora (na dúvida, a data mais cedo):
--   prazo que ANTECIPA pula fim de semana e os dois tipos;
--   prazo que PRORROGA pula só fim de semana e feriado nacional.
--
-- As regras de obrigação ganham "adjust" no prazo (versão 2). A versão 1
-- fica no catálogo como substituída (superseded_at) e continua valendo para o
-- escritório até o responsável técnico aprovar a versão 2.

CREATE TABLE calendar_day_off (
  jurisdiction  text NOT NULL,
  day           date NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('FERIADO_NACIONAL', 'SEM_EXPEDIENTE_BANCARIO')),
  name          text NOT NULL,
  legal_basis   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (jurisdiction, day)
);
GRANT SELECT ON calendar_day_off TO legacy_app;

INSERT INTO calendar_day_off (jurisdiction, day, kind, name, legal_basis) VALUES
('BR', '2024-01-01', 'FERIADO_NACIONAL', 'Confraternização Universal', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2024-02-12', 'SEM_EXPEDIENTE_BANCARIO', 'Carnaval (segunda-feira)', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2024-02-13', 'SEM_EXPEDIENTE_BANCARIO', 'Carnaval (terça-feira)', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2024-03-29', 'SEM_EXPEDIENTE_BANCARIO', 'Sexta-feira da Paixão', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2024-04-21', 'FERIADO_NACIONAL', 'Tiradentes', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2024-05-01', 'FERIADO_NACIONAL', 'Dia do Trabalho', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2024-05-30', 'SEM_EXPEDIENTE_BANCARIO', 'Corpus Christi', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2024-09-07', 'FERIADO_NACIONAL', 'Independência do Brasil', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2024-10-12', 'FERIADO_NACIONAL', 'Nossa Senhora Aparecida', 'Lei 6.802/1980'),
('BR', '2024-11-02', 'FERIADO_NACIONAL', 'Finados', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2024-11-15', 'FERIADO_NACIONAL', 'Proclamação da República', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2024-11-20', 'FERIADO_NACIONAL', 'Dia Nacional de Zumbi e da Consciência Negra', 'Lei 14.759/2023'),
('BR', '2024-12-25', 'FERIADO_NACIONAL', 'Natal', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2025-01-01', 'FERIADO_NACIONAL', 'Confraternização Universal', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2025-03-03', 'SEM_EXPEDIENTE_BANCARIO', 'Carnaval (segunda-feira)', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2025-03-04', 'SEM_EXPEDIENTE_BANCARIO', 'Carnaval (terça-feira)', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2025-04-18', 'SEM_EXPEDIENTE_BANCARIO', 'Sexta-feira da Paixão', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2025-04-21', 'FERIADO_NACIONAL', 'Tiradentes', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2025-05-01', 'FERIADO_NACIONAL', 'Dia do Trabalho', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2025-06-19', 'SEM_EXPEDIENTE_BANCARIO', 'Corpus Christi', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2025-09-07', 'FERIADO_NACIONAL', 'Independência do Brasil', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2025-10-12', 'FERIADO_NACIONAL', 'Nossa Senhora Aparecida', 'Lei 6.802/1980'),
('BR', '2025-11-02', 'FERIADO_NACIONAL', 'Finados', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2025-11-15', 'FERIADO_NACIONAL', 'Proclamação da República', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2025-11-20', 'FERIADO_NACIONAL', 'Dia Nacional de Zumbi e da Consciência Negra', 'Lei 14.759/2023'),
('BR', '2025-12-25', 'FERIADO_NACIONAL', 'Natal', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2026-01-01', 'FERIADO_NACIONAL', 'Confraternização Universal', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2026-02-16', 'SEM_EXPEDIENTE_BANCARIO', 'Carnaval (segunda-feira)', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2026-02-17', 'SEM_EXPEDIENTE_BANCARIO', 'Carnaval (terça-feira)', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2026-04-03', 'SEM_EXPEDIENTE_BANCARIO', 'Sexta-feira da Paixão', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2026-04-21', 'FERIADO_NACIONAL', 'Tiradentes', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2026-05-01', 'FERIADO_NACIONAL', 'Dia do Trabalho', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2026-06-04', 'SEM_EXPEDIENTE_BANCARIO', 'Corpus Christi', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2026-09-07', 'FERIADO_NACIONAL', 'Independência do Brasil', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2026-10-12', 'FERIADO_NACIONAL', 'Nossa Senhora Aparecida', 'Lei 6.802/1980'),
('BR', '2026-11-02', 'FERIADO_NACIONAL', 'Finados', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2026-11-15', 'FERIADO_NACIONAL', 'Proclamação da República', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2026-11-20', 'FERIADO_NACIONAL', 'Dia Nacional de Zumbi e da Consciência Negra', 'Lei 14.759/2023'),
('BR', '2026-12-25', 'FERIADO_NACIONAL', 'Natal', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2027-01-01', 'FERIADO_NACIONAL', 'Confraternização Universal', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2027-02-08', 'SEM_EXPEDIENTE_BANCARIO', 'Carnaval (segunda-feira)', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2027-02-09', 'SEM_EXPEDIENTE_BANCARIO', 'Carnaval (terça-feira)', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2027-03-26', 'SEM_EXPEDIENTE_BANCARIO', 'Sexta-feira da Paixão', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2027-04-21', 'FERIADO_NACIONAL', 'Tiradentes', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2027-05-01', 'FERIADO_NACIONAL', 'Dia do Trabalho', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2027-05-27', 'SEM_EXPEDIENTE_BANCARIO', 'Corpus Christi', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2027-09-07', 'FERIADO_NACIONAL', 'Independência do Brasil', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2027-10-12', 'FERIADO_NACIONAL', 'Nossa Senhora Aparecida', 'Lei 6.802/1980'),
('BR', '2027-11-02', 'FERIADO_NACIONAL', 'Finados', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2027-11-15', 'FERIADO_NACIONAL', 'Proclamação da República', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2027-11-20', 'FERIADO_NACIONAL', 'Dia Nacional de Zumbi e da Consciência Negra', 'Lei 14.759/2023'),
('BR', '2027-12-25', 'FERIADO_NACIONAL', 'Natal', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2028-01-01', 'FERIADO_NACIONAL', 'Confraternização Universal', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2028-02-28', 'SEM_EXPEDIENTE_BANCARIO', 'Carnaval (segunda-feira)', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2028-02-29', 'SEM_EXPEDIENTE_BANCARIO', 'Carnaval (terça-feira)', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2028-04-14', 'SEM_EXPEDIENTE_BANCARIO', 'Sexta-feira da Paixão', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2028-04-21', 'FERIADO_NACIONAL', 'Tiradentes', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2028-05-01', 'FERIADO_NACIONAL', 'Dia do Trabalho', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2028-06-15', 'SEM_EXPEDIENTE_BANCARIO', 'Corpus Christi', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2028-09-07', 'FERIADO_NACIONAL', 'Independência do Brasil', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2028-10-12', 'FERIADO_NACIONAL', 'Nossa Senhora Aparecida', 'Lei 6.802/1980'),
('BR', '2028-11-02', 'FERIADO_NACIONAL', 'Finados', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2028-11-15', 'FERIADO_NACIONAL', 'Proclamação da República', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2028-11-20', 'FERIADO_NACIONAL', 'Dia Nacional de Zumbi e da Consciência Negra', 'Lei 14.759/2023'),
('BR', '2028-12-25', 'FERIADO_NACIONAL', 'Natal', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2029-01-01', 'FERIADO_NACIONAL', 'Confraternização Universal', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2029-02-12', 'SEM_EXPEDIENTE_BANCARIO', 'Carnaval (segunda-feira)', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2029-02-13', 'SEM_EXPEDIENTE_BANCARIO', 'Carnaval (terça-feira)', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2029-03-30', 'SEM_EXPEDIENTE_BANCARIO', 'Sexta-feira da Paixão', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2029-04-21', 'FERIADO_NACIONAL', 'Tiradentes', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2029-05-01', 'FERIADO_NACIONAL', 'Dia do Trabalho', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2029-05-31', 'SEM_EXPEDIENTE_BANCARIO', 'Corpus Christi', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2029-09-07', 'FERIADO_NACIONAL', 'Independência do Brasil', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2029-10-12', 'FERIADO_NACIONAL', 'Nossa Senhora Aparecida', 'Lei 6.802/1980'),
('BR', '2029-11-02', 'FERIADO_NACIONAL', 'Finados', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2029-11-15', 'FERIADO_NACIONAL', 'Proclamação da República', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2029-11-20', 'FERIADO_NACIONAL', 'Dia Nacional de Zumbi e da Consciência Negra', 'Lei 14.759/2023'),
('BR', '2029-12-25', 'FERIADO_NACIONAL', 'Natal', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2030-01-01', 'FERIADO_NACIONAL', 'Confraternização Universal', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2030-03-04', 'SEM_EXPEDIENTE_BANCARIO', 'Carnaval (segunda-feira)', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2030-03-05', 'SEM_EXPEDIENTE_BANCARIO', 'Carnaval (terça-feira)', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2030-04-19', 'SEM_EXPEDIENTE_BANCARIO', 'Sexta-feira da Paixão', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2030-04-21', 'FERIADO_NACIONAL', 'Tiradentes', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2030-05-01', 'FERIADO_NACIONAL', 'Dia do Trabalho', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2030-06-20', 'SEM_EXPEDIENTE_BANCARIO', 'Corpus Christi', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2030-09-07', 'FERIADO_NACIONAL', 'Independência do Brasil', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2030-10-12', 'FERIADO_NACIONAL', 'Nossa Senhora Aparecida', 'Lei 6.802/1980'),
('BR', '2030-11-02', 'FERIADO_NACIONAL', 'Finados', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2030-11-15', 'FERIADO_NACIONAL', 'Proclamação da República', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2030-11-20', 'FERIADO_NACIONAL', 'Dia Nacional de Zumbi e da Consciência Negra', 'Lei 14.759/2023'),
('BR', '2030-12-25', 'FERIADO_NACIONAL', 'Natal', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2031-01-01', 'FERIADO_NACIONAL', 'Confraternização Universal', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2031-02-24', 'SEM_EXPEDIENTE_BANCARIO', 'Carnaval (segunda-feira)', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2031-02-25', 'SEM_EXPEDIENTE_BANCARIO', 'Carnaval (terça-feira)', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2031-04-11', 'SEM_EXPEDIENTE_BANCARIO', 'Sexta-feira da Paixão', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2031-04-21', 'FERIADO_NACIONAL', 'Tiradentes', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2031-05-01', 'FERIADO_NACIONAL', 'Dia do Trabalho', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2031-06-12', 'SEM_EXPEDIENTE_BANCARIO', 'Corpus Christi', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2031-09-07', 'FERIADO_NACIONAL', 'Independência do Brasil', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2031-10-12', 'FERIADO_NACIONAL', 'Nossa Senhora Aparecida', 'Lei 6.802/1980'),
('BR', '2031-11-02', 'FERIADO_NACIONAL', 'Finados', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2031-11-15', 'FERIADO_NACIONAL', 'Proclamação da República', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2031-11-20', 'FERIADO_NACIONAL', 'Dia Nacional de Zumbi e da Consciência Negra', 'Lei 14.759/2023'),
('BR', '2031-12-25', 'FERIADO_NACIONAL', 'Natal', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2032-01-01', 'FERIADO_NACIONAL', 'Confraternização Universal', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2032-02-09', 'SEM_EXPEDIENTE_BANCARIO', 'Carnaval (segunda-feira)', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2032-02-10', 'SEM_EXPEDIENTE_BANCARIO', 'Carnaval (terça-feira)', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2032-03-26', 'SEM_EXPEDIENTE_BANCARIO', 'Sexta-feira da Paixão', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2032-04-21', 'FERIADO_NACIONAL', 'Tiradentes', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2032-05-01', 'FERIADO_NACIONAL', 'Dia do Trabalho', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2032-05-27', 'SEM_EXPEDIENTE_BANCARIO', 'Corpus Christi', 'Dia sem expediente bancário no calendário nacional (conferir calendário FEBRABAN do ano)'),
('BR', '2032-09-07', 'FERIADO_NACIONAL', 'Independência do Brasil', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2032-10-12', 'FERIADO_NACIONAL', 'Nossa Senhora Aparecida', 'Lei 6.802/1980'),
('BR', '2032-11-02', 'FERIADO_NACIONAL', 'Finados', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2032-11-15', 'FERIADO_NACIONAL', 'Proclamação da República', 'Lei 662/1949 (redação da Lei 10.607/2002)'),
('BR', '2032-11-20', 'FERIADO_NACIONAL', 'Dia Nacional de Zumbi e da Consciência Negra', 'Lei 14.759/2023'),
('BR', '2032-12-25', 'FERIADO_NACIONAL', 'Natal', 'Lei 662/1949 (redação da Lei 10.607/2002)');

ALTER TABLE obligation_rule ADD COLUMN superseded_at timestamptz;

INSERT INTO obligation_rule (code, version, name, sphere, periodicity, due, conditions, legal_basis, notes, valid_from)
SELECT code, 2, name, sphere, periodicity, v.due::jsonb, conditions, v.legal_basis, v.notes, valid_from
  FROM obligation_rule r
  JOIN (VALUES
    ('PGDAS_D', '{"kind":"next_month_day","day":20,"adjust":"NEXT_BUSINESS_DAY"}',
     'LC 123/2006, art. 21, III; Resolução CGSN 140/2018, arts. 38 e 40',
     'Entrega e pagamento do DAS até o dia 20 do mês seguinte; sem expediente bancário no dia, prorroga para o dia útil seguinte.'),
    ('ESOCIAL_PERIODICOS', '{"kind":"next_month_day","day":15,"adjust":"NEXT_BUSINESS_DAY"}',
     'Decreto 8.373/2014; Manual de Orientação do eSocial (atualização de outubro/2023)',
     'Eventos periódicos até o dia 15 do mês seguinte; em dia não útil, prorroga para o dia útil seguinte (MEI e doméstico: dia 7, antecipando).'),
    ('DCTFWEB', '{"kind":"next_month_day","day":15,"adjust":"NEXT_BUSINESS_DAY"}',
     'IN RFB 2.005/2021, art. 19 (redação da IN RFB 2.162/2023)',
     'Até o dia 15 do mês seguinte; em dia não útil, prorroga para o dia útil seguinte. O DARF continua vencendo no dia 20, antecipando.'),
    ('FGTS_DIGITAL', '{"kind":"next_month_day","day":20,"adjust":"PREVIOUS_BUSINESS_DAY"}',
     'Lei 8.036/1990, art. 15 (redação da Lei 14.438/2022)',
     'Recolhimento até o dia 20; em dia não útil, antecipa para o dia útil anterior. Guia gerada no FGTS Digital a partir do eSocial.')
  ) AS v (code_v, due, legal_basis, notes) ON v.code_v = r.code
 WHERE r.version = 1;

UPDATE obligation_rule SET superseded_at = clock_timestamp()
 WHERE version = 1 AND code IN ('PGDAS_D', 'ESOCIAL_PERIODICOS', 'DCTFWEB', 'FGTS_DIGITAL');

-- DEFIS segue na versão 1, sem ajuste: o prazo é 31/03 mesmo em dia não útil.
