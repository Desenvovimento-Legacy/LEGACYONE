import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readNfseTaxes } from "../src/integrations/nfse/nfse-taxes.js";
import { readEntityNfseTaxes, refreshWithholdings, takenNotes, withholdingsOverview } from "../src/modules/fiscal/withholdings.js";
import { storeExternalSnapshot } from "../src/platform/evidence/snapshot.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { humanQueue } from "../src/web/ops.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

interface NoteSpec {
  serv: string;
  irrf?: string;
  csll?: string;
  cp?: string;
  pis?: string;
  cofins?: string;
  code?: string;
  iss?: string;
  issRet?: "1" | "2" | "3";
  total?: string;
  simples?: "1" | "2" | "3";
  emitted?: string;
  prest?: string;
  toma?: string;
}

const tag = (n: string, v: string | undefined) => (v === undefined ? "" : `<${n}>${v}</${n}>`);
function xml(s: NoteSpec): string {
  const pc = s.pis || s.cofins || s.code
    ? `<piscofins><CST>01</CST>${tag("vPis", s.pis)}${tag("vCofins", s.cofins)}${tag("tpRetPisCofins", s.code)}</piscofins>`
    : "";
  const emitted = s.emitted ?? "2026-08-11T17:14:34-03:00";
  return `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS4202305217889141000100000000000009126081234567890"><xLocIncid>Rio de Janeiro</xLocIncid><cLocIncid>3304557</cLocIncid><nNFSe>91</nNFSe>` +
    `<emit><CNPJ>${s.prest ?? "17889141000100"}</CNPJ><xNome>ADVOCACIA EXEMPLO</xNome></emit>` +
    `<valores>${tag("vISSQN", s.iss)}${tag("vTotalRet", s.total)}<vLiq>0.00</vLiq></valores>` +
    `<IBSCBS><totCIBS><vTotNF>${s.serv}</vTotNF><gIBS><vIBSTot>3.08</vIBSTot></gIBS><gCBS><vCBS>27.72</vCBS></gCBS></totCIBS></IBSCBS>` +
    `<DPS versao="1.01"><infDPS Id="DPS1"><dhEmi>${emitted}</dhEmi><dCompet>${emitted.slice(0, 10)}</dCompet>` +
    `<prest><CNPJ>${s.prest ?? "17889141000100"}</CNPJ><regTrib><opSimpNac>${s.simples ?? "1"}</opSimpNac><regEspTrib>6</regEspTrib></regTrib></prest>` +
    `<toma><CNPJ>${s.toma ?? CNPJ_MATRIZ}</CNPJ><xNome>TOMADORA</xNome></toma>` +
    `<serv><locPrest><cLocPrestacao>3304557</cLocPrestacao></locPrest><cServ><cTribNac>171401</cTribNac><cNBS>113019000</cNBS></cServ></serv>` +
    `<valores><vServPrest><vServ>${s.serv}</vServ></vServPrest><trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>${s.issRet ?? "1"}</tpRetISSQN></tribMun>` +
    `<tribFed>${pc}${tag("vRetCP", s.cp)}${tag("vRetIRRF", s.irrf)}${tag("vRetCSLL", s.csll)}</tribFed></trib></valores></infDPS></DPS></infNFSe></NFSe>`;
}

describe("tributos da NFS-e nacional (NT 007)", () => {
  it("código 3: vRetCSLL é a soma de PIS, COFINS e CSLL; vPis/vCofins são o devido", () => {
    const t = readNfseTaxes(xml({ serv: "3196.59", irrf: "47.95", csll: "148.64", pis: "20.78", cofins: "95.90", code: "3", total: "196.59" }))!;
    expect(t).toMatchObject({ irrf: "47.95", csrf: "148.64", federalWithheld: "196.59", totalWithheldCalc: "196.59", check: "OK", pisDue: "20.78", providerSimples: "1", nationalCode: "171401", ibs: "3.08", cbs: "27.72", serviceDate: "2026-08-11" });
  });

  it("código 1 (leiaute anterior): PIS e COFINS retidos em vPis/vCofins, CSLL em vRetCSLL", () => {
    const t = readNfseTaxes(xml({ serv: "1000.00", irrf: "15.00", csll: "10.00", pis: "6.50", cofins: "30.00", code: "1", total: "61.50" }))!;
    expect(t).toMatchObject({ csrf: "46.50", federalWithheld: "61.50", check: "OK" });
  });

  it("sem código: PIS/COFINS só entram quando o total retido da nota os inclui", () => {
    expect(readNfseTaxes(xml({ serv: "1000.00", irrf: "15.00", csll: "10.00", pis: "6.50", cofins: "30.00", total: "61.50" }))).toMatchObject({ csrf: "46.50", check: "OK" });
    expect(readNfseTaxes(xml({ serv: "1000.00", irrf: "15.00", csll: "10.00", pis: "6.50", cofins: "30.00", total: "25.00" }))).toMatchObject({ csrf: "10.00", check: "OK" });
    // PIS/COFINS não cumulativos do prestador somados ao total: não é retenção, nota a conferir
    const nc = readNfseTaxes(xml({ serv: "31.06", pis: "0.52", cofins: "2.36", total: "2.88" }))!;
    expect(nc).toMatchObject({ csrf: "0.00", check: "DIVERGENTE" });
    expect(nc.notes[0]).toMatch(/PIS 1,67% e COFINS 7,60%/);
  });

  it("ISS retido entra no total; total que não fecha fica DIVERGENTE; sem total fica SEM_TOTAL", () => {
    expect(readNfseTaxes(xml({ serv: "500.00", iss: "10.00", issRet: "2", total: "10.00" }))).toMatchObject({ issWithheld: "10.00", federalWithheld: "0.00", check: "OK" });
    const div = readNfseTaxes(xml({ serv: "1000.00", irrf: "15.00", csll: "46.50", code: "3", total: "70.00" }))!;
    expect(div.check).toBe("DIVERGENTE");
    expect(div.notes.join(" ")).toMatch(/70,00/);
    expect(readNfseTaxes(xml({ serv: "1000.00", irrf: "15.00" }))).toMatchObject({ check: "SEM_TOTAL", federalWithheld: "15.00" });
    expect(readNfseTaxes(xml({ serv: "1000.00" }))).toMatchObject({ check: "OK", federalWithheld: "0.00" });
    expect(readNfseTaxes("<evento/>")).toBeNull();
  });
});

