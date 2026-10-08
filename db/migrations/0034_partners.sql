-- 0034 — Cadastro de parceiros (fornecedores e clientes) de cada empresa.
--
-- partner: quem presta serviço para a empresa (FORNECEDOR) ou toma dela
-- (CLIENTE). Nasce das NFS-e (e depois de NF-e, extrato, pessoa). É a base para
-- o mês seguinte: quem é recorrente, qual conta usa, o que está em aberto, e
-- para reconhecer o parceiro no histórico do banco. Só INSERT.
-- partner_alias: como o parceiro aparece no extrato ("PIX ENV DELTA SERV
-- MANUT"). APRENDIDO = veio de um pagamento/recebimento conciliado pela nota
-- (evidência guardada); PESSOA = informado por alguém. Encerra por valid_to.
-- bank_match: um movimento pode quitar várias notas (pagamento agrupado), então
-- o vínculo passa a ser único por movimento + lançamento + referência.

CREATE TABLE partner (
  id          uuid NOT NULL PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  entity_id   uuid NOT NULL,
  doc         text NOT NULL CHECK (doc ~ '^[0-9A-Z]{11}([0-9A-Z]{3})?$'),
  role        text NOT NULL CHECK (role IN ('FORNECEDOR', 'CLIENTE')),
  name        text,
  source      text NOT NULL CHECK (source IN ('NFSE_TOMADA', 'NFSE_PRESTADA', 'PESSOA')),
  first_seen  date NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, entity_id, doc, role),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
SELECT apply_tenant_rls('partner');

CREATE TABLE partner_alias (
  id          uuid NOT NULL PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  entity_id   uuid NOT NULL,
  partner_id  uuid NOT NULL,
  pattern     text NOT NULL CHECK (length(pattern) >= 4),
  source      text NOT NULL CHECK (source IN ('APRENDIDO', 'PESSOA')),
  evidence    jsonb NOT NULL DEFAULT '[]'::jsonb,
  valid_from  date NOT NULL,
  valid_to    date CHECK (valid_to IS NULL OR valid_to >= valid_from),
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, partner_id, pattern),
  FOREIGN KEY (tenant_id, partner_id) REFERENCES partner (tenant_id, id),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
SELECT apply_tenant_rls('partner_alias');

ALTER TABLE bank_match DROP CONSTRAINT bank_match_tenant_id_transaction_id_entry_id_key;
ALTER TABLE bank_match ADD CONSTRAINT bank_match_tx_entry_ref_key UNIQUE NULLS NOT DISTINCT (tenant_id, transaction_id, entry_id, reference);

GRANT SELECT, INSERT ON partner, partner_alias TO legacy_app;
GRANT UPDATE (valid_to) ON partner_alias TO legacy_app;
