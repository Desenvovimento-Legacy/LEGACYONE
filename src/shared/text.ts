/** Texto para comparação: sem acento, maiúsculo, espaços simples. */
export const normalize = (s: string | null | undefined): string =>
  (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();

/**
 * Desfaz texto UTF-8 lido como Latin-1 ("ANÃ\u0081LISES" → "ANÁLISES"), comum em
 * XML de emissores municipais. Só troca quando a releitura é UTF-8 válido.
 */
export function fixMojibake(s: string | null | undefined): string {
  const t = s ?? "";
  if (!/[ÃÂ][\u0080-¿]/.test(t) || /[^\u0000-ÿ]/.test(t)) return t;
  const r = Buffer.from(t, "latin1").toString("utf8");
  return r.includes("�") ? t : r;
}
