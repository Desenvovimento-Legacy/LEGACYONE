/**
 * CNPJ e CPF. O CNPJ segue a IN RFB 2.229/2024 (alfanumérico): 12 posições
 * [0-9A-Z] + 2 dígitos verificadores numéricos. O mesmo algoritmo valida o
 * CNPJ numérico tradicional. O banco aplica a mesma regra (cnpj_is_valid).
 */

const CNPJ_RE = /^[0-9A-Z]{12}[0-9]{2}$/;

function charValue(c: string): number {
  return c.charCodeAt(0) - 48;
}

function mod11(values: number[]): number {
  let weight = 2;
  let sum = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    sum += values[i]! * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const r = sum % 11;
  return r < 2 ? 0 : 11 - r;
}

/** Remove máscara e normaliza para maiúsculas: "12.ABC.345/01DE-35" -> "12ABC34501DE35". */
export function normalizeCnpj(input: string): string {
  return input.toUpperCase().replace(/[.\-/\s]/g, "");
}

export function cnpjCheckDigits(base12: string): string {
  if (!/^[0-9A-Z]{12}$/.test(base12)) throw new Error("Base do CNPJ deve ter 12 posições [0-9A-Z]");
  const values = [...base12].map(charValue);
  const dv1 = mod11(values);
  const dv2 = mod11([...values, dv1]);
  return `${dv1}${dv2}`;
}

export function isValidCnpj(input: string): boolean {
  const cnpj = normalizeCnpj(input);
  if (!CNPJ_RE.test(cnpj) || /^(.)\1{13}$/.test(cnpj)) return false;
  return cnpj.slice(12) === cnpjCheckDigits(cnpj.slice(0, 12));
}

export function formatCnpj(input: string): string {
  const c = normalizeCnpj(input);
  return `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`;
}

/** Raiz do CNPJ (8 primeiras posições), comum a matriz e filiais. */
export function cnpjRoot(input: string): string {
  return normalizeCnpj(input).slice(0, 8);
}

export function normalizeCpf(input: string): string {
  return input.replace(/[.\-\s]/g, "");
}

export function isValidCpf(input: string): boolean {
  const cpf = normalizeCpf(input);
  if (!/^[0-9]{11}$/.test(cpf) || /^(.)\1{10}$/.test(cpf)) return false;
  const d = [...cpf].map(Number);
  const dv = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += d[i]! * (len + 1 - i);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(9) === d[9] && dv(10) === d[10];
}
