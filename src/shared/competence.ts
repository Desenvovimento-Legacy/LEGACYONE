/**
 * Competência contábil/fiscal. Armazenada como date no 1º dia do mês.
 * Representação textual: "YYYY-MM".
 */
const RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function parseCompetence(value: string): string {
  const m = RE.exec(value);
  if (!m) throw new Error(`Competência inválida: ${value} (use YYYY-MM)`);
  return `${m[1]}-${m[2]}-01`;
}

export function formatCompetence(date: string | Date): string {
  const iso = typeof date === "string" ? date : date.toISOString();
  return iso.slice(0, 7);
}
