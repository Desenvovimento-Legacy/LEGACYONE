-- 0009 — Medição de consultas a integrações externas cobradas por chamada.
--
-- Toda consulta cobrada é registrada ANTES de sair (reserva), na mesma
-- transação que confere o teto diário do escritório. Se a chamada falhar, a
-- reserva fica como está: o registro reflete o que pode ter sido cobrado.
-- Base do KPI "custo por CNPJ".

CREATE TABLE integration_call (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  entity_id    uuid,
  provider     text NOT NULL,
  system       text NOT NULL,
  service      text NOT NULL,
  billed       boolean NOT NULL,
  -- Dia civil de Brasília em que a chamada foi feita (base do teto diário).
  call_day     date NOT NULL,
  actor_kind   text NOT NULL,
  actor_id     text NOT NULL,
  request_ref  jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX integration_call_day_ix ON integration_call (tenant_id, provider, call_day) WHERE billed;
SELECT apply_tenant_rls('integration_call');

GRANT SELECT, INSERT ON integration_call TO legacy_app;
