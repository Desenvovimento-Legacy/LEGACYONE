/** Texto para comparação: sem acento, maiúsculo, espaços simples. */
export const normalize = (s: string | null | undefined): string =>
  (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();

/**
 * Desfaz texto UTF-8 lido como Latin-1 ("ANÃ\u0081LISES" → "ANÁLISES"), comum em
 * XML de emissores municipais. Cada par "Ã" + byte de continuação volta a ser a
 * letra original; um "Ã" sozinho no meio desse texto é o "Í" cujo segundo byte
 * (0x8D, que o Windows-1252 não tem) se perdeu no caminho. Só para exibição.
 */
export function fixMojibake(s: string | null | undefined): string {
  const t = s ?? "";
  if (!/[ÃÂ][\u0080-\u00BF]/.test(t) || /[^\u0000-\u00FF]/.test(t)) return t;
  // uma passada só: o "Ã" que sai de um par decodificado não pode virar "Í"
  return t.replace(/[ÃÂ][\u0080-\u00BF]|Ã(?=[A-Z])/g, (m) => (m.length === 2 ? Buffer.from(m, "latin1").toString("utf8") : "Í"));
}
