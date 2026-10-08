-- 0030 — Procurações estaduais (SEFAZ) e municipais (Prefeitura).
--
-- Não há consulta padrão nacional: cada SEFAZ e prefeitura tem seu portal. A
-- procuração entra pela tela com o termo/print (DOCUMENTO) ou só declarada por
-- uma pessoa (DECLARACAO); a do e-CAC continua vindo da consulta (CONSULTA).
-- Só INSERT: procuração nova (renovação) é linha nova; vale a mais recente.

ALTER TABLE power_of_attorney
  ADD COLUMN jurisdiction      text,
  ADD COLUMN jurisdiction_name text,
  ADD COLUMN protocol          text,
  ADD COLUMN file_name         text,
  ADD COLUMN document          bytea,
  ADD COLUMN document_sha256   bytea,
  ADD COLUMN registered_by     text,
  ADD COLUMN verification      text NOT NULL DEFAULT 'CONSULTA' CHECK (verification IN ('CONSULTA', 'DOCUMENTO', 'DECLARACAO')),
  ADD CONSTRAINT power_of_attorney_jurisdiction_ck CHECK (system NOT IN ('SEFAZ', 'PREFEITURA') OR jurisdiction IS NOT NULL);
