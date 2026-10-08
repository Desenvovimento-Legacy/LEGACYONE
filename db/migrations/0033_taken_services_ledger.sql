-- 0033 — NFS-e tomadas no razão.
--
-- accounting_rule_approval: regra de contabilização proposta pela IARIS
-- (ex.: tipo de serviço da LC 116 → conta de despesa) só vale depois da
-- aprovação de uma pessoa, por escritório e versão.
-- supplier_rule: decisão de uma pessoa para um fornecedor ("notas deste
-- prestador vão para a conta X"), na empresa ou no escritório todo.

CREATE TABLE accounting_rule_approval (
  id           uuid NOT NULL PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  rule_set     text NOT NULL,
  approved_by  text NOT NULL,
  approved_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, rule_set)
);
SELECT apply_tenant_rls('accounting_rule_approval');

CREATE TABLE supplier_rule (
  id            uuid NOT NULL PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  entity_id     uuid,
  supplier_doc  text NOT NULL,
  account_code  text NOT NULL,
  history       text NOT NULL,
  valid_from    date NOT NULL,
  valid_to      date CHECK (valid_to IS NULL OR valid_to >= valid_from),
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX supplier_rule_ix ON supplier_rule (tenant_id, supplier_doc);
SELECT apply_tenant_rls('supplier_rule');

ALTER TABLE bank_match DROP CONSTRAINT bank_match_method_check;
ALTER TABLE bank_match ADD CONSTRAINT bank_match_method_check CHECK (method IN ('PAGAMENTO_FEDERAL', 'NFSE', 'NFSE_TOMADA', 'REGRA', 'PESSOA'));

GRANT SELECT, INSERT ON accounting_rule_approval, supplier_rule TO legacy_app;
GRANT UPDATE (valid_to) ON supplier_rule TO legacy_app;
