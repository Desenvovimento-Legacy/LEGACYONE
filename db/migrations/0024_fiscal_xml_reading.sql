-- 0024 — Releitura de XML fiscal com leitor novo, sem sobrescrever o original.
--
-- fiscal_xml guarda o XML e a primeira leitura. Quando o leitor passa a
-- reconhecer um documento antes recusado como OUTRO (ex.: CT-e OS, modelo 67),
-- a leitura nova entra aqui, por versão do leitor; a tela usa a mais recente.

ALTER TABLE fiscal_xml ADD CONSTRAINT fiscal_xml_tenant_id_uk UNIQUE (tenant_id, id);

CREATE TABLE fiscal_xml_reading (
  id              uuid NOT NULL PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  entity_id       uuid NOT NULL,
  fiscal_xml_id   uuid NOT NULL,
  parser          text NOT NULL,
  doc_type        text NOT NULL CHECK (doc_type IN ('NFE', 'NFCE', 'CTE', 'NFSE', 'EVENTO_NFE', 'EVENTO_CTE', 'OUTRO')),
  role            text NOT NULL CHECK (role IN ('EMITENTE', 'DESTINATARIO', 'TOMADOR', 'PRESTADOR', 'OUTRO')),
  access_key      text,
  number          text,
  issuer_doc      text,
  issuer_name     text,
  recipient_doc   text,
  recipient_name  text,
  issued_at       timestamptz,
  total           numeric(15,2),
  status          text CHECK (status IN ('AUTORIZADO', 'CANCELADO', 'DENEGADO', 'SEM_PROTOCOLO')),
  event_type      text,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, fiscal_xml_id, parser),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id),
  FOREIGN KEY (tenant_id, fiscal_xml_id) REFERENCES fiscal_xml (tenant_id, id)
);
SELECT apply_tenant_rls('fiscal_xml_reading');
GRANT SELECT, INSERT ON fiscal_xml_reading TO legacy_app;
