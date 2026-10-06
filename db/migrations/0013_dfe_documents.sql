-- 0013 — Documentos fiscais eletrônicos recebidos da SEFAZ (NFeDistribuicaoDFe)
-- e pedidos de manifestação do destinatário (ciência da operação).
--
-- Regras do web service (NT 2014.002): consulta sequencial por NSU a partir do
-- último recebido; sem documento novo (cStat 137) ou ultNSU = maxNSU, esperar
-- 1 hora; fora disso a SEFAZ responde 656 e bloqueia o CNPJ por 1 hora.
-- Cada consulta fica registrada (dfe_query) e o cursor é a consulta mais recente.
-- O XML original de cada documento é guardado com hash: é a evidência.

CREATE TABLE dfe_query (
  id               uuid NOT NULL PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  entity_id        uuid NOT NULL,
  requested_nsu    text NOT NULL CHECK (requested_nsu ~ '^[0-9]{15}$'),
  status_code      text NOT NULL,
  status_message   text NOT NULL,
  ult_nsu          text CHECK (ult_nsu ~ '^[0-9]{15}$'),
  max_nsu          text CHECK (max_nsu ~ '^[0-9]{15}$'),
  documents        int NOT NULL DEFAULT 0,
  -- quando a próxima consulta pode sair sem risco de bloqueio
  next_allowed_at  timestamptz NOT NULL,
  actor_kind       text NOT NULL,
  actor_id         text NOT NULL,
  queried_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX dfe_query_cursor_ix ON dfe_query (tenant_id, entity_id, queried_at DESC);
SELECT apply_tenant_rls('dfe_query');

CREATE TABLE dfe_document (
  id            uuid NOT NULL PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  entity_id     uuid NOT NULL,
  nsu           text NOT NULL CHECK (nsu ~ '^[0-9]{15}$'),
  -- RES_NFE: resumo (antes da ciência) · NFE: XML completo autorizado
  -- RES_EVENTO: resumo de evento · EVENTO: evento completo (cancelamento, CC-e...)
  kind          text NOT NULL CHECK (kind IN ('RES_NFE', 'NFE', 'RES_EVENTO', 'EVENTO', 'OUTRO')),
  schema_name   text NOT NULL,
  access_key    char(44) CHECK (access_key ~ '^[0-9]{44}$'),
  issuer_doc    text,
  issuer_name   text,
  recipient_doc text,
  issued_at     timestamptz,
  -- tpNF da nota: 0 = entrada, 1 = saída (do ponto de vista de quem emitiu)
  nf_type       text,
  total         numeric(15,2),
  -- cSitNFe do resumo: 1 autorizada, 2 denegada, 3 cancelada
  situation     text,
  event_type    text,
  event_desc    text,
  xml           text NOT NULL,
  sha256        bytea NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, entity_id, nsu),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX dfe_document_key_ix ON dfe_document (tenant_id, access_key);
SELECT apply_tenant_rls('dfe_document');

-- Manifestação do destinatário. Ciência (210210) só sai depois da aprovação
-- humana registrada aqui; cada passo é uma linha nova (nada é sobrescrito).
CREATE TABLE nfe_manifestation (
  id             uuid NOT NULL PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  entity_id      uuid NOT NULL,
  access_key     char(44) NOT NULL CHECK (access_key ~ '^[0-9]{44}$'),
  event_type     text NOT NULL CHECK (event_type IN ('210210', '210200', '210220', '210240')),
  status         text NOT NULL CHECK (status IN ('APROVADA', 'ENVIADA', 'REGISTRADA', 'REJEITADA')),
  status_code    text,
  status_message text,
  protocol       text,
  actor_kind     text NOT NULL,
  actor_id       text NOT NULL,
  at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX nfe_manifestation_ix ON nfe_manifestation (tenant_id, access_key, event_type, at DESC);
-- a mesma aprovação não entra duas vezes
CREATE UNIQUE INDEX nfe_manifestation_approval_uq ON nfe_manifestation (tenant_id, access_key, event_type) WHERE status = 'APROVADA';
SELECT apply_tenant_rls('nfe_manifestation');

GRANT SELECT, INSERT ON dfe_query, dfe_document, nfe_manifestation TO legacy_app;
