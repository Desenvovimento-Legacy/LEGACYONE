-- 0047 — Guia enviada ao cliente (o escritório gera o DARF/guia e envia).
--
-- Separa "guia não enviada" de "enviada e pagamento ainda não identificado".
-- Cada envio é uma linha (reenvio = linha nova); o arquivo da guia é opcional.
CREATE TABLE guide_dispatch (
  id            uuid NOT NULL PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  entity_id     uuid NOT NULL,
  -- IRRF, CSRF, ISS:<IBGE>, SIMPLES
  tax           text NOT NULL CHECK (tax IN ('IRRF', 'CSRF', 'SIMPLES') OR tax ~ '^ISS:[0-9]{7}$'),
  competence    date NOT NULL CHECK (extract(day FROM competence) = 1),
  amount        numeric(15,2),
  due_on        date,
  document_number text,
  channel       text NOT NULL CHECK (channel IN ('WHATSAPP', 'EMAIL', 'PORTAL', 'TELEFONE', 'OUTRO')),
  sent_on       date NOT NULL,
  file_name     text,
  content       bytea,
  sha256        bytea,
  sent_by       text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
CREATE INDEX guide_dispatch_ix ON guide_dispatch (tenant_id, entity_id, tax, competence, created_at DESC);
SELECT apply_tenant_rls('guide_dispatch');
GRANT SELECT, INSERT ON guide_dispatch TO legacy_app;

ALTER TABLE withholding_observation DROP CONSTRAINT withholding_observation_status_check;
ALTER TABLE withholding_observation ADD CONSTRAINT withholding_observation_status_check
  CHECK (status IN ('PRAZO_A_APROVAR', 'A_VENCER', 'ABAIXO_DO_MINIMO', 'PAGAMENTO_NAO_IDENTIFICADO', 'GUIA_NAO_ENVIADA',
                    'PAGO', 'PAGO_EM_ATRASO', 'PAGO_DIVERGENTE', 'PAGO_SEM_NOTA'));
