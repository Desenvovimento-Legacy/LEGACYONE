import { normalizeCnpj } from "../../shared/br/documents.js";
import type {
  FederalPayment,
  FederalPaymentPage,
  IntegraContador,
  IntegraContadorResult,
  PgdasDasIndex,
  PgdasDeclarationIndex,
  PgdasYearIndex,
  PowerOfAttorneyStatus,
} from "./types.js";

export interface FakeContributorData {
  declarations?: PgdasDeclarationIndex[];
  das?: PgdasDasIndex[];
  payments?: FederalPayment[];
}

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
    readonly data: Record<string, FakeContributorData> = {},
  ) {}

  private result<T>(value: T): IntegraContadorResult<T> {
    return { value, raw: { simulated: true, value }, source: this.name, fetchedAt: new Date() };
  }

  async checkPowerOfAttorney(contributorCnpj: string): Promise<IntegraContadorResult<PowerOfAttorneyStatus>> {
    const cnpj = normalizeCnpj(contributorCnpj);
    this.calls.push(`procuracao:${cnpj}`);
    const p = this.powers[cnpj];
    const value: PowerOfAttorneyStatus = {
      contributor: cnpj,
      grantee: this.officeDocument,
      active: Boolean(p),
      grants: p ? [{ validFrom: p.validFrom, validTo: p.validTo ?? null, services: p.services }] : [],
      services: p?.services ?? [],
    };
    return { value, raw: { simulated: true, ...value }, source: this.name, fetchedAt: new Date() };
  }

  async listPgdasDeclarations(contributorCnpj: string, year: number): Promise<IntegraContadorResult<PgdasYearIndex>> {
    const cnpj = normalizeCnpj(contributorCnpj);
    this.calls.push(`pgdas:${cnpj}:${year}`);
    const d = this.data[cnpj] ?? {};
    const inYear = <T extends { competence: string }>(xs: T[] = []) => xs.filter((x) => x.competence.startsWith(`${year}-`));
    return this.result({ contributor: cnpj, year, declarations: inYear(d.declarations), das: inYear(d.das) });
  }

  async listPayments(
    contributorCnpj: string,
    q: { from: string; to: string; first?: number; size?: number },
  ): Promise<IntegraContadorResult<FederalPaymentPage>> {
    const cnpj = normalizeCnpj(contributorCnpj);
    const first = q.first ?? 0;
    const size = q.size ?? 100;
    this.calls.push(`pagamentos:${cnpj}:${q.from}:${q.to}:${first}`);
    const all = (this.data[cnpj]?.payments ?? []).filter((p) => p.collectedOn >= q.from && p.collectedOn <= q.to);
    return this.result({ contributor: cnpj, from: q.from, to: q.to, first, size, payments: all.slice(first, first + size) });
  }
}
