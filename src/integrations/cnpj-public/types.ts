/**
 * Dados cadastrais públicos de um CNPJ, já normalizados para o modelo do
 * Legacy One. Qualquer fonte (BrasilAPI, Receita, provedor pago) devolve
 * este formato, mais a resposta bruta para guardar como evidência.
 */
export interface PublicCompanyData {
  cnpj: string;
  legalName: string;
  tradeName: string | null;
  registrationStatus: string;
  activityStartedAt: string | null;
  legalNatureCode: string;
  legalNature: string;
  size: string | null;
  isHeadOffice: boolean;
  address: {
    uf: string;
    municipioIbge: string;
    municipio: string;
    cep: string | null;
  };
  primaryCnae: { code: string; description: string };
  secondaryCnaes: { code: string; description: string }[];
  simples: { optant: boolean; since: string | null; excludedAt: string | null };
  mei: { optant: boolean; since: string | null; excludedAt: string | null };
  partners: {
    name: string;
    documentMasked: string | null;
    qualificationCode: number | null;
    qualification: string | null;
    since: string | null;
  }[];
}

export interface PublicCompanyLookup {
  data: PublicCompanyData;
  /** Resposta original da fonte, guardada como evidência com hash. */
  raw: unknown;
  source: string;
  fetchedAt: Date;
}

export interface CnpjPublicDataSource {
  readonly name: string;
  lookup(cnpj: string): Promise<PublicCompanyLookup>;
}

export class CnpjNotFoundError extends Error {
  constructor(readonly cnpj: string) {
    super(`CNPJ ${cnpj} não encontrado na base pública`);
    this.name = "CnpjNotFoundError";
  }
}
