-- 0021 — Orquestrador: vínculos entre agentes por evento.
--
-- Cada vínculo ("quando acontecer X, o agente Y faz Z") é um consumidor do
-- outbox. O inbox (0004) garante que cada evento é tratado uma vez por vínculo;
-- agent_reaction guarda cada execução (só INSERT): o que disparou, quem fez,
-- resultado ou erro. Erro é refeito até 3 vezes; depois vira item da Fila humana.

CREATE TABLE agent_reaction (
  id           uuid NOT NULL PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  link_id      text NOT NULL,
  agent        text NOT NULL,
  event_id     uuid NOT NULL,
  event_type   text NOT NULL,
  events       int  NOT NULL CHECK (events > 0),
  entity_id    uuid,
  status       text NOT NULL CHECK (status IN ('OK', 'ERRO')),
  result       jsonb NOT NULL DEFAULT '{}',
  error        text,
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_reaction_ix ON agent_reaction (tenant_id, link_id, finished_at DESC);
CREATE INDEX agent_reaction_event_ix ON agent_reaction (tenant_id, link_id, event_id);
SELECT apply_tenant_rls('agent_reaction');
GRANT SELECT, INSERT ON agent_reaction TO legacy_app;
