import { cnpjCheckDigits } from "../../src/shared/br/documents.js";

/** CNPJ fictício alfanumérico (exemplo oficial da Receita). */
export const CNPJ_MATRIZ = "12ABC34501DE35";
export const CNPJ_FILIAL = `12ABC3450002${cnpjCheckDigits("12ABC3450002")}`;
export const CNPJ_PRESUMIDO = `98XYZ7650001${cnpjCheckDigits("98XYZ7650001")}`;

/**
 * Resposta no formato da BrasilAPI, com dados FICTÍCIOS. A estrutura espelha a
 * resposta real de uma empresa de serviços do Simples Nacional.
 */
export function brasilApiResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uf: "SC",
    cep: "88000000",
    qsa: [
      {
        pais: null,
        nome_socio: "FULANO DE TAL",
        codigo_pais: null,
        faixa_etaria: "Entre 41 a 50 anos",
        cnpj_cpf_do_socio: "***123456**",
        qualificacao_socio: "Sócio-Administrador",
        codigo_faixa_etaria: 5,
        data_entrada_sociedade: "2025-04-30",
        identificador_de_socio: 2,
        codigo_qualificacao_socio: 49,
      },
      {
        nome_socio: "BELTRANA DE TAL",
        cnpj_cpf_do_socio: "***654321**",
        qualificacao_socio: "Sócio",
        codigo_qualificacao_socio: 22,
        data_entrada_sociedade: "2025-06-01",
      },
    ],
    cnpj: CNPJ_MATRIZ,
    porte: "MICRO EMPRESA",
    municipio: "CIDADE FICTICIA",
    cnae_fiscal: 6201501,
    razao_social: "EMPRESA FICTICIA SERVICOS LTDA",
    nome_fantasia: "FICTICIA",
    capital_social: 50000,
    opcao_pelo_mei: false,
    cnaes_secundarios: [
      { codigo: 6209100, descricao: "Suporte técnico, manutenção e outros serviços em tecnologia da informação" },
      { codigo: 111301, descricao: "Cultivo de arroz" },
      { codigo: 8299799, descricao: "Outras atividades de serviços prestados principalmente às empresas" },
    ],
    natureza_juridica: "Sociedade Empresária Limitada",
    regime_tributario: [],
    opcao_pelo_simples: true,
    situacao_cadastral: 2,
    data_opcao_pelo_mei: null,
    data_exclusao_do_mei: null,
    cnae_fiscal_descricao: "Desenvolvimento de programas de computador sob encomenda",
    codigo_municipio_ibge: 4202305,
    data_inicio_atividade: "2025-04-30",
    data_opcao_pelo_simples: "2025-04-30",
    codigo_natureza_juridica: 2062,
    data_exclusao_do_simples: null,
    identificador_matriz_filial: 1,
    descricao_situacao_cadastral: "ATIVA",
    ...overrides,
  };
}
