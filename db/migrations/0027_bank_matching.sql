-- 0027 — Do extrato ao razão: regras de histórico e vínculo movimento → lançamento.
--
-- bank_rule: "quando o histórico do banco tiver X, lance em Y" — criada por
-- uma pessoa (decisão vira memória contábil da empresa ou do escritório).
-- bank_match: movimento do extrato ligado ao lançamento que o contabilizou e
-- ao método (pagamento federal, nota, regra, pessoa). Só INSERT.

CREATE TABLE bank_rule (
  id            uuid NOT NULL PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  entity_id     uuid,
  pattern       text NOT NULL CHECK (length(pattern) >= 3),
  direction     text NOT NULL CHECK (direction IN ('ENTRADA', 'SAIDA', 'AMBOS')),
  account_code  text NOT NULL,
  history       text NOT NULL,
  valid_from    date NOT NULL,
  valid_to      date CHECK (valid_to IS NULL OR valid_to >= valid_from),
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
SELECT apply_tenant_rls('bank_rule');

CREATE TABLE bank_match (
  id              uuid NOT NULL PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  entity_id       uuid NOT NULL,
  transaction_id  uuid NOT NULL,
  entry_id        uuid NOT NULL,
  method          text NOT NULL CHECK (method IN ('PAGAMENTO_FEDERAL', 'NFSE', 'REGRA', 'PESSOA')),
  reference       text,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, transaction_id, entry_id),
  FOREIGN KEY (tenant_id, transaction_id) REFERENCES bank_transaction (tenant_id, id),
  FOREIGN KEY (tenant_id, entry_id) REFERENCES journal_entry (tenant_id, id),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX bank_match_reference_ix ON bank_match (tenant_id, method, reference);
SELECT apply_tenant_rls('bank_match');

GRANT SELECT, INSERT ON bank_rule, bank_match TO legacy_app;
GRANT UPDATE (valid_to) ON bank_rule TO legacy_app;
