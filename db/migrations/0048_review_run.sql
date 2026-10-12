-- 0048 — Revisão independente (One Review).
--
-- Cada linha é uma fotografia da revisão de uma empresa numa competência:
-- conferências cruzadas (contábil, fiscal, tributário, financeiro e
-- documentos), nota de cobertura, materialidade e risco. Insert-only: nova
-- linha só quando o resultado muda (impressão digital diferente da última).
CREATE TABLE review_run (
  id            uuid NOT NULL PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  entity_id     uuid NOT NULL,
  competence    date NOT NULL CHECK (extract(day FROM competence) = 1),
  version       text NOT NULL,
  status        text NOT NULL CHECK (status IN ('APROVADA', 'COM_RESSALVAS', 'PENDENTE', 'NAO_SE_APLICA')),
  -- conferências OK sobre as aplicáveis (0 a 100)
  coverage      numeric(5,2) NOT NULL CHECK (coverage BETWEEN 0 AND 100),
  risk          text NOT NULL CHECK (risk IN ('BAIXO', 'MEDIO', 'ALTO')),
  -- soma dos valores em aberto nas conferências que não estão OK
  materiality   numeric(15,2) NOT NULL DEFAULT 0,
  -- receita contabilizada no mês (base da materialidade)
  revenue       numeric(15,2),
  pending       integer NOT NULL,
  alerts        integer NOT NULL,
  checks        jsonb NOT NULL,
  fingerprint   text NOT NULL,
  locked        boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX review_run_ix ON review_run (tenant_id, entity_id, competence, created_at DESC);
SELECT apply_tenant_rls('review_run');
GRANT SELECT, INSERT ON review_run TO legacy_app;
