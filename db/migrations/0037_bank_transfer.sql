-- 0037 — Transferência entre contas da própria empresa: um lançamento liga os
-- dois movimentos (saída de uma conta, entrada na outra).
ALTER TABLE bank_match DROP CONSTRAINT bank_match_method_check;
ALTER TABLE bank_match ADD CONSTRAINT bank_match_method_check CHECK (method IN ('PAGAMENTO_FEDERAL', 'NFSE', 'NFSE_TOMADA', 'REGRA', 'PESSOA', 'TRANSFERENCIA'));
