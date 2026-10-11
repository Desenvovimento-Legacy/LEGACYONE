-- 0042 — Fechamento do módulo fiscal.
--
-- 1) NF-e: quando a SEFAZ rejeita por sequência (656 "Deve ser utilizado o
--    ultNSU") ela informa o ultNSU certo. A IARIS segue dele sozinha e registra
--    a lacuna: os NSU que outro sistema (com o mesmo certificado) já baixou.
-- 2) NFS-e enviada por upload/pasta (padrão nacional ou ABRASF dos emissores
--    municipais) vira nota para o fiscal e o contábil, como as do Ambiente
--    Nacional. Sem NSU; não duplica com a do ADN (a que chega depois fica
--    guardada como cópia, com o XML, em nfse_duplicate).

CREATE TABLE dfe_gap (
  id           uuid NOT NULL PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  entity_id    uuid NOT NULL,
  channel      text NOT NULL CHECK (channel IN ('NFE', 'CTE')),
  from_nsu     text NOT NULL CHECK (from_nsu ~ '^[0-9]{15}$'),
  to_nsu       text NOT NULL CHECK (to_nsu ~ '^[0-9]{15}$'),
  status_code  text NOT NULL,
  message      text,
  detected_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, entity_id, channel, from_nsu, to_nsu),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
SELECT apply_tenant_rls('dfe_gap');
GRANT SELECT, INSERT ON dfe_gap TO legacy_app;

ALTER TABLE nfse_document ALTER COLUMN nsu DROP NOT NULL;
ALTER TABLE nfse_document ADD COLUMN source text NOT NULL DEFAULT 'ADN' CHECK (source IN ('ADN', 'UPLOAD', 'PASTA'));
ALTER TABLE nfse_document ADD COLUMN layout text NOT NULL DEFAULT 'NACIONAL' CHECK (layout IN ('NACIONAL', 'ABRASF'));
ALTER TABLE nfse_document ADD COLUMN fiscal_xml_id uuid;
ALTER TABLE nfse_document ADD CONSTRAINT nfse_document_nsu_source CHECK ((source = 'ADN') = (nsu IS NOT NULL));
CREATE UNIQUE INDEX nfse_document_sha_uq ON nfse_document (tenant_id, entity_id, sha256) WHERE nsu IS NULL;
CREATE INDEX nfse_document_number_ix ON nfse_document (tenant_id, entity_id, provider_doc, number);

CREATE TABLE nfse_duplicate (
  id            uuid NOT NULL PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  entity_id     uuid NOT NULL,
  nfse_id       uuid NOT NULL,
  source        text NOT NULL CHECK (source IN ('ADN', 'UPLOAD', 'PASTA')),
  nsu           bigint,
  reason        text NOT NULL,
  xml           text NOT NULL,
  sha256        bytea NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, entity_id, sha256),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entity (tenant_id, id)
);
SELECT apply_tenant_rls('nfse_duplicate');
GRANT SELECT, INSERT ON nfse_duplicate TO legacy_app;
