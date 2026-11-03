import { describe, expect, it } from "vitest";
import { ingestFiles } from "../src/modules/documents/xml-intake.js";
import { importBankStatement } from "../src/modules/financial/bank-statements.js";
import { readEntityNfseTaxes, setMunicipalIssDue } from "../src/modules/fiscal/withholdings.js";
import { applyStandardChart } from "../src/modules/ledger/ledger.js";
import { CFOP_RULES_VERSION, CREDIT_RULES_VERSION } from "../src/modules/fiscal/cfop-rules.js";
import { NFE_ITEMS_PARSER } from "../src/integrations/sefaz/nfe-items.js";
import { LocalTaxError, localTaxesOverview, refreshLocalTaxes, setStateIcmsDue } from "../src/modules/tax/local-taxes.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const LUAN: Actor = { kind: "USER", id: "luan" };
type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

/** NFS-e municipal (ABRASF 1.0) PRESTADA pela empresa em Curitiba. */
const note = (n: string, day: string, v: string, rate: string, iss: string, withheld: boolean) =>
  `<CompNfse><Nfse><InfNfse><Numero>${n}</Numero><DataEmissao>${day}T08:00:00</DataEmissao>` +
  `<Servico><Valores><ValorServicos>${v}</ValorServicos><IssRetido>${withheld ? 1 : 2}</IssRetido><BaseCalculo>${v}</BaseCalculo><Aliquota>${rate}</Aliquota><ValorIss>${iss}</ValorIss>` +
  (withheld ? `<ValorIssRetido>${iss}</ValorIssRetido>` : "") +
  `<ValorLiquidoNfse>${withheld ? (Number(v) - Number(iss)).toFixed(2) : v}</ValorLiquidoNfse></Valores><ItemListaServico>17.01</ItemListaServico><CodigoMunicipio>4106902</CodigoMunicipio></Servico>` +
  `<PrestadorServico><IdentificacaoPrestador><Cnpj>${CNPJ_MATRIZ}</Cnpj></IdentificacaoPrestador><RazaoSocial>ALPHA INDUSTRIA LTDA</RazaoSocial></PrestadorServico>` +
  `<TomadorServico><IdentificacaoTomador><CpfCnpj><Cnpj>44555666000177</Cnpj></CpfCnpj></IdentificacaoTomador></TomadorServico>` +
  `<OrgaoGerador><CodigoMunicipio>4106902</CodigoMunicipio><Uf>PR</Uf></OrgaoGerador></InfNfse></Nfse></CompNfse>`;
const ofx = (rows: [string, string, string, string][]) =>
  `OFXHEADER:100\r\n<OFX>\r\n<BANKMSGSRSV1>\r\n<STMTTRNRS>\r\n<STMTRS>\r\n<BANKACCTFROM>\r\n<BANKID>0341\r\n<ACCTID>9-9\r\n</BANKACCTFROM>\r\n<BANKTRANLIST>\r\n<DTSTART>20260901\r\n<DTEND>20260930\r\n` +
  rows.map(([id, d, a, m]) => `<STMTTRN>\r\n<TRNTYPE>OTHER\r\n<DTPOSTED>${d}\r\n<TRNAMT>${a}\r\n<FITID>${id}\r\n<MEMO>${m}\r\n</STMTTRN>\r\n`).join("") +
  `</BANKTRANLIST>\r\n</STMTRS>\r\n</STMTTRNRS>\r\n</BANKMSGSRSV1>\r\n</OFX>\r\n`;

