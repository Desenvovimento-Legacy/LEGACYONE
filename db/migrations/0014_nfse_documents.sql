-- 0014 — NFS-e do Sistema Nacional (ADN, API de distribuição aos contribuintes).
--
-- GET https://adn.nfse.gov.br/contribuintes/DFe/{NSU}?lote=true — lotes de até
-- 50 documentos, TLS mútuo com certificado da mesma raiz do CNPJ. Sequência
-- própria (não interfere na NF-e). Cada consulta fica registrada; o cursor é o
-- maior NSU já recebido. XML original guardado com SHA-256.

CREATE TABLE nfse_query (
  id               uuid NOT NULL PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  entity_id        uuid NOT NULL,
  requested_nsu    bigint NOT NULL CHECK (requested_nsu >= 0),
  http_status      int,
  status           text NOT NULL,
  message          text,
  max_nsu          bigint,
  documents        int NOT NULL DEFAULT 0,
  next_allowed_at  timestamptz NOT NULL,
  actor_kind       text NOT NULL,
  actor_id         text NOT NULL,
  queried_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX nfse_query_cursor_ix ON nfse_query (tenant_id, entity_id, queried_at DESC);
SELECT apply_tenant_rls('nfse_query');

CREATE TABLE nfse_document (
  id             uuid NOT NULL PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  entity_id      uuid NOT NULL,
  nsu            bigint NOT NULL,
  access_key     text,
  doc_type       text,
  event_type     text,
  -- PRESTADA: a empresa é a prestadora · TOMADA: a empresa é a tomadora · OUTRA
  role           text NOT NULL CHECK (role IN ('PRESTADA', 'TOMADA', 'OUTRA', 'EVENTO')),
  number         text,
  issued_at      timestamptz,
  provider_doc   text,
  provider_name  text,
  taker_doc      text,
  taker_name     text,
  service_value  numeric(15,2),
  net_value      numeric(15,2),
  iss_value      numeric(15,2),
  iss_withheld   boolean,
  municipality   text,
  generated_at   timestamptz,
  xml            text NOT NULL,
  sha256         bytea NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, entity_id, nsu),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX nfse_document_key_ix ON nfse_document (tenant_id, access_key);
SELECT apply_tenant_rls('nfse_document');

GRANT SELECT, INSERT ON nfse_query, nfse_document TO legacy_app;
