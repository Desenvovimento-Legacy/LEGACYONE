/**
 * SERPRO Integra Contador. O escritório consulta dados do contribuinte em nome
 * dele, usando o próprio certificado e a procuração eletrônica do cliente.
 *
 * Esta interface é o contrato que os agentes usam. A implementação real chama a
 * API do SERPRO (OAuth + certificado do escritório, via Credential Vault); a
 * simulada serve para testes e para desenvolver sem consumir a API.
 */
export interface PowerOfAttorneyStatus {
  /** CNPJ do contribuinte (cliente). */
  contributor: string;
  /** CNPJ/CPF de quem recebeu a procuração (o escritório). */
  grantee: string;
  active: boolean;
  validFrom: string | null;
  validTo: string | null;
  /** Serviços cobertos, nos códigos do e-CAC. */
  services: string[];
}

export interface IntegraContadorResult<T> {
  value: T;
  raw: unknown;
  source: string;
  fetchedAt: Date;
}

export interface IntegraContador {
  readonly name: string;
  /** Verifica se o contribuinte outorgou procuração eletrônica ao escritório. */
  checkPowerOfAttorney(contributorCnpj: string): Promise<IntegraContadorResult<PowerOfAttorneyStatus>>;
}

export class IntegraContadorNotConfiguredError extends Error {
  constructor() {
    super("Integra Contador não configurado: credenciais do SERPRO e certificado do escritório ausentes no cofre");
    this.name = "IntegraContadorNotConfiguredError";
  }
}