const RULES = `${CFOP_RULES_VERSION}+${CREDIT_RULES_VERSION}`;
let seq = 0;
const key = () => String(++seq).padStart(44, "4");
/** Item de NF-e lido (como o agente Fiscal grava), com o crédito de ICMS quando houver. */
async function item(tx: Tx, entityId: string, o: { comp: string; dir: "ENTRADA" | "SAIDA"; issuer: string; cfop: string; total: string; icms: string; st?: string; entry?: string; credit?: string }) {
  const id = newId();
  await tx.query(
    `INSERT INTO nfe_item (id, tenant_id, entity_id, source, source_id, access_key, model, direction, competence, issuer_doc, n_item, cfop, total,
                           icms_value, st_value, has_st, monophasic, entry_cfop, parser, rules)
     VALUES ($1, current_tenant(), $2, 'XML', $3, $4, '55', $5, $6, $7, 1, $8, $9, $10, $11, $12, false, $13, $14, $15)`,
    [id, entityId, newId(), key(), o.dir, o.comp, o.issuer, o.cfop, o.total, o.icms, o.st ?? "0", Number(o.st ?? 0) > 0, o.entry ?? null, NFE_ITEMS_PARSER, RULES],
  );
  if (o.credit !== undefined)
    await tx.query(
      `INSERT INTO nfe_item_credit (id, tenant_id, entity_id, item_id, tax, regime, status, value, reason, rules)
       VALUES ($1, current_tenant(), $2, $3, 'ICMS', 'LUCRO_PRESUMIDO', 'APROPRIAVEL', $4, 'teste', $5)`,
      [newId(), entityId, id, o.credit, RULES],
    );
}

