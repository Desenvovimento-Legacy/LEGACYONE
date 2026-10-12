import { describe, expect, it } from "vitest";
import { importBankStatement } from "../src/modules/financial/bank-statements.js";
import { ingestFiles } from "../src/modules/documents/xml-intake.js";
import { applyStandardChart } from "../src/modules/ledger/ledger.js";
import { IssDueError, readEntityNfseTaxes, refreshWithholdings, setMunicipalIssDue, withholdingsOverview } from "../src/modules/fiscal/withholdings.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const LUAN: Actor = { kind: "USER", id: "luan" };
/** NFS-e municipal (ABRASF 1.0) tomada pela empresa, com ISS retido de São Paulo. */
const note = (n: string, day: string, v: string, iss: string) =>
  `<CompNfse><Nfse><InfNfse><Numero>${n}</Numero><DataEmissao>${day}T08:00:00</DataEmissao>` +
  `<Servico><Valores><ValorServicos>${v}</ValorServicos><IssRetido>1</IssRetido><ValorIss>${iss}</ValorIss><ValorIssRetido>${iss}</ValorIssRetido><ValorLiquidoNfse>${(Number(v) - Number(iss)).toFixed(2)}</ValorLiquidoNfse></Valores><ItemListaServico>7.10</ItemListaServico><CodigoMunicipio>3550308</CodigoMunicipio></Servico>` +
  `<PrestadorServico><IdentificacaoPrestador><Cnpj>44555666000177</Cnpj></IdentificacaoPrestador><RazaoSocial>LIMPEZA BOA LTDA</RazaoSocial></PrestadorServico>` +
  `<TomadorServico><IdentificacaoTomador><CpfCnpj><Cnpj>${CNPJ_MATRIZ}</Cnpj></CpfCnpj></IdentificacaoTomador></TomadorServico>` +
  `<OrgaoGerador><CodigoMunicipio>3550308</CodigoMunicipio><Uf>SP</Uf></OrgaoGerador></InfNfse></Nfse></CompNfse>`;
const ofx = (rows: [string, string, string, string][]) =>
  `OFXHEADER:100\r\n<OFX>\r\n<BANKMSGSRSV1>\r\n<STMTTRNRS>\r\n<STMTRS>\r\n<BANKACCTFROM>\r\n<BANKID>0341\r\n<ACCTID>9-9\r\n</BANKACCTFROM>\r\n<BANKTRANLIST>\r\n<DTSTART>20260101\r\n<DTEND>20260131\r\n` +
  rows.map(([id, d, a, m]) => `<STMTTRN>\r\n<TRNTYPE>OTHER\r\n<DTPOSTED>${d}\r\n<TRNAMT>${a}\r\n<FITID>${id}\r\n<MEMO>${m}\r\n</STMTTRN>\r\n`).join("") +
  `</BANKTRANLIST>\r\n</STMTRS>\r\n</STMTTRNRS>\r\n</BANKMSGSRSV1>\r\n</OFX>\r\n`;

describe("ISS retido nas NFS-e tomadas", () => {
  it("sem prazo do município pede ao escritório; com o prazo acompanha vencimento e acha o recolhimento no extrato", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    await applyStandardChart(appPool, t, entityId, "2025-12-01", LUAN);
    await ingestFiles(appPool, t, [{ name: "dez.xml", bytes: Buffer.from(note("77", "2025-12-03", "500.00", "25.00")) }], { source: "UPLOAD", actor: LUAN });
    await readEntityNfseTaxes(appPool, t, entityId);
    await refreshWithholdings(appPool, t, entityId, "2026-01-05");
    await withTenant(appPool, t, async (tx) => {
      const o = await withholdingsOverview(tx, entityId, "2026-01-05");
      expect(o.rows).toEqual([expect.objectContaining({ competence: "2025-12-01", tax: "ISS:3550308", status: "PRAZO_A_APROVAR", withheld: "25.00", due: null })]);
      expect(o.issMissingDue).toEqual([{ ibge: "3550308", name: "3550308", hint: expect.objectContaining({ day: 10 }) }]);
      const p = await tx.query("SELECT type, responsible_source FROM pending_item WHERE entity_id = $1 AND status = 'OPEN'", [entityId]);
      expect(p.rows).toEqual([{ type: "ISS_DUE_3550308", responsible_source: "OFFICE" }]);
    });

    await expect(setMunicipalIssDue(appPool, t, { ibge: "3550308", name: "São Paulo", day: 10, adjust: "NEXT_BUSINESS_DAY", legalBasis: "Decreto municipal" }, { kind: "AGENT", id: "fiscal" }, "2026-01-05")).rejects.toThrow(IssDueError);
    await expect(setMunicipalIssDue(appPool, t, { ibge: "3550308", name: "São Paulo", day: 10, adjust: "NEXT_BUSINESS_DAY", legalBasis: "" }, LUAN, "2026-01-05")).rejects.toThrow(/fundamento/);
    const s = await setMunicipalIssDue(appPool, t, { ibge: "3550308", name: "São Paulo", day: 10, adjust: "NEXT_BUSINESS_DAY", legalBasis: "Lei municipal (teste)" }, LUAN, "2026-01-05");
    expect(s.entities).toBe(1);
    await withTenant(appPool, t, async (tx) => {
      const o = await withholdingsOverview(tx, entityId, "2026-01-05");
      // 10/01/2026 é sábado: prorroga para segunda, 12/01
      expect(o.rows[0]).toMatchObject({ status: "A_VENCER", due: "2026-01-12", cityName: "São Paulo" });
      expect((await tx.query("SELECT count(*)::int AS n FROM pending_item WHERE entity_id = $1 AND status = 'OPEN'", [entityId])).rows[0].n).toBe(0);
      expect((await withholdingsOverview(tx, entityId, "2026-01-20")).rows[0]!.status).toBe("GUIA_NAO_ENVIADA");
    });

    // o recolhimento aparece no extrato (mesmo valor, histórico de tributo municipal)
    await importBankStatement(appPool, t, entityId, { name: "jan.ofx", bytes: Buffer.from(ofx([
      ["a", "20260108", "-25,00", "PIX ENVIADO FULANO"],
      ["b", "20260112", "-25,00", "PAGTO DAM PREFEITURA SAO PAULO"],
    ]), "latin1") }, LUAN);
    await refreshWithholdings(appPool, t, entityId, "2026-01-20");
    await withTenant(appPool, t, async (tx) => {
      const o = await withholdingsOverview(tx, entityId, "2026-01-20");
      expect(o.rows[0]).toMatchObject({ status: "PAGO", paid: "25.00", payment: { collectedOn: "2026-01-12" } });
      const ev = await tx.query("SELECT payload FROM outbox WHERE type = 'WITHHOLDING_STATUS_CHANGED' ORDER BY occurred_at");
      expect(ev.rows.map((r) => r.payload.to)).toEqual(["PRAZO_A_APROVAR", "A_VENCER", "PAGO"]);
    });
  });
});
