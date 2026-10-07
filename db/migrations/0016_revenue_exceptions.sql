-- 0016 — Exceções da conferência de receita (declarado no PGDAS-D × NFS-e prestadas).
--
-- Cada divergência é um Case EXCEPTION por empresa e competência. A fotografia
-- da divergência (valores, hipótese, notas envolvidas) é uma linha nova sempre
-- que os números mudam; a decisão humana também é linha nova. Nada é sobrescrito.

CREATE TABLE revenue_divergence (
  id               uuid NOT NULL PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  entity_id        uuid NOT NULL,
  case_id          uuid NOT NULL,
  competence       date NOT NULL CHECK (extract(day FROM competence) = 1),
  declared         numeric(15,2) NOT NULL,
  nfse             numeric(15,2) NOT NULL,
  difference       numeric(15,2) NOT NULL,
  responsibility   text CHECK (responsibility IN ('ANTERIOR', 'LEGACY')),
  -- CANCELADAS_TOTAL · CANCELADAS_PARTE · NFSE_A_MAIOR · SEM_EXPLICACAO
  hypothesis_code  text NOT NULL,
  hypothesis       text NOT NULL,
  -- notas envolvidas (número, chave, valor, data do cancelamento, tipo do evento)
  notes            jsonb NOT NULL DEFAULT '[]',
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES "case" (tenant_id, id)
);
CREATE INDEX revenue_divergence_case_ix ON revenue_divergence (tenant_id, case_id, created_at DESC);
SELECT apply_tenant_rls('revenue_divergence');

CREATE TABLE exception_decision (
  id          uuid NOT NULL PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  case_id     uuid NOT NULL,
  -- RETIFICAR: o escritório vai retificar · MANTER: diferença justificada
  decision    text NOT NULL CHECK (decision IN ('RETIFICAR', 'MANTER')),
  note        text,
  actor_id    text NOT NULL,
  decided_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, case_id) REFERENCES "case" (tenant_id, id),
  CHECK (decision <> 'MANTER' OR length(trim(coalesce(note, ''))) >= 5)
);
SELECT apply_tenant_rls('exception_decision');

GRANT SELECT, INSERT ON revenue_divergence, exception_decision TO legacy_app;