describe("ISS e ICMS próprios (fora do Simples)", () => {
  it("ISS das NFS-e prestadas sem retenção, por município; prazo pela pessoa; pagamento no extrato", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    await applyStandardChart(appPool, t, entityId, "2026-08-01", LUAN);
    await withTenant(appPool, t, async (tx) => {
      await tx.query(`INSERT INTO tax_regime_history (id, tenant_id, entity_id, regime, valid_from, source) VALUES ($1, current_tenant(), $2, 'LUCRO_PRESUMIDO', '2026-01-01', 'teste')`, [newId(), entityId]);
    });
    await ingestFiles(appPool, t, [
      { name: "a.xml", bytes: Buffer.from(note("1", "2026-08-05", "10000.00", "5.00", "500.00", false)) },
      { name: "b.xml", bytes: Buffer.from(note("2", "2026-08-10", "5000.00", "5.00", "250.00", true)) },
      { name: "c.xml", bytes: Buffer.from(note("3", "2026-08-20", "2000.00", "1.50", "30.00", false)) },
    ], { source: "UPLOAD", actor: LUAN });
    await readEntityNfseTaxes(appPool, t, entityId);
    await refreshLocalTaxes(appPool, t, entityId, "2026-09-05");

    await withTenant(appPool, t, async (tx) => {
      const o = await localTaxesOverview(tx, entityId, "2026-09-05");
      const iss = o.rows.find((r) => r.kind === "ISS")!;
      // 500 + 30 (a nota com ISS retido pelo tomador fica fora)
      expect(iss).toMatchObject({ competence: "2026-08-01", tax: "ISSP:4106902", status: "PRAZO_A_APROVAR", amount: "530.00", due: null, why: "Lucro Presumido" });
      expect(iss.details).toMatchObject({ notes: 3, withheldNotes: 1 });
      expect(iss.checks.join(" ")).toMatch(/abaixo de 2,00%/);
      const p = await tx.query("SELECT type FROM pending_item WHERE entity_id = $1 AND status = 'OPEN'", [entityId]);
      expect(p.rows.map((r) => r.type)).toContain("ISSP_DUE_4106902");
    });

    // prazo de Curitiba para retido e próprio: resolve a pendência do ISS próprio
    await setMunicipalIssDue(appPool, t, { ibge: "4106902", name: "Curitiba", day: 20, adjust: "PREVIOUS_BUSINESS_DAY", legalBasis: "Decreto nº 1.442/2007", appliesTo: "AMBOS" }, LUAN, "2026-09-05");
    await refreshLocalTaxes(appPool, t, entityId, "2026-09-05");
    await withTenant(appPool, t, async (tx) => {
      const iss = (await localTaxesOverview(tx, entityId, "2026-09-05")).rows.find((r) => r.kind === "ISS")!;
      // 20/09/2026 é domingo: antecipa para sexta, 18/09
      expect(iss).toMatchObject({ status: "A_VENCER", due: "2026-09-18", placeName: "Curitiba" });
      expect((await tx.query("SELECT count(*)::int AS n FROM pending_item WHERE entity_id = $1 AND status = 'OPEN' AND type LIKE 'ISSP_DUE_%'", [entityId])).rows[0].n).toBe(0);
      expect((await localTaxesOverview(tx, entityId, "2026-09-25")).rows.find((r) => r.kind === "ISS")!.status).toBe("GUIA_NAO_ENVIADA");
    });

    await importBankStatement(appPool, t, entityId, { name: "set.ofx", bytes: Buffer.from(ofx([
      ["x", "20260918", "-530,00", "PAGTO DAM PREFEITURA CURITIBA"],
    ]), "latin1") }, LUAN);
    await refreshLocalTaxes(appPool, t, entityId, "2026-09-25");
    await withTenant(appPool, t, async (tx) => {
      const iss = (await localTaxesOverview(tx, entityId, "2026-09-25")).rows.find((r) => r.kind === "ISS")!;
      expect(iss).toMatchObject({ status: "PAGO", paid: "530.00", payment: { postedOn: "2026-09-18" } });
      const ev = await tx.query("SELECT payload FROM outbox WHERE type = 'LOCAL_TAX_STATUS_CHANGED' AND payload->>'tax' = 'ISSP:4106902' ORDER BY occurred_at");
      expect(ev.rows.map((r) => r.payload.status)).toEqual(["PRAZO_A_APROVAR", "A_VENCER", "PAGO"]);
    });
  });

  it("Simples sem impedimento não tem ISS próprio; impedido, tem", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    await withTenant(appPool, t, async (tx) => {
      await tx.query(`INSERT INTO tax_regime_history (id, tenant_id, entity_id, regime, valid_from, source) VALUES ($1, current_tenant(), $2, 'SIMPLES_NACIONAL', '2020-01-01', 'teste')`, [newId(), entityId]);
    });
    await ingestFiles(appPool, t, [{ name: "a.xml", bytes: Buffer.from(note("1", "2026-08-05", "10000.00", "5.00", "500.00", false)) }], { source: "UPLOAD", actor: LUAN });
    await readEntityNfseTaxes(appPool, t, entityId);
    await withTenant(appPool, t, async (tx) => {
      expect((await localTaxesOverview(tx, entityId, "2026-09-05")).rows).toEqual([]);
      // o motor do Simples registrou o impedimento na competência
      await tx.query(
        `INSERT INTO simples_calculation (id, tenant_id, entity_id, competence, mode, status, engine_version, inputs, fingerprint)
         VALUES ($1, current_tenant(), $2, '2026-08-01', 'APURACAO', 'CALCULADO', 'simples-1.1.0', $3, 'f1')`,
        [newId(), entityId, JSON.stringify({ localImpeded: "receita do ano anterior acima do sublimite" })],
      );
      const r = (await localTaxesOverview(tx, entityId, "2026-09-05")).rows;
      expect(r).toEqual([expect.objectContaining({ tax: "ISSP:4106902", amount: "500.00", why: expect.stringMatching(/impedido/) })]);
    });
  });

  it("prévia do ICMS: débitos das saídas − créditos das entradas, com saldo credor levado ao mês seguinte", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    await withTenant(appPool, t, async (tx) => {
      await tx.query(`INSERT INTO tax_regime_history (id, tenant_id, entity_id, regime, valid_from, source) VALUES ($1, current_tenant(), $2, 'LUCRO_REAL_TRIMESTRAL', '2026-01-01', 'teste')`, [newId(), entityId]);
      await tx.query(`INSERT INTO establishment (id, tenant_id, entity_id, kind, cnpj, uf, municipio_ibge, opened_at) VALUES ($1, current_tenant(), $2, 'MATRIZ', $3, 'PR', '4106902', '2020-01-01')`, [newId(), entityId, CNPJ_MATRIZ]);
      // julho: compra com crédito maior que a venda → saldo credor
      await item(tx, entityId, { comp: "2026-07-01", dir: "ENTRADA", issuer: "44555666000177", cfop: "5102", total: "10000.00", icms: "1200.00", entry: "1102", credit: "1200.00" });
      await item(tx, entityId, { comp: "2026-07-01", dir: "SAIDA", issuer: CNPJ_MATRIZ, cfop: "5102", total: "5000.00", icms: "900.00" });
      // agosto: venda maior; crédito de ativo fica fora (CIAP) e ST retido aparece à parte
      await item(tx, entityId, { comp: "2026-08-01", dir: "SAIDA", issuer: CNPJ_MATRIZ, cfop: "6102", total: "8000.00", icms: "960.00" });
      await item(tx, entityId, { comp: "2026-08-01", dir: "SAIDA", issuer: CNPJ_MATRIZ, cfop: "5403", total: "1000.00", icms: "180.00", st: "50.00" });
      await item(tx, entityId, { comp: "2026-08-01", dir: "ENTRADA", issuer: "44555666000177", cfop: "5102", total: "2000.00", icms: "240.00", entry: "1102", credit: "240.00" });
      await item(tx, entityId, { comp: "2026-08-01", dir: "ENTRADA", issuer: "44555666000177", cfop: "5102", total: "4800.00", icms: "576.00", entry: "1551", credit: "576.00" });
    });
    await refreshLocalTaxes(appPool, t, entityId, "2026-09-05");
    await withTenant(appPool, t, async (tx) => {
      const o = await localTaxesOverview(tx, entityId, "2026-09-05");
      const by = Object.fromEntries(o.rows.filter((r) => r.kind === "ICMS").map((r) => [r.competence, r]));
      expect(by["2026-07-01"]).toMatchObject({ tax: "ICMS:PR", status: "SALDO_CREDOR", amount: "0.00", details: { debits: "900.00", credits: "1200.00", carryIn: "0.00", carryOut: "300.00" } });
      // 960 + 180 − 240 − 300 = 600
      expect(by["2026-08-01"]).toMatchObject({ status: "PRAZO_A_APROVAR", amount: "600.00", details: { debits: "1140.00", credits: "240.00", carryIn: "300.00", carryOut: "0.00", ciap: "576.00", st: "50.00" } });
      expect(by["2026-08-01"]!.checks.join(" ")).toMatch(/CIAP/);
      expect(by["2026-08-01"]!.checks.join(" ")).toMatch(/ICMS-ST retido/);
      const p = await tx.query("SELECT type FROM pending_item WHERE entity_id = $1 AND status = 'OPEN'", [entityId]);
      expect(p.rows.map((r) => r.type)).toContain("ICMS_DUE_PR");
    });

    await expect(setStateIcmsDue(appPool, t, { uf: "PR", day: 12, adjust: "NEXT_BUSINESS_DAY", legalBasis: "RICMS" }, { kind: "AGENT", id: "tax" }, "2026-09-05")).rejects.toThrow(LocalTaxError);
    await expect(setStateIcmsDue(appPool, t, { uf: "P", day: 12, adjust: "NEXT_BUSINESS_DAY", legalBasis: "RICMS" }, LUAN, "2026-09-05")).rejects.toThrow(/UF/);
    await setStateIcmsDue(appPool, t, { uf: "pr", day: 12, adjust: "NEXT_BUSINESS_DAY", legalBasis: "RICMS/PR (teste)" }, LUAN, "2026-09-05");
    await withTenant(appPool, t, async (tx) => {
      const aug = (await localTaxesOverview(tx, entityId, "2026-09-05")).rows.find((r) => r.kind === "ICMS" && r.competence === "2026-08-01")!;
      expect(aug).toMatchObject({ status: "A_VENCER", due: "2026-09-14" }); // 12/09/2026 é sábado: prorroga para segunda
      expect((await tx.query("SELECT count(*)::int AS n FROM pending_item WHERE entity_id = $1 AND status = 'OPEN' AND type = 'ICMS_DUE_PR'", [entityId])).rows[0].n).toBe(0);
    });
  });
});
