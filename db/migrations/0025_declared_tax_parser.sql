-- 0025 — Débito declarado por atividade com versão do leitor do PDF.
--
-- Leitor novo (ex.: anexo de comércio e indústria) grava linhas novas para o
-- mesmo PDF; as da versão anterior ficam. O motor usa a versão mais recente.

ALTER TABLE pgdas_declared_tax ADD COLUMN parser text NOT NULL DEFAULT 'pgdas-pdf-1';
ALTER TABLE pgdas_declared_tax ALTER COLUMN parser DROP DEFAULT;
ALTER TABLE pgdas_declared_tax DROP CONSTRAINT pgdas_declared_tax_tenant_id_pdf_id_seq_key;
ALTER TABLE pgdas_declared_tax ADD CONSTRAINT pgdas_declared_tax_pdf_seq_parser_uk UNIQUE (tenant_id, pdf_id, seq, parser);
