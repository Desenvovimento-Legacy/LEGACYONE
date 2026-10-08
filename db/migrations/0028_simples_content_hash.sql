-- 0028 — Cálculo do Simples: "mudou?" passa a ser comparado com o ÚLTIMO
-- cálculo da competência (content_hash), não com qualquer cálculo do histórico.
-- Antes, voltar a um resultado já visto (A → B → A) não gravava a volta.

ALTER TABLE simples_calculation ADD COLUMN content_hash text;
UPDATE simples_calculation SET content_hash = fingerprint;
