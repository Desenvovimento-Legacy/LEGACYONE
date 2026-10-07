import { z } from "zod";
import { isValidCnpj, normalizeCnpj } from "../../shared/br/documents.js";
import { CnpjNotFoundError, type CnpjPublicDataSource, type PublicCompanyLookup } from "./types.js";

/** Formato da resposta de https://brasilapi.com.br/api/cnpj/v1/{cnpj} (campos usados). */
const BrasilApiCnpj = z.object({
  cnpj: z.string(),
  razao_social: z.string(),
  nome_fantasia: z.string().nullish(),
  descricao_situacao_cadastral: z.string(),
  data_inicio_atividade: z.string().nullish(),
  codigo_natureza_juridica: z.number(),
  natureza_juridica: z.string(),
  porte: z.string().nullish(),
  identificador_matriz_filial: z.number(),
  uf: z.string(),
  municipio: z.string(),
  codigo_municipio_ibge: z.number(),
  cep: z.string().nullish(),
  cnae_fiscal: z.number(),
  cnae_fiscal_descricao: z.string().nullish(),
  cnaes_secundarios: z.array(z.object({ codigo: z.number(), descricao: z.string().nullish() })).default([]),
  opcao_pelo_simples: z.boolean().nullish(),
  data_opcao_pelo_simples: z.string().nullish(),
  data_exclusao_do_simples: z.string().nullish(),
  opcao_pelo_mei: z.boolean().nullish(),
  data_opcao_pelo_mei: z.string().nullish(),
  data_exclusao_do_mei: z.string().nullish(),
  qsa: z
    .array(
      z.object({
        nome_socio: z.string(),
        cnpj_cpf_do_socio: z.string().nullish(),
        codigo_qualificacao_socio: z.number().nullish(),
        qualificacao_socio: z.string().nullish(),
        data_entrada_sociedade: z.string().nullish(),
      }),
    )
    .default([]),
});

const cnae = (n: number) => String(n).padStart(7, "0");
const blankToNull = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);

/** Converte a resposta da BrasilAPI no formato normalizado. Exportado para testes. */
export function normalizeBrasilApi(raw: unknown): PublicCompanyLookup["data"] {
  const r = BrasilApiCnpj.parse(raw);
  return {
    cnpj: normalizeCnpj(r.cnpj),
    legalName: r.razao_social.trim(),
    tradeName: blankToNull(r.nome_fantasia),
    registrationStatus: r.descricao_situacao_cadastral,
    activityStartedAt: blankToNull(r.data_inicio_atividade),
    legalNatureCode: String(r.codigo_natureza_juridica),
    legalNature: r.natureza_juridica,
    size: blankToNull(r.porte),
    isHeadOffice: r.identificador_matriz_filial === 1,
    address: {
      uf: r.uf,
      municipioIbge: String(r.codigo_municipio_ibge).padStart(7, "0"),
      municipio: r.municipio,
      cep: blankToNull(r.cep),
    },
    primaryCnae: { code: cnae(r.cnae_fiscal), description: r.cnae_fiscal_descricao ?? "" },
    secondaryCnaes: r.cnaes_secundarios
      .filter((c) => c.codigo > 0)
      .map((c) => ({ code: cnae(c.codigo), description: c.descricao ?? "" })),
    simples: {
      optant: r.opcao_pelo_simples === true,
      since: blankToNull(r.data_opcao_pelo_simples),
      excludedAt: blankToNull(r.data_exclusao_do_simples),
    },
    mei: {
      optant: r.opcao_pelo_mei === true,
      since: blankToNull(r.data_opcao_pelo_mei),
      excludedAt: blankToNull(r.data_exclusao_do_mei),
    },
    partners: r.qsa.map((p) => ({
      name: p.nome_socio.trim(),
      documentMasked: blankToNull(p.cnpj_cpf_do_socio),
      qualificationCode: p.codigo_qualificacao_socio ?? null,
      qualification: blankToNull(p.qualificacao_socio),
      since: blankToNull(p.data_entrada_sociedade),
    })),
  };
}

/** Fonte pública gratuita (dados abertos da Receita Federal via BrasilAPI). */
export class BrasilApiCnpjSource implements CnpjPublicDataSource {
  readonly name = "brasilapi-cnpj";

  constructor(
    private readonly baseUrl = "https://brasilapi.com.br/api/cnpj/v1",
    private readonly maxAttempts = 5,
    private readonly sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async lookup(input: string): Promise<PublicCompanyLookup> {
    const cnpj = normalizeCnpj(input);
    if (!isValidCnpj(cnpj)) throw new Error(`CNPJ inválido: ${input}`);

    // Base pública gratuita limita a taxa de consultas (429) e oscila (5xx):
    // nova tentativa com espera crescente, respeitando Retry-After.
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${this.baseUrl}/${cnpj}`, {
        signal: AbortSignal.timeout(30_000),
        headers: { accept: "application/json", "user-agent": "iaris/0.1 (+https://github.com/Desenvovimento-Legacy)" },
      });
      if (res.status === 404) throw new CnpjNotFoundError(cnpj);
      if (res.ok) {
        const raw: unknown = await res.json();
        return { data: normalizeBrasilApi(raw), raw, source: this.name, fetchedAt: new Date() };
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= this.maxAttempts) {
        throw new Error(`BrasilAPI respondeu ${res.status} para o CNPJ ${cnpj} (tentativa ${attempt})`);
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** (attempt - 1);
      await this.sleep(Math.min(waitMs, 60_000));
    }
  }
}
