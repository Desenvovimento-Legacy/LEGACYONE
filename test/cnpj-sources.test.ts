import { describe, expect, it } from "vitest";
import { normalizeBrasilApi } from "../src/integrations/cnpj-public/brasilapi.js";
import { normalizeCnpja } from "../src/integrations/cnpj-public/cnpja.js";
import { FallbackCnpjSource } from "../src/integrations/cnpj-public/fallback.js";
import { CnpjNotFoundError, type CnpjPublicDataSource, type PublicCompanyLookup } from "../src/integrations/cnpj-public/types.js";
import { brasilApiResponse, CNPJ_MATRIZ } from "./fixtures/cnpj.js";

/** Mesma empresa fictícia da fixture da BrasilAPI, no formato da CNPJá. */
const cnpjaResponse = {
  taxId: CNPJ_MATRIZ,
  alias: "Ficticia",
  founded: "2025-04-30",
  head: true,
  status: { id: 2, text: "Ativa" },
  company: {
    id: "12ABC345",
    name: "EMPRESA FICTICIA SERVICOS LTDA",
    nature: { id: 2062, text: "Sociedade Empresária Limitada" },
    size: { id: 1, acronym: "ME", text: "Microempresa" },
    simples: { optant: true, since: "2025-04-30", history: [] },
    simei: { optant: false, since: null, history: [] },
    members: [
      {
        since: "2025-04-30",
        person: { name: "Fulano de Tal", taxId: "***123456**", type: "NATURAL" },
        role: { id: 49, text: "Sócio-Administrador" },
      },
      { since: "2025-06-01", person: { name: "Beltrana de Tal", taxId: "***654321**" }, role: { id: 22, text: "Sócio" } },
    ],
  },
  address: { municipality: 4202305, city: "Cidade Ficticia", state: "SC", zip: "88000000" },
  mainActivity: { id: 6201501, text: "Desenvolvimento de programas de computador sob encomenda" },
  sideActivities: [
    { id: 6209100, text: "Suporte técnico, manutenção e outros serviços em tecnologia da informação" },
    { id: 111301, text: "Cultivo de arroz" },
    { id: 8299799, text: "Outras atividades de serviços prestados principalmente às empresas" },
  ],
};

describe("fontes públicas de CNPJ", () => {
  it("BrasilAPI e CNPJá produzem o mesmo perfil normalizado", () => {
    const a = normalizeBrasilApi(brasilApiResponse());
    const b = normalizeCnpja(cnpjaResponse);
    const essentials = (d: typeof a) => ({
      cnpj: d.cnpj,
      legalName: d.legalName,
      status: d.registrationStatus,
      started: d.activityStartedAt,
      nature: d.legalNatureCode,
      head: d.isHeadOffice,
      uf: d.address.uf,
      ibge: d.address.municipioIbge,
      primary: d.primaryCnae.code,
      secondary: d.secondaryCnaes.map((c) => c.code),
      simples: d.simples,
      partners: d.partners.map((p) => [p.name, p.qualificationCode, p.since]),
    });
    expect(essentials(b)).toEqual(essentials(a));
  });

  it("CNPJá: empresa fora do Simples não ganha data de exclusão deduzida", () => {
    const d = normalizeCnpja({
      ...cnpjaResponse,
      company: { ...cnpjaResponse.company, simples: { optant: false, since: "2018-01-01", history: [] } },
    });
    expect(d.simples).toEqual({ optant: false, since: null, excludedAt: null });
  });
});

class Stub implements CnpjPublicDataSource {
  calls = 0;
  constructor(
    readonly name: string,
    private readonly behavior: "ok" | "error" | "notfound",
  ) {}
  async lookup(cnpj: string): Promise<PublicCompanyLookup> {
    this.calls++;
    if (this.behavior === "error") throw new Error("429");
    if (this.behavior === "notfound") throw new CnpjNotFoundError(cnpj);
    return { data: normalizeBrasilApi(brasilApiResponse()), raw: {}, source: this.name, fetchedAt: new Date() };
  }
}

describe("fallback entre fontes", () => {
  it("usa a segunda fonte quando a primeira limita as consultas", async () => {
    const first = new Stub("brasilapi-cnpj", "error");
    const second = new Stub("cnpja-open", "ok");
    const r = await new FallbackCnpjSource([first, second]).lookup(CNPJ_MATRIZ);
    expect(r.source).toBe("cnpja-open");
    expect([first.calls, second.calls]).toEqual([1, 1]);
  });

  it("não consulta a segunda fonte se a primeira responder", async () => {
    const second = new Stub("cnpja-open", "ok");
    await new FallbackCnpjSource([new Stub("brasilapi-cnpj", "ok"), second]).lookup(CNPJ_MATRIZ);
    expect(second.calls).toBe(0);
  });

  it("'não encontrado' só é definitivo quando todas as fontes concordam", async () => {
    await expect(
      new FallbackCnpjSource([new Stub("a", "notfound"), new Stub("b", "notfound")]).lookup(CNPJ_MATRIZ),
    ).rejects.toBeInstanceOf(CnpjNotFoundError);
    await expect(
      new FallbackCnpjSource([new Stub("a", "notfound"), new Stub("b", "error")]).lookup(CNPJ_MATRIZ),
    ).rejects.not.toBeInstanceOf(CnpjNotFoundError);
  });
});
