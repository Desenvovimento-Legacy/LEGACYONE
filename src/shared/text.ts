/** Texto para comparação: sem acento, maiúsculo, espaços simples. */
export const normalize = (s: string | null | undefined): string =>
  (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
