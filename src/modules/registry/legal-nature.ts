/**
 * Natureza jurídica (tabela da Receita) -> tipo de entidade do IARIS.
 * Códigos não mapeados retornam null e viram pendência para classificação humana:
 * o sistema não chuta o tipo de entidade.
 */
const MAP: Record<string, string> = {
  "2046": "SOCIEDADE_EMPRESARIA", // Sociedade Anônima Aberta
  "2054": "SOCIEDADE_EMPRESARIA", // Sociedade Anônima Fechada
  "2062": "SOCIEDADE_EMPRESARIA", // Sociedade Empresária Limitada
  "2070": "SOCIEDADE_EMPRESARIA", // Sociedade Empresária em Nome Coletivo
  "2135": "EMPRESARIO_INDIVIDUAL", // Empresário (Individual)
  "2232": "SOCIEDADE_SIMPLES", // Sociedade Simples Pura
  "2240": "SOCIEDADE_SIMPLES", // Sociedade Simples Limitada
  "2259": "SOCIEDADE_SIMPLES", // Sociedade Simples em Nome Coletivo
  "2267": "SOCIEDADE_SIMPLES", // Sociedade Simples em Comandita Simples
  "2305": "SLU", // Empresa Individual de Responsabilidade Limitada (Empresária) — legado
  "2313": "SLU", // Empresa Individual de Responsabilidade Limitada (Simples) — legado
  "2143": "COOPERATIVA",
  "2330": "COOPERATIVA", // Cooperativas de Consumo
  "3069": "FUNDACAO", // Fundação Privada
  "3085": "CONDOMINIO", // Condomínio Edilício
  "3220": "ORGANIZACAO_RELIGIOSA",
  "3999": "ASSOCIACAO", // Associação Privada
  "4120": "PRODUTOR_RURAL", // Produtor Rural (Pessoa Física)
};

export function entityTypeFromLegalNature(code: string): string | null {
  return MAP[code] ?? null;
}
