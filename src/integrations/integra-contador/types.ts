/**
 * SERPRO Integra Contador. O escritório consulta dados do contribuinte em nome
 * dele, usando o próprio certificado e a procuração eletrônica do cliente.
 *
 * Esta interface é o contrato que os agentes usam. A implementação real chama a
 * API do SERPRO (OAuth + certificado do escritório, via Credential Vault); a
 * simulada serve para testes e para desenvolver sem consumir a API.
 */
/** Uma procuração eletrônica vigente entre o contribuinte e o escritório. */
export interface PowerOfAttorneyGrant {
  /** O e-CAC não informa o início; quando ausente, vale a data da verificação. */
  validFrom: string | null;
  validTo: string | null;
  /** Serviços cobertos, com o nome do cadastro de procuração do e-CAC. */
  services: string[];
}

export interface PowerOfAttorneyStatus {
  /** CNPJ do contribuinte (cliente, outorgante). */
  contributor: string;
  /** CNPJ/CPF de quem recebeu a procuração (o escritório, outorgado). */
  grantee: string;
  /** Existe ao menos uma procuração não expirada. */
  active: boolean;
  /** Procurações vigentes (uma por data de expiração no e-CAC). */
  grants: PowerOfAttorneyGrant[];
  /** União dos serviços das procurações vigentes. */
  services: string[];
}

export interface IntegraContadorResult<T> {
  value: T;
  raw: unknown;
  source: string;
  fetchedAt: Date;
}

/** Declaração PGDAS-D transmitida (índice; o conteúdo completo vem em PDF). */
export interface PgdasDeclarationIndex {
  /** Competência no dia 1 (AAAA-MM-01). */
  competence: string;
  number: string;
  operation: "ORIGINAL" | "RETIFICADORA";
  /** ISO 8601 com fuso de Brasília. */
  transmittedAt: string | null;
  malha: string | null;
}

export interface PgdasDasIndex {
  competence: string;
  number: string;
  operation: "GERACAO_DAS" | "DAS_AVULSO" | "DAS_MEDIDA_JUDICIAL" | "DAS_COBRANCA" | "OUTRO";
  issuedAt: string | null;
  /** Situação informada pelo PGDAS-D no momento da consulta. */
  paid: boolean | null;
}

export interface PgdasYearIndex {
  contributor: string;
  year: number;
  declarations: PgdasDeclarationIndex[];
  das: PgdasDasIndex[];
}

/** Documento de arrecadação pago (PagtoWeb). Valores em texto decimal com 2 casas. */
export interface FederalPayment {
  documentNumber: string;
  documentTypeCode: string | null;
  documentType: string | null;
  competence: string | null;
  collectedOn: string;
  dueOn: string | null;
  revenueCode: string | null;
  revenueDescription: string | null;
  total: string;
  principal: string | null;
  fine: string | null;
  interest: string | null;
  breakdown: {
    revenueCode: string | null;
    revenueDescription: string | null;
    competence: string | null;
    dueOn: string | null;
    total: string | null;
    principal: string | null;
    fine: string | null;
    interest: string | null;
  }[];
}

export interface FederalPaymentPage {
  contributor: string;
  from: string;
  to: string;
  first: number;
  size: number;
  payments: FederalPayment[];
}

export interface IntegraContador {
  readonly name: string;
  /** Verifica se o contribuinte outorgou procuração eletrônica ao escritório. */
  checkPowerOfAttorney(contributorCnpj: string): Promise<IntegraContadorResult<PowerOfAttorneyStatus>>;
  /** PGDAS-D: declarações e DAS do ano-calendário (CONSDECLARACAO13). */
  listPgdasDeclarations(contributorCnpj: string, year: number): Promise<IntegraContadorResult<PgdasYearIndex>>;
  /** PGDAS-D: declarações e DAS de um período de apuração AAAAMM (CONSDECLARACAO13). */
  listPgdasPeriod(contributorCnpj: string, period: string): Promise<IntegraContadorResult<PgdasYearIndex>>;
  /** PagtoWeb: pagamentos por data de arrecadação, paginado (PAGAMENTOS71). */
  listPayments(
    contributorCnpj: string,
    q: { from: string; to: string; first?: number; size?: number },
  ): Promise<IntegraContadorResult<FederalPaymentPage>>;
}

export class IntegraContadorNotConfiguredError extends Error {
  constructor() {
    super("Integra Contador não configurado: credenciais do SERPRO e certificado do escritório ausentes no cofre");
    this.name = "IntegraContadorNotConfiguredError";
  }
}
