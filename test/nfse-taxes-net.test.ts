import { describe, expect, it } from "vitest";
import { readNfseTaxes } from "../src/integrations/nfse/nfse-taxes.js";

const nfse = (o: { serv: string; liq: string; totalRet: string; iss?: string; issType?: string; pis?: string; cofins?: string; code?: string }) =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe Id="N1"><valores>${o.iss ? `<vISSQN>${o.iss}</vISSQN>` : ""}<vTotalRet>${o.totalRet}</vTotalRet><vLiq>${o.liq}</vLiq></valores>` +
  `<DPS><infDPS Id="D1"><dCompet>2026-07-03</dCompet><prest><regTrib><opSimpNac>1</opSimpNac></regTrib></prest><serv><cServ><cTribNac>010501</cTribNac></cServ></serv>` +
  `<valores><vServPrest><vServ>${o.serv}</vServ></vServPrest><trib><tribMun><tpRetISSQN>${o.issType ?? "1"}</tpRetISSQN></tribMun><tribFed>` +
  (o.pis ? `<piscofins>${o.code ? `<tpRetPisCofins>${o.code}</tpRetPisCofins>` : ""}<vPis>${o.pis}</vPis><vCofins>${o.cofins}</vCofins></piscofins>` : "") +
  `</tribFed></trib></valores></infDPS></DPS></infNFSe></NFSe>`;

describe("NFS-e: o valor líquido prova a retenção quando o total retido da nota está errado", () => {
  it("ISS do próprio prestador em vTotalRet, sem retenção (líquido = serviço): nada retido", () => {
    const t = readNfseTaxes(nfse({ serv: "350.00", liq: "350.00", totalRet: "7.00", iss: "7.00" }))!;
    expect(t).toMatchObject({ check: "OK", issWithheld: "0.00", csrf: "0.00", totalWithheldCalc: "0.00" });
    expect(t.notes.join(" ")).toMatch(/valor líquido confirma R\$ 0,00/);
  });

  it("PIS/COFINS não cumulativo do prestador em vTotalRet (líquido = serviço): nada retido", () => {
    const t = readNfseTaxes(nfse({ serv: "1117.77", liq: "1117.77", totalRet: "103.39", pis: "18.44", cofins: "84.95" }))!;
    expect(t).toMatchObject({ check: "OK", csrf: "0.00" });
  });

  it("código 2 mas o líquido mostra PIS e COFINS descontados com alíquota de retenção: retidos", () => {
    const t = readNfseTaxes(nfse({ serv: "230.00", liq: "221.60", totalRet: "8.40", pis: "1.50", cofins: "6.90", code: "2" }))!;
    expect(t).toMatchObject({ check: "OK", csrf: "8.40", totalWithheldCalc: "8.40" });
  });

  it("líquido que não confirma nem a soma lida nem o total da nota: continua a conferir", () => {
    const t = readNfseTaxes(nfse({ serv: "1000.00", liq: "980.00", totalRet: "15.00", iss: "15.00" }))!;
    expect(t.check).toBe("DIVERGENTE");
  });
});
