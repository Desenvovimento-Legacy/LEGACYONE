import { normalizeCnpj } from "../../shared/br/documents.js";
import type {
  FederalPayment,
  FederalPaymentPage,
  IntegraContador,
  IntegraContadorResult,
  PgdasDasIndex,
  PgdasDeclarationIndex,
  PgdasLastDeclaration,
  PgdasYearIndex,
  PowerOfAttorneyStatus,
} from "./types.js";

export interface FakeContributorData {
  declarations?: PgdasDeclarationIndex[];
  das?: PgdasDasIndex[];
  payments?: FederalPayment[];
  /** PDF da última declaração por PA (AAAAMM). */
  lastDeclarations?: Record<string, { number: string; pdf: Buffer }>;
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

  async listPgdasPeriod(contributorCnpj: string, period: string): Promise<IntegraContadorResult<PgdasYearIndex>> {
    const cnpj = normalizeCnpj(contributorCnpj);
    this.calls.push(`pgdas-pa:${cnpj}:${period}`);
    const d = this.data[cnpj] ?? {};
    const comp = `${period.slice(0, 4)}-${period.slice(4, 6)}-01`;
    const inPa = <T extends { competence: string }>(xs: T[] = []) => xs.filter((x) => x.competence === comp);
    return this.result({ contributor: cnpj, year: Number(period.slice(0, 4)), declarations: inPa(d.declarations), das: inPa(d.das) });
  }

  async lastPgdasDeclaration(contributorCnpj: string, period: string): Promise<IntegraContadorResult<PgdasLastDeclaration>> {
    const cnpj = normalizeCnpj(contributorCnpj);
    this.calls.push(`pgdas-ultima:${cnpj}:${period}`);
    const d = this.data[cnpj]?.lastDeclarations?.[period];
    return {
      value: { contributor: cnpj, period, declarationNumber: d?.number ?? null, declarationPdf: d?.pdf ?? null, receiptPdf: null },
      raw: { simulated: true, period, number: d?.number ?? null },
      source: this.name,
      fetchedAt: new Date(),
    };
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
