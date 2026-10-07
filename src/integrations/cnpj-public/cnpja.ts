import { z } from "zod";
import { isValidCnpj, normalizeCnpj } from "../../shared/br/documents.js";
import { CnpjNotFoundError, type CnpjPublicDataSource, type PublicCompanyLookup } from "./types.js";

/** Formato de https://open.cnpja.com/office/{cnpj} (API aberta da CNPJá, campos usados). */
const CnpjaOffice = z.object({
  taxId: z.string(),
  alias: z.string().nullish(),
  founded: z.string().nullish(),
  head: z.boolean(),
  status: z.object({ text: z.string() }),
  company: z.object({
    name: z.string(),
    nature: z.object({ id: z.number(), text: z.string() }),
    size: z.object({ text: z.string() }).nullish(),
    simples: z.object({ optant: z.boolean(), since: z.string().nullish() }).nullish(),
    simei: z.object({ optant: z.boolean(), since: z.string().nullish() }).nullish(),
    members: z
      .array(
        z.object({
          since: z.string().nullish(),
          person: z.object({ name: z.string(), taxId: z.string().nullish() }),
          role: z.object({ id: z.number(), text: z.string() }).nullish(),
        }),
      )
      .default([]),
  }),
  address: z.object({
    municipality: z.number(),
    city: z.string(),
    state: z.string(),
    zip: z.string().nullish(),
  }),
  mainActivity: z.object({ id: z.number(), text: z.string() }),
  sideActivities: z.array(z.object({ id: z.number(), text: z.string() })).default([]),
});

const cnae = (n: number) => String(n).padStart(7, "0");

/**
 * Converte a resposta da CNPJá no formato normalizado. A CNPJá não informa a
 * data de exclusão do Simples de forma inequívoca: quando a empresa não é
 * optante, o regime vira pendência em vez de ser deduzido.
 */
export function normalizeCnpja(raw: unknown): PublicCompanyLookup["data"] {
  const r = CnpjaOffice.parse(raw);
  const simplesOptant = r.company.simples?.optant === true;
  const meiOptant = r.company.simei?.optant === true;
  return {
    cnpj: normalizeCnpj(r.taxId),
    legalName: r.company.name.trim(),
    tradeName: r.alias?.trim() ? r.alias.trim().toUpperCase() : null,
    registrationStatus: r.status.text.toUpperCase(),
    activityStartedAt: r.founded ?? null,
    legalNatureCode: String(r.company.nature.id),
    legalNature: r.company.nature.text,
    size: r.company.size?.text ?? null,
    isHeadOffice: r.head,
    address: {
      uf: r.address.state,
      municipioIbge: String(r.address.municipality).padStart(7, "0"),
      municipio: r.address.city.toUpperCase(),
      cep: r.address.zip ?? null,
    },
    primaryCnae: { code: cnae(r.mainActivity.id), description: r.mainActivity.text },
    secondaryCnaes: r.sideActivities.map((a) => ({ code: cnae(a.id), description: a.text })),
    simples: { optant: simplesOptant, since: simplesOptant ? (r.company.simples?.since ?? null) : null, excludedAt: null },
    mei: { optant: meiOptant, since: meiOptant ? (r.company.simei?.since ?? null) : null, excludedAt: null },
    partners: r.company.members.map((m) => ({
      name: m.person.name.toUpperCase(),
      documentMasked: m.person.taxId ?? null,
      qualificationCode: m.role?.id ?? null,
      qualification: m.role?.text ?? null,
      since: m.since ?? null,
    })),
  };
}

/** API aberta da CNPJá (dados abertos da Receita), sem chave. */
export class CnpjaOpenSource implements CnpjPublicDataSource {
  readonly name = "cnpja-open";

  constructor(private readonly baseUrl = "https://open.cnpja.com/office") {}

  async lookup(input: string): Promise<PublicCompanyLookup> {
    const cnpj = normalizeCnpj(input);
    if (!isValidCnpj(cnpj)) throw new Error(`CNPJ inválido: ${input}`);
    const res = await fetch(`${this.baseUrl}/${cnpj}`, {
      signal: AbortSignal.timeout(30_000),
      headers: { accept: "application/json", "user-agent": "iaris/0.1 (+https://github.com/Desenvovimento-Legacy)" },
    });
    if (res.status === 404) throw new CnpjNotFoundError(cnpj);
    if (!res.ok) throw new Error(`CNPJá respondeu ${res.status} para o CNPJ ${cnpj}`);
    const raw: unknown = await res.json();
    return { data: normalizeCnpja(raw), raw, source: this.name, fetchedAt: new Date() };
  }
}
