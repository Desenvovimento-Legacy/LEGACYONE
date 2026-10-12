-- 0043 — PGDAS-D pronta para transmitir (nada é transmitido).
--
-- A declaração do mês é montada pela IARIS a partir das notas, das atividades
-- já declaradas e dos estabelecimentos. Cada mudança é uma versão nova. A
-- conferência com a Receita usa o próprio serviço de entrega do Integra
-- Contador com indicadorTransmissao = false: a Receita calcula e devolve os
-- valores devidos, sem transmitir. Só então a declaração fica "pronta".

CREATE TABLE pgdas_draft (
  id                  uuid NOT NULL PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  entity_id           uuid NOT NULL,
  competence          date NOT NULL CHECK (extract(day FROM competence) = 1),
  version             int NOT NULL CHECK (version > 0),
  status              text NOT NULL CHECK (status IN ('MONTADA', 'BLOQUEADA')),
  declaration_type    int NOT NULL CHECK (declaration_type IN (1, 2)),
  revenue             numeric(15,2) NOT NULL,
  payload             jsonb NOT NULL,
  blockers            jsonb NOT NULL DEFAULT '[]',
  notes               jsonb NOT NULL DEFAULT '[]',
  iaris_total         numeric(15,2),
  iaris_taxes         jsonb,
  simples_calculation_id uuid,
  fingerprint         text NOT NULL,
  created_by          text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, entity_id, competence, version),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX pgdas_draft_ix ON pgdas_draft (tenant_id, entity_id, competence, version DESC);
SELECT apply_tenant_rls('pgdas_draft');

CREATE TABLE pgdas_draft_check (
  id             uuid NOT NULL PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  entity_id      uuid NOT NULL,
  draft_id       uuid NOT NULL,
  -- CONFERE: Receita = IARIS · DIVERGE: diferente · SO_RECEITA: a IARIS não calculou · ERRO: a Receita recusou
  status         text NOT NULL CHECK (status IN ('CONFERE', 'DIVERGE', 'SO_RECEITA', 'ERRO')),
  values         jsonb,
  total          numeric(15,2),
  difference     numeric(15,2),
  messages       jsonb NOT NULL DEFAULT '[]',
  -- pedido que fica pronto para a transmissão (indicadorTransmissao true + valores da Receita); nunca enviado pela IARIS
  ready_payload  jsonb,
  snapshot_id    uuid,
  checked_by     text NOT NULL,
  checked_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, draft_id) REFERENCES pgdas_draft (tenant_id, id),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX pgdas_draft_check_ix ON pgdas_draft_check (tenant_id, draft_id, checked_at DESC);
SELECT apply_tenant_rls('pgdas_draft_check');

GRANT SELECT, INSERT ON pgdas_draft, pgdas_draft_check TO legacy_app;
