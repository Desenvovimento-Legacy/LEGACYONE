-- 0031 — Forma de acesso ao órgão estadual/municipal. Nem todo órgão usa
-- procuração: muitos municípios no Emissor Nacional entram pela conta gov.br,
-- outros pelo certificado digital ou senha do portal (senha nunca no banco: só
-- o registro de que o acesso existe; a senha, se houver, vai para o cofre).

ALTER TABLE power_of_attorney
  ADD COLUMN access_method text NOT NULL DEFAULT 'PROCURACAO'
    CHECK (access_method IN ('PROCURACAO', 'GOVBR', 'CERTIFICADO', 'SENHA_PORTAL'));
