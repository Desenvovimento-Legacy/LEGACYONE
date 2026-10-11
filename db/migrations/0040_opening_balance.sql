-- 0040 — Saldos de abertura herdados do escritório anterior (implantação).
--
-- opening_balance_import: um balancete importado (arquivo original por hash),
-- com cada conta analítica, o de/para para o plano da empresa, o método do
-- de/para e o status do saldo herdado (INHERITED_NOT_VALIDATED até conferir).
-- O lançamento de abertura (origem MIGRACAO) fica ligado. Só INSERT.

CREATE TABLE opening_balance_import (
  id            uuid NOT NULL PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  entity_id     uuid NOT NULL,
  file_name     text NOT NULL,
  sha256        bytea NOT NULL,
  period_end    date NOT NULL,
  entry_date    date NOT NULL,
  source_firm   text,
  lines         jsonb NOT NULL,
  total_debit   numeric(18, 2) NOT NULL,
  total_credit  numeric(18, 2) NOT NULL CHECK (total_debit = total_credit),
  entry_id      uuid NOT NULL,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, entity_id, sha256),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id),
  FOREIGN KEY (tenant_id, entry_id) REFERENCES journal_entry (tenant_id, id)
);
SELECT apply_tenant_rls('opening_balance_import');
GRANT SELECT, INSERT ON opening_balance_import TO legacy_app;
