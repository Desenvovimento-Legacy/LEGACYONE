-- 0032 — Rotinas em horários fixos (ex.: busca de notas no início e no fim do dia).
-- Uma linha por rotina e horário cumprido; se o computador estava desligado no
-- horário, a rotina roda assim que o sistema abrir e o horário fica cumprido.

CREATE TABLE scheduled_run (
  id          uuid NOT NULL PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  job         text NOT NULL,
  slot        timestamptz NOT NULL,
  ran_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  trigger     text NOT NULL CHECK (trigger IN ('HORARIO', 'PESSOA')),
  actor_id    text NOT NULL,
  result      jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, job, slot, trigger, ran_at)
);
CREATE INDEX scheduled_run_ix ON scheduled_run (tenant_id, job, slot DESC);
SELECT apply_tenant_rls('scheduled_run');
GRANT SELECT, INSERT ON scheduled_run TO legacy_app;
