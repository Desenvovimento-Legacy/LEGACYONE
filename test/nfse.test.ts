import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { AdnError, parseLote, type AdnLote, type NfseDistribution } from "../src/integrations/nfse/adn.js";
import { summarizeNfse } from "../src/integrations/nfse/nfse-parse.js";
import { NFSE_IDLE_MINUTES, nfseList, syncEntityNfse } from "../src/modules/documents/nfse-sync.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const nfse = (n: string, prest: string, toma: string, v: string, ret = "1") =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00"><infNFSe Id="NFS42025002${n.padStart(41, "0")}"><xLocEmi>Biguaçu</xLocEmi><xLocIncid>Biguaçu</xLocIncid><nNFSe>${n}</nNFSe><dhProc>2026-09-10T10:00:00-03:00</dhProc><emit><CNPJ>${prest}</CNPJ><xNome>PRESTADOR ${prest}</xNome></emit><valores><vISSQN>20.00</vISSQN><vLiq>980.00</vLiq></valores><DPS versao="1.00"><infDPS Id="DPS1"><dhEmi>2026-09-10T09:00:00-03:00</dhEmi><prest><CNPJ>${prest}</CNPJ></prest><toma><CNPJ>${toma}</CNPJ><xNome>TOMADOR ${toma}</xNome></toma><valores><vServPrest><vServ>${v}</vServ></vServPrest><trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>${ret}</tpRetISSQN></tribMun></trib></valores></infDPS></DPS></infNFSe></NFSe>`;
const item = (nsu: number, xml: string) => ({ NSU: nsu, ChaveAcesso: `K${nsu}`, TipoDocumento: "NFSE", ArquivoXml: gzipSync(Buffer.from(xml)).toString("base64"), DataHoraGeracao: "2026-09-10T10:00:01" });

class FakeAdn implements NfseDistribution {
  calls: number[] = [];
  constructor(private readonly responses: (AdnLote | Error)[]) {}
  async lote(input: { nsu: number }): Promise<AdnLote> {
    this.calls.push(input.nsu);
    const r = this.responses.shift();
    if (!r) throw new Error("sem resposta");
    if (r instanceof Error) throw r;
    return r;
  }
}

describe("NFS-e Nacional (ADN)", () => {
  it("lê lote, 404 sem documento, 429 e certificado recusado", () => {
    const body = JSON.stringify({ StatusProcessamento: "DOCUMENTOS_LOCALIZADOS", LoteDFe: [item(7, nfse("1", CNPJ_MATRIZ, "11222333000181", "1000"))] });
    const l = parseLote(200, body);
    expect(l.docs).toHaveLength(1);
    expect(l.docs[0]).toMatchObject({ nsu: 7, accessKey: "K7" });
    expect(parseLote(404, '{"Erros":[{"Codigo":"E2220","Descricao":"NENHUM_DOCUMENTO_LOCALIZADO"}]}')).toMatchObject({ status: "NENHUM_DOCUMENTO_LOCALIZADO", docs: [] });
    expect(parseLote(429, "", "12")).toMatchObject({ status: "LIMITE", retryAfter: 12 });
    expect(() => parseLote(403, "")).toThrow(AdnError);
  });

  it("lê a NFS-e nacional: prestador, tomador, valores e retenção", () => {
    const s = summarizeNfse(nfse("55", CNPJ_MATRIZ, "11222333000181", "1000", "2"));
    expect(s).toMatchObject({ number: "55", providerDoc: CNPJ_MATRIZ, takerDoc: "11222333000181", serviceValue: "1000.00", netValue: "980.00", issValue: "20.00", issWithheld: true, municipality: "Biguaçu" });
  });

  it("segue o NSU lote a lote; sem documento novo espera 60 min; guarda papel da empresa", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    const adn = new FakeAdn([
      parseLote(200, JSON.stringify({ StatusProcessamento: "DOCUMENTOS_LOCALIZADOS", LoteDFe: [item(1, nfse("1", CNPJ_MATRIZ, "11222333000181", "1000")), item(2, nfse("9", "11222333000181", CNPJ_MATRIZ, "300"))] })),
      parseLote(404, "NENHUM_DOCUMENTO_LOCALIZADO"),
    ]);
    const now = new Date("2026-10-06T20:00:00Z");
    const deps = { appPool, adn, certificates: () => ({ pfx: Buffer.from("x"), passphrase: "y" }), now: () => now, sleep: async () => undefined };
    const r = await syncEntityNfse(deps, t, entityId);
    expect(r).toMatchObject({ outcome: "ok", calls: 2, documents: 2 });
    expect(adn.calls).toEqual([0, 2]);
    expect(r.nextAllowedAt!.getTime() - now.getTime()).toBe(NFSE_IDLE_MINUTES * 60_000);
    expect((await syncEntityNfse(deps, t, entityId)).outcome).toBe("aguardando");
    // Pedido de uma pessoa não espera a pausa da própria IARIS (sem documento novo)
    adn.calls.length = 0;
    (adn as unknown as { responses: unknown[] }).responses.push(parseLote(404, "NENHUM_DOCUMENTO_LOCALIZADO"));
    expect((await syncEntityNfse(deps, t, entityId, { kind: "USER", id: "luan" })).outcome).toBe("ok");
    expect(adn.calls).toEqual([2]);
    await withTenant(appPool, t, async (tx) => {
      const list = await nfseList(tx, entityId);
      expect(list.map((x) => x.role).sort()).toEqual(["PRESTADA", "TOMADA"]);
      const ev = await tx.query("SELECT count(*)::int AS n FROM outbox WHERE type = 'NFSE_BATCH_RECEIVED'");
      expect(ev.rows[0].n).toBe(1);
    });
  });
});
