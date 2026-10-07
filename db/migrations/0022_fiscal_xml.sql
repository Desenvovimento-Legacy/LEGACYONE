-- 0022 — Entrada de XML fiscal por qualquer canal e distribuição de CT-e.
--
-- fiscal_xml guarda o XML original de documentos que não vêm pelos canais
-- próprios já existentes (NF-e da distribuição em dfe_document, NFS-e do ADN em
-- nfse_document): upload na tela, pasta de entrada (ex.: XML do PDV para
-- NFC-e) e CT-e da distribuição nacional. Só INSERT; o mesmo arquivo (hash) ou
-- o mesmo documento (chave + tipo) não entra duas vezes.

CREATE TABLE fiscal_xml (
  id             uuid NOT NULL PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  entity_id      uuid NOT NULL,
  source         text NOT NULL CHECK (source IN ('UPLOAD', 'PASTA', 'CTE_DIST')),
  nsu            text CHECK (nsu IS NULL OR nsu ~ '^[0-9]{15}$'),
  -- NFE (mod. 55), NFCE (mod. 65), CTE, NFSE (padrão nacional), EVENTO_NFE, EVENTO_CTE, RES_CTE, OUTRO
  doc_type       text NOT NULL CHECK (doc_type IN ('NFE', 'NFCE', 'CTE', 'NFSE', 'EVENTO_NFE', 'EVENTO_CTE', 'OUTRO')),
  -- a empresa é EMITENTE, DESTINATARIO, TOMADOR (CT-e/NFS-e), PRESTADOR (NFS-e) ou OUTRO (citada no XML)
  role           text NOT NULL CHECK (role IN ('EMITENTE', 'DESTINATARIO', 'TOMADOR', 'PRESTADOR', 'OUTRO')),
  access_key     text,
  number         text,
  issuer_doc     text,
  issuer_name    text,
  recipient_doc  text,
  recipient_name text,
  issued_at      timestamptz,
  total          numeric(15,2),
  -- autorizado (100/150), cancelado (evento ou 101/135), denegado (110/301/302) ou sem protocolo
  status         text CHECK (status IN ('AUTORIZADO', 'CANCELADO', 'DENEGADO', 'SEM_PROTOCOLO')),
  event_type     text,
  file_name      text,
  xml            text NOT NULL,
  sha256         bytea NOT NULL,
  received_by    text NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, entity_id, sha256),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE UNIQUE INDEX fiscal_xml_doc_uq ON fiscal_xml (tenant_id, entity_id, doc_type, access_key, coalesce(event_type, ''))
  WHERE access_key IS NOT NULL;
CREATE INDEX fiscal_xml_entity_ix ON fiscal_xml (tenant_id, entity_id, doc_type, issued_at);
SELECT apply_tenant_rls('fiscal_xml');

-- Distribuição de CT-e usa o mesmo controle de cursor e espera da NF-e.
ALTER TABLE dfe_query ADD COLUMN channel text NOT NULL DEFAULT 'NFE' CHECK (channel IN ('NFE', 'CTE'));
CREATE INDEX dfe_query_channel_ix ON dfe_query (tenant_id, entity_id, channel, queried_at DESC);

GRANT SELECT, INSERT ON fiscal_xml TO legacy_app;