describe("agente Fiscal: retenções das tomadas × DARF", () => {
  it("lê as notas, confere IRRF com o DARF 1708, CSRF sem recolhimento vira Fila humana", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    await withTenant(appPool, t, async (tx) => {
      await tx.query(
        "INSERT INTO contracted_service_history (id, tenant_id, entity_id, service, valid_from, source) VALUES ($1, current_tenant(), $2, 'FISCAL', '2026-05-01', 'teste')",
        [newId(), entityId],
      );
      let nsu = 0;
      const doc = async (role: string, spec: NoteSpec | null, key: string, extra: { event?: string; issued?: string } = {}) => {
        const body = spec ? xml(spec) : `<evento><chNFSe>${key}</chNFSe></evento>`;
        await tx.query(
          `INSERT INTO nfse_document (id, tenant_id, entity_id, nsu, access_key, role, event_type, issued_at, service_value, xml, sha256)
           VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [newId(), entityId, ++nsu, key, role, extra.event ?? null, extra.issued ?? spec?.emitted ?? "2026-08-11T17:14:34-03:00", spec?.serv ?? null, body,
            createHash("sha256").update(body).digest()],
        );
      };
      // 08/2026: duas notas com IRRF e CSRF; uma terceira cancelada
      await doc("TOMADA", { serv: "3196.59", irrf: "47.95", csll: "148.64", pis: "20.78", cofins: "95.90", code: "3", total: "196.59" }, "A1");
      await doc("TOMADA", { serv: "53276.51", irrf: "799.15", csll: "2477.36", pis: "346.30", cofins: "1598.30", code: "3", total: "3276.51", emitted: "2026-08-26T08:36:33-03:00" }, "A2");
      await doc("TOMADA", { serv: "10000.00", irrf: "150.00", csll: "465.00", code: "3", total: "615.00", emitted: "2026-08-20T10:00:00-03:00" }, "A3");
      await doc("EVENTO", null, "A3", { event: "101101", issued: "2026-08-21T10:00:00-03:00" });
      // 07/2026: IRRF abaixo de R$ 10,00 (acumula)
      await doc("TOMADA", { serv: "500.00", irrf: "7.50", total: "7.50", emitted: "2026-07-15T10:00:00-03:00" }, "B1");
      // 09/2026: CSRF de prestador do Simples, prazo 20/10 ainda não chegou
      await doc("TOMADA", { serv: "2000.00", csll: "93.00", code: "3", total: "93.00", simples: "3", emitted: "2026-09-05T10:00:00-03:00" }, "C1");
      // ISS retido no município (só conferência)
      await doc("TOMADA", { serv: "400.00", iss: "8.00", issRet: "2", total: "8.00", emitted: "2026-09-06T10:00:00-03:00" }, "C2");
      // prestada (lida, mas fora das retenções da tomadora)
      await doc("PRESTADA", { serv: "9000.00", prest: CNPJ_MATRIZ, toma: "11222333000181" }, "P1");

      const snap = (await storeExternalSnapshot(tx, { source: "teste", requestKey: "pagtoweb", payload: { a: 1 }, fetchedAt: new Date(), entityId })).id;
      await tx.query(
        `INSERT INTO federal_payment (id, tenant_id, entity_id, document_number, competence, collected_on, due_on, revenue_code, amount_total, breakdown, source, snapshot_id)
         VALUES ($1, current_tenant(), $2, '0720262000000001', '2026-08-01', '2026-09-18', '2026-09-18', '1410', 847.10, $3, 'teste', $4)`,
        [newId(), entityId, JSON.stringify([{ competence: "2026-08-01", revenueCode: "1708", principal: "847.10", revenueDescription: "IRRF - Remuneração Serviços Prestados por Pessoa Jurídica" }]), snap],
      );
    });

    const r1 = await readEntityNfseTaxes(appPool, t, entityId);
    expect(r1).toMatchObject({ read: 7, divergent: 0, skipped: 0 });
    expect(await readEntityNfseTaxes(appPool, t, entityId)).toMatchObject({ read: 0 });

    // Sem a regra de prazo aprovada: retido, prazo a aprovar; o pago já confere.
    const before = await withTenant(appPool, t, (tx) => withholdingsOverview(tx, entityId, "2026-10-07"));
    const by0 = Object.fromEntries(before.rows.map((w) => [`${w.competence.slice(0, 7)}:${w.tax}`, w]));
    expect(by0["2026-08:IRRF"]).toMatchObject({ status: "PAGO", withheld: "847.10", paid: "847.10", notes: 2 });
    expect(by0["2026-08:CSRF"]).toMatchObject({ status: "PRAZO_A_APROVAR", withheld: "2626.00" });

    await withTenant(appPool, t, async (tx) => {
      const rule = await tx.query<{ id: string }>("SELECT id FROM obligation_rule WHERE code = 'RETENCOES_FEDERAIS' ORDER BY version DESC LIMIT 1");
      await tx.query("INSERT INTO obligation_rule_approval (id, tenant_id, rule_id, approved_by) VALUES ($1, current_tenant(), $2, 'luan')", [newId(), rule.rows[0]!.id]);
    });

    const { rows, taken } = await withTenant(appPool, t, (tx) => withholdingsOverview(tx, entityId, "2026-10-07"));
    const by = Object.fromEntries(rows.map((w) => [`${w.competence.slice(0, 7)}:${w.tax}`, w]));
    expect(by["2026-08:IRRF"]).toMatchObject({ status: "PAGO", due: "2026-09-18", dueReason: expect.stringMatching(/domingo/) });
    expect(by["2026-08:CSRF"]).toMatchObject({ status: "PAGAMENTO_NAO_IDENTIFICADO", withheld: "2626.00", paid: null });
    expect(by["2026-07:IRRF"]).toMatchObject({ status: "ABAIXO_DO_MINIMO", withheld: "7.50" });
    expect(by["2026-09:CSRF"]).toMatchObject({ status: "A_VENCER", due: "2026-10-20" });
    expect(by["2026-09:IRRF"]).toBeUndefined();
    const sep = taken.find((m) => m.competence === "2026-09-01")!;
    expect(sep).toMatchObject({ iss: "8.00", fromSimplesProvider: 1, issByCity: [{ city: "Rio de Janeiro", value: "8.00", notes: 1 }] });
    expect(taken.find((m) => m.competence === "2026-08-01")).toMatchObject({ notes: 2, irrf: "847.10" });

    const r2 = await refreshWithholdings(appPool, t, entityId, "2026-10-07");
    expect(r2.changed).toBe(r2.withholdings);
    expect(await refreshWithholdings(appPool, t, entityId, "2026-10-07")).toMatchObject({ changed: 0 });
    // Prazo de 09/2026 passa sem recolhimento: muda de situação.
    expect(await refreshWithholdings(appPool, t, entityId, "2026-10-21")).toMatchObject({ changed: 1 });

    await withTenant(appPool, t, async (tx) => {
      const q = (await humanQueue(tx)).filter((x) => x.kind === "withholding");
      expect(q.map((x) => x.title.replace(/\s/g, " "))).toEqual([
        "PIS/COFINS/CSLL retido 08/2026 (R$ 2.626,00): recolhimento ainda não identificado (vencimento 18/09/2026)",
        "PIS/COFINS/CSLL retido 09/2026 (R$ 93,00): recolhimento ainda não identificado (vencimento 20/10/2026)",
      ]);
      expect(JSON.stringify(q)).not.toMatch(/inadimpl/i);
      const ev = await tx.query("SELECT type, count(*)::int AS n FROM outbox WHERE type IN ('NFSE_TAXES_READ', 'WITHHOLDING_STATUS_CHANGED') GROUP BY 1 ORDER BY 1");
      expect(ev.rows).toEqual([{ type: "NFSE_TAXES_READ", n: 1 }, { type: "WITHHOLDING_STATUS_CHANGED", n: r2.withholdings + 1 }]);
      const notes = await takenNotes(tx, entityId, "2026-08-01");
      expect(notes.map((n) => n.csrf)).toEqual(["148.64", "2477.36"]);
    });
  });
});
