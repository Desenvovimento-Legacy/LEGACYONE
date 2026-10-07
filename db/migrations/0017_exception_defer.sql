-- 0017 — Exceção pode ir para revisão posterior (ADIAR): sai da Fila humana,
-- continua aberta e registrada, e pode ser decidida depois (RETIFICAR ou MANTER).
ALTER TABLE exception_decision DROP CONSTRAINT exception_decision_decision_check;
ALTER TABLE exception_decision ADD CONSTRAINT exception_decision_decision_check
  CHECK (decision IN ('RETIFICAR', 'MANTER', 'ADIAR'));
