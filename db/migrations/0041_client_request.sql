-- 0041 — Agente de Relacionamento: um pedido consolidado ao cliente.
--
-- Os agentes técnicos não falam com o cliente: o que falta (extratos,
-- comprovantes, notas esperadas, esclarecimentos, pendências) vira UM pedido
-- por empresa. Cada mudança no que falta gera nova versão (só INSERT); a
-- situação (preparado, enviado, respondido, dispensado) é histórico próprio.

CREATE TABLE client_request (
  id           uuid NOT NULL PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  entity_id    uuid NOT NULL,
  version      int NOT NULL CHECK (version > 0),
  fingerprint  text NOT NULL,
  items        jsonb NOT NULL,
  message      text NOT NULL,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, entity_id, version),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX client_request_entity_ix ON client_request (tenant_id, entity_id, version DESC);
SELECT apply_tenant_rls('client_request');

CREATE TABLE client_request_status (
  id          uuid NOT NULL PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  request_id  uuid NOT NULL,
  status      text NOT NULL CHECK (status IN ('PREPARADO', 'ENVIADO', 'RESPONDIDO', 'DISPENSADO')),
  channel     text CHECK (channel IS NULL OR channel IN ('WHATSAPP', 'EMAIL', 'PORTAL', 'TELEFONE', 'OUTRO')),
  note        text,
  actor_id    text NOT NULL,
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, request_id) REFERENCES client_request (tenant_id, id)
);
CREATE INDEX client_request_status_ix ON client_request_status (tenant_id, request_id, at DESC);
SELECT apply_tenant_rls('client_request_status');

GRANT SELECT, INSERT ON client_request, client_request_status TO legacy_app;
