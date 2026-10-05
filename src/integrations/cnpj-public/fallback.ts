import { CnpjNotFoundError, type CnpjPublicDataSource, type PublicCompanyLookup } from "./types.js";

/**
 * Consulta as fontes em ordem e devolve a primeira que responder. "Não
 * encontrado" só é definitivo se todas as fontes disserem o mesmo. A fonte
 * usada fica registrada no snapshot de evidência.
 */
export class FallbackCnpjSource implements CnpjPublicDataSource {
  readonly name = "fallback";

  constructor(
    private readonly sources: CnpjPublicDataSource[],
    private readonly log: (msg: string) => void = () => undefined,
  ) {
    if (sources.length === 0) throw new Error("Informe ao menos uma fonte de CNPJ");
  }

  async lookup(cnpj: string): Promise<PublicCompanyLookup> {
    let notFound = 0;
    let lastError: unknown;
    for (const source of this.sources) {
      try {
        return await source.lookup(cnpj);
      } catch (err) {
        if (err instanceof CnpjNotFoundError) notFound++;
        else lastError = err;
        this.log(`${source.name} indisponível para ${cnpj}: ${(err as Error).message}`);
      }
    }
    if (notFound === this.sources.length) throw new CnpjNotFoundError(cnpj);
    throw lastError instanceof Error ? lastError : new Error(`Nenhuma fonte respondeu para o CNPJ ${cnpj}`);
  }
}
