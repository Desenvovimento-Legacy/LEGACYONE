import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { distNsuEnvelope, parseDistResponse, type DfeDistribution, type DistResult } from "../src/integrations/sefaz/dist-dfe.js";
import { summarizeDfe } from "../src/integrations/sefaz/nfe-parse.js";
import { syncEntityDfe, WAIT_MINUTES } from "../src/modules/documents/dfe-sync.js";
import { approveCiencia, cienciaQueue, documentsList } from "../src/modules/documents/documents.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const LUAN: Actor = { kind: "USER", id: "luan" };
const KEY1 = "31261012345678000190550010000012341000012345";
const KEY2 = "31261098765432000110550010000099991000099999";

const resNFe = (key: string, v: string) =>
  `<resNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><chNFe>${key}</chNFe><CNPJ>12345678000190</CNPJ><xNome>FORNECEDOR TESTE LTDA</xNome><IE>123</IE><dhEmi>2026-10-02T10:00:00-03:00</dhEmi><tpNF>1</tpNF><vNF>${v}</vNF><digVal>x</digVal><dhRecbto>2026-10-02T10:00:05-03:00</dhRecbto><nProt>131260000000001</nProt><cSitNFe>1</cSitNFe></resNFe>`;
const procNFe = (key: string) =>
  `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${key}" versao="4.00"><ide><nNF>9999</nNF><dhEmi>2026-10-03T09:00:00-03:00</dhEmi><tpNF>1</tpNF></ide><emit><CNPJ>98765432000110</CNPJ><xNome>OUTRO FORNECEDOR SA</xNome></emit><dest><CNPJ>${CNPJ_MATRIZ}</CNPJ></dest><total><ICMSTot><vNF>250.5</vNF></ICMSTot></total></infNFe></NFe><protNFe versao="4.00"><infProt><chNFe>${key}</chNFe><cStat>100</cStat><nProt>131260000000002</nProt></infProt></protNFe></nfeProc>`;
const zip = (xml: string) => gzipSync(Buffer.from(xml)).toString("base64");

