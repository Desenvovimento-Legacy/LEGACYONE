-- Validação de documentos brasileiros no próprio banco: o dado inválido não entra
-- nem por fora da aplicação.

-- CNPJ alfanumérico (IN RFB 2.229/2024): 12 posições [0-9A-Z] + 2 DVs numéricos.
-- Valor do caractere = código ASCII - 48 ('0'..'9' = 0..9, 'A' = 17 ... 'Z' = 42).
-- Pesos: 2..9 da direita para a esquerda; resto < 2 -> DV 0; senão 11 - resto.
-- O mesmo algoritmo valida o CNPJ numérico tradicional.
CREATE OR REPLACE FUNCTION cnpj_is_valid(p text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT
AS $$
DECLARE
  s int;
  w int;
  i int;
  r int;
  dv1 int;
  dv2 int;
BEGIN
  IF p !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN
    RETURN false;
  END IF;
  IF p ~ '^(.)\1{13}$' THEN
    RETURN false;
  END IF;

  s := 0; w := 2;
  FOR i IN REVERSE 12..1 LOOP
    s := s + (ascii(substr(p, i, 1)) - 48) * w;
    w := CASE WHEN w = 9 THEN 2 ELSE w + 1 END;
  END LOOP;
  r := s % 11;
  dv1 := CASE WHEN r < 2 THEN 0 ELSE 11 - r END;

  s := 0; w := 2;
  FOR i IN REVERSE 13..1 LOOP
    s := s + (CASE WHEN i = 13 THEN dv1 ELSE ascii(substr(p, i, 1)) - 48 END) * w;
    w := CASE WHEN w = 9 THEN 2 ELSE w + 1 END;
  END LOOP;
  r := s % 11;
  dv2 := CASE WHEN r < 2 THEN 0 ELSE 11 - r END;

  RETURN substr(p, 13, 1)::int = dv1 AND substr(p, 14, 1)::int = dv2;
END
$$;

CREATE OR REPLACE FUNCTION cpf_is_valid(p text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT
AS $$
DECLARE
  s int;
  i int;
  r int;
  dv1 int;
  dv2 int;
BEGIN
  IF p !~ '^[0-9]{11}$' OR p ~ '^(.)\1{10}$' THEN
    RETURN false;
  END IF;

  s := 0;
  FOR i IN 1..9 LOOP
    s := s + substr(p, i, 1)::int * (11 - i);
  END LOOP;
  r := s % 11;
  dv1 := CASE WHEN r < 2 THEN 0 ELSE 11 - r END;

  s := 0;
  FOR i IN 1..10 LOOP
    s := s + (CASE WHEN i = 10 THEN dv1 ELSE substr(p, i, 1)::int END) * (12 - i);
  END LOOP;
  r := s % 11;
  dv2 := CASE WHEN r < 2 THEN 0 ELSE 11 - r END;

  RETURN substr(p, 10, 1)::int = dv1 AND substr(p, 11, 1)::int = dv2;
END
$$;
