-- 0046 — Extrato também em Excel (.xlsx) e PDF (além de OFX e CSV).
ALTER TABLE bank_statement_file DROP CONSTRAINT bank_statement_file_format_check;
ALTER TABLE bank_statement_file ADD CONSTRAINT bank_statement_file_format_check CHECK (format IN ('OFX', 'CSV', 'XLSX', 'PDF'));
