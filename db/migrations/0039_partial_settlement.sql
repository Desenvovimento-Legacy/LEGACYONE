-- 0039 — Recebimento/pagamento parcial de NFS-e.
--
-- Um movimento do extrato pode quitar só parte de uma nota (parcelas). O vínculo
-- guarda o valor baixado; a nota continua em aberto pelo saldo até a última parcela.
-- NFSE_PARCIAL / NFSE_TOMADA_PARCIAL: baixa parcial (amount obrigatório).
-- NFSE / NFSE_TOMADA: quitação (amount opcional; nulo nos vínculos antigos).

ALTER TABLE bank_match ADD COLUMN amount numeric(18, 2) CHECK (amount IS NULL OR amount > 0);
ALTER TABLE bank_match DROP CONSTRAINT bank_match_method_check;
ALTER TABLE bank_match ADD CONSTRAINT bank_match_method_check CHECK (method IN (
  'PAGAMENTO_FEDERAL', 'NFSE', 'NFSE_TOMADA', 'NFSE_PARCIAL', 'NFSE_TOMADA_PARCIAL', 'REGRA', 'PESSOA', 'TRANSFERENCIA'));
ALTER TABLE bank_match ADD CONSTRAINT bank_match_partial_amount CHECK (method NOT IN ('NFSE_PARCIAL', 'NFSE_TOMADA_PARCIAL') OR amount IS NOT NULL);
