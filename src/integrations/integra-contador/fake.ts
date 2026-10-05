import { normalizeCnpj } from "../../shared/br/documents.js";
import type { IntegraContador, IntegraContadorResult, PowerOfAttorneyStatus } from "./types.js";

/**
 * Integra Contador simulado. Responde a partir de um mapa configurado no teste
 * ou no ambiente de desenvolvimento. Nunca usado em produção.
 */
export class FakeIntegraContador implements IntegraContador {
  readonly name = "integra-contador-fake";
  readonly calls: string[] = [];

  constructor(
    private readonly officeDocument: string,
    private readonly powers: Record<string, { services: string[]; validFrom: string; validTo?: string | null }> = {},
  ) {}

  async checkPowerOfAttorney(contributorCnpj: string): Promise<IntegraContadorResult<PowerOfAttorneyStatus>> {
    const cnpj = normalizeCnpj(contributorCnpj);
    this.calls.push(`procuracao:${cnpj}`);
    const p = this.powers[cnpj];
    const value: PowerOfAttorneyStatus = {
      contributor: cnpj,
      grantee: this.officeDocument,
      active: Boolean(p),
      validFrom: p?.validFrom ?? null,
      validTo: p?.validTo ?? null,
      services: p?.services ?? [],
    };
    return { value, raw: { simulated: true, ...value }, source: this.name, fetchedAt: new Date() };
  }
}
