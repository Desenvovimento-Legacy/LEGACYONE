-- 0019 — Guias (DAS do Simples): situação por competência, observada a partir
-- do que já está no banco (declarações, DAS emitidos, pagamentos, prazo).
--
-- Só INSERT: uma linha nova quando a situação muda. Nunca se afirma
-- inadimplência: sem pagamento depois do prazo, a situação é
-- PAGAMENTO_NAO_IDENTIFICADO ("pagamento ainda não identificado").

CREATE TABLE tax_guide_observation (
  id           uuid NOT NULL PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  entity_id    uuid NOT NULL,
  competence   date NOT NULL CHECK (extract(day FROM competence) = 1),
  guide        text NOT NULL CHECK (guide IN ('DAS_SIMPLES')),
  status       text NOT NULL CHECK (status IN ('A_DECLARAR', 'DECLARACAO_NAO_IDENTIFICADA', 'SEM_DEBITO', 'DECLARADO_SEM_DAS',
                                               'A_VENCER', 'PAGAMENTO_NAO_IDENTIFICADO', 'PAGO', 'PAGO_EM_ATRASO')),
  due_on       date,
  details      jsonb NOT NULL,
  fingerprint  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, entity_id, competence, guide, fingerprint),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX tax_guide_observation_ix ON tax_guide_observation (tenant_id, entity_id, competence, guide, created_at DESC);
SELECT apply_tenant_rls('tax_guide_observation');
GRANT SELECT, INSERT ON tax_guide_observation TO legacy_app;