function soap(cStat: string, ult: string, max: string, docs: { nsu: string; schema: string; xml: string }[]) {
  const lote = docs.length
    ? `<loteDistDFeInt>${docs.map((d) => `<docZip NSU="${d.nsu}" schema="${d.schema}">${zip(d.xml)}</docZip>`).join("")}</loteDistDFeInt>`
    : "";
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeDistDFeInteresseResponse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDistDFeInteresseResult><retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>1</tpAmb><verAplic>1.7.6</verAplic><cStat>${cStat}</cStat><xMotivo>motivo ${cStat}</xMotivo><dhResp>2026-10-06T16:00:00-03:00</dhResp><ultNSU>${ult}</ultNSU><maxNSU>${max}</maxNSU>${lote}</retDistDFeInt></nfeDistDFeInteresseResult></nfeDistDFeInteresseResponse></soap:Body></soap:Envelope>`;
}

class FakeDist implements DfeDistribution {
  calls: string[] = [];
  constructor(private readonly responses: (string | Error)[]) {}
  async distNsu(input: { cnpj: string; uf: string; ultNsu: string }): Promise<DistResult> {
    this.calls.push(`${input.uf}:${input.ultNsu}`);
    const r = this.responses.shift();
    if (!r) throw new Error("sem resposta preparada");
    if (r instanceof Error) throw r;
    return parseDistResponse(r);
  }
}

async function entityWithUf() {
  const t = await newTenant();
  const { entityId } = await newEntity(t, CNPJ_MATRIZ);
  await withTenant(appPool, t, (tx) =>
    tx.query(
      `INSERT INTO establishment (id, tenant_id, entity_id, kind, cnpj, uf, municipio_ibge, opened_at)
       VALUES ($1, current_tenant(), $2, 'MATRIZ', $3, 'MG', '3105608', '2020-01-01')`,
      [newId(), entityId, CNPJ_MATRIZ],
    ),
  );
  return { t, entityId };
}

const cert = () => ({ pfx: Buffer.from("x"), passphrase: "y" });

describe("SEFAZ: distribuição de DF-e", () => {
  it("monta o pedido distNSU e lê o lote compactado", () => {
    const env = distNsuEnvelope(CNPJ_MATRIZ, "MG", "12");
    expect(env).toContain("<cUFAutor>31</cUFAutor>");
    expect(env).toContain("<ultNSU>000000000000012</ultNSU>");
    const r = parseDistResponse(soap("138", "000000000000002", "000000000000002", [
      { nsu: "000000000000001", schema: "resNFe_v1.01.xsd", xml: resNFe(KEY1, "1500.00") },
      { nsu: "000000000000002", schema: "procNFe_v4.00.xsd", xml: procNFe(KEY2) },
    ]));
    expect(r).toMatchObject({ statusCode: "138", ultNsu: "000000000000002", maxNsu: "000000000000002" });
    expect(r.docs).toHaveLength(2);
    expect(summarizeDfe(r.docs[0]!.schema, r.docs[0]!.xml)).toMatchObject({ kind: "RES_NFE", accessKey: KEY1, total: "1500.00", situation: "1", issuerName: "FORNECEDOR TESTE LTDA" });
    expect(summarizeDfe(r.docs[1]!.schema, r.docs[1]!.xml)).toMatchObject({ kind: "NFE", accessKey: KEY2, total: "250.50", recipientDoc: CNPJ_MATRIZ, situation: "1" });
  });

  it("segue o NSU enquanto há fila; ao zerar, espera 61 min e não consulta antes", async () => {
    const { t, entityId } = await entityWithUf();
    const dist = new FakeDist([
      soap("138", "000000000000001", "000000000000002", [{ nsu: "000000000000001", schema: "resNFe_v1.01.xsd", xml: resNFe(KEY1, "1500.00") }]),
      soap("138", "000000000000002", "000000000000002", [{ nsu: "000000000000002", schema: "procNFe_v4.00.xsd", xml: procNFe(KEY2) }]),
    ]);
    const now = new Date("2026-10-06T19:00:00Z");
    const deps = { appPool, dist, certificates: cert, now: () => now };
    const r = await syncEntityDfe(deps, t, entityId);
    expect(r).toMatchObject({ outcome: "ok", calls: 2, documents: 2, statusCode: "138" });
    expect(dist.calls).toEqual(["MG:000000000000000", "MG:000000000000001"]);
    expect(r.nextAllowedAt!.getTime() - now.getTime()).toBe(WAIT_MINUTES * 60_000);

    const again = await syncEntityDfe(deps, t, entityId);
    expect(again).toMatchObject({ outcome: "aguardando", calls: 0 });
    expect(dist.calls).toHaveLength(2);

    await withTenant(appPool, t, async (tx) => {
      const docs = await documentsList(tx, { entityId });
      expect(docs.map((d) => d.kind).sort()).toEqual(["NFE", "RES_NFE"]);
      const ev = await tx.query("SELECT count(*)::int AS n FROM outbox WHERE type = 'DFE_BATCH_RECEIVED'");
      expect(ev.rows[0].n).toBe(2);
      // XML original guardado com hash
      const x = await tx.query("SELECT xml, length(sha256) AS h FROM dfe_document WHERE kind = 'RES_NFE'");
      expect(x.rows[0].xml).toContain(KEY1);
      expect(x.rows[0].h).toBe(32);
      // ciência: só o resumo autorizado sem XML completo aguarda
      const q = await cienciaQueue(tx);
      expect(q).toMatchObject([{ entity_id: entityId, n: 1, total: "1500.00" }]);
    });

    await expect(approveCiencia(appPool, t, entityId, { kind: "AGENT", id: "docs" })).rejects.toThrow(/pessoa/);
    expect(await approveCiencia(appPool, t, entityId, LUAN)).toEqual({ approved: 1 });
    expect(await approveCiencia(appPool, t, entityId, LUAN)).toEqual({ approved: 0 });
    await withTenant(appPool, t, async (tx) => {
      expect(await cienciaQueue(tx)).toEqual([]);
      const m = await tx.query("SELECT access_key, event_type, status, actor_id FROM nfe_manifestation");
      expect(m.rows).toEqual([{ access_key: KEY1, event_type: "210210", status: "APROVADA", actor_id: "luan" }]);
    });

    // Depois da espera, retoma do último NSU recebido.
    const later = new Date(now.getTime() + 62 * 60_000);
    dist["responses"].push(soap("137", "000000000000002", "000000000000002", []));
    const r3 = await syncEntityDfe({ ...deps, now: () => later }, t, entityId);
    expect(r3).toMatchObject({ outcome: "ok", calls: 1, documents: 0, statusCode: "137" });
    expect(dist.calls[2]).toBe("MG:000000000000002");
  });

  it("656 não anda o cursor e espera 61 min; falha de rede espera 15 min", async () => {
    const { t, entityId } = await entityWithUf();
    const now = new Date("2026-10-06T19:00:00Z");
    const dist = new FakeDist([soap("656", "000000000000000", "000000000000000", []), new Error("ECONNRESET")]);
    const r = await syncEntityDfe({ appPool, dist, certificates: cert, now: () => now }, t, entityId);
    expect(r).toMatchObject({ outcome: "ok", calls: 1, statusCode: "656" });
    expect(r.nextAllowedAt!.getTime() - now.getTime()).toBe(61 * 60_000);
    const later = new Date(now.getTime() + 62 * 60_000);
    const e = await syncEntityDfe({ appPool, dist, certificates: cert, now: () => later }, t, entityId);
    expect(e).toMatchObject({ outcome: "erro", statusCode: "ERRO" });
    expect(e.nextAllowedAt!.getTime() - later.getTime()).toBe(15 * 60_000);
    expect(dist.calls).toEqual(["MG:000000000000000", "MG:000000000000000"]);
  });

  it("sem certificado não consulta", async () => {
    const { t, entityId } = await entityWithUf();
    const dist = new FakeDist([]);
    const r = await syncEntityDfe({ appPool, dist, certificates: () => null }, t, entityId);
    expect(r.outcome).toBe("sem_certificado");
    expect(dist.calls).toEqual([]);
  });
});
