import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { importBankStatement } from "../src/modules/financial/bank-statements.js";
import { classifyMovement, federalItemAccount, pendingMovements, runAutoPosting } from "../src/modules/ledger/auto-posting.js";
import { applyStandardChart, LedgerError, trialBalance } from "../src/modules/ledger/ledger.js";
import { storeExternalSnapshot } from "../src/platform/evidence/snapshot.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const LUAN: Actor = { kind: "USER", id: "luan@legacy.test" };

const trn = (type: string, date: string, amount: string, fit: string, memo: string) =>
  `<STMTTRN>\r\n<TRNTYPE>${type}\r\n<DTPOSTED>${date}\r\n<TRNAMT>${amount}\r\n<FITID>${fit}\r\n<MEMO>${memo}\r\n</STMTTRN>\r\n`;
const ofx = (trns: string) => Buffer.from(
  `OFXHEADER:100\r\nDATA:OFXSGML\r\nCHARSET:1252\r\n\r\n<OFX>\r\n<BANKMSGSRSV1>\r\n<STMTTRNRS>\r\n<STMTRS>\r\n<CURDEF>BRL\r\n<BANKACCTFROM>\r\n<BANKID>0341\r\n<BRANCHID>6157\r\n<ACCTID>74251-8\r\n</BANKACCTFROM>\r\n` +
  `<BANKTRANLIST>\r\n<DTSTART>20260901\r\n<DTEND>20260930\r\n${trns}</BANKTRANLIST>\r\n<LEDGERBAL>\r\n<BALAMT>0,00\r\n<DTASOF>20260930\r\n</LEDGERBAL>\r\n</STMTRS>\r\n</STMTTRNRS>\r\n</BANKMSGSRSV1>\r\n</OFX>\r\n`,
  "latin1",
);

describe("contas do DARF por item", () => {
  it("código ou descrição; desconhecido fica para pessoa", () => {
    expect(federalItemAccount("3333", "IRPJ - Simples Nacional")).toBe("2.1.2.01");
    expect(federalItemAccount("1708", null)).toBe("2.1.2.02");
    expect(federalItemAccount(null, "Contribuição empresa, inclusive SIMPLES concomitante, s/ remuner empregados")).toBe("2.1.3.03");
    expect(federalItemAccount("0561", "IRRF - Rendimento do Trabalho Assalariado")).toBe("2.1.3.05");
    expect(federalItemAccount("9999", "Taxa qualquer")).toBeNull();
  });
});

describe("contabilização automática: fiscal e extrato → razão", () => {
  it("monta o razão sozinho e deixa para pessoa só o que não tem hipótese única", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    // Sem plano de contas não lança nada
    expect(await runAutoPosting(appPool, t, entityId)).toMatchObject({ skipped: "sem plano de contas", posted: 0 });

    let nsu = 0;
    const note = (tx: PoolClient, number: string, issued: string, value: string, role = "PRESTADA", event: string | null = null, key = `K${number}`) =>
      tx.query(
        `INSERT INTO nfse_document (id, tenant_id, entity_id, nsu, access_key, role, event_type, number, issued_at, taker_name, service_value, net_value, xml, sha256)
         VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, 'CLIENTE ALFA', $9, $9, '<x/>', $10)`,
        [newId(), entityId, ++nsu, key, role, event, number, `${issued}T10:00:00-03:00`, role === "EVENTO" ? null : value, createHash("sha256").update(`${number}${role}`).digest()],
      );
    const declare = async (tx: PoolClient, number: string, total: string) => {
      const pdf = newId();
      await tx.query("INSERT INTO pgdas_declaration_pdf (id, tenant_id, entity_id, competence, kind, pdf, sha256) VALUES ($1, current_tenant(), $2, '2026-09-01', 'DECLARACAO', $3, $4)",
        [pdf, entityId, Buffer.from(number), createHash("sha256").update(number).digest()]);
      await tx.query(
        `INSERT INTO pgdas_declared_tax (id, tenant_id, entity_id, competence, declaration_number, pdf_id, seq, activity, annex, local_withheld,
                                         revenue, irpj, csll, cofins, pis, cpp, icms, ipi, iss, total, parser)
         VALUES ($1, current_tenant(), $2, '2026-09-01', $3, $4, 1, 'Serviços - Anexo III', 'III', false, 15000, 0, 0, 0, 0, 0, 0, 0, 0, $5, 'pgdas-pdf-2')`,
        [newId(), entityId, number, pdf, total],
      );
    };
    await withTenant(appPool, t, async (tx) => {
      await note(tx, "101", "2026-09-05", "10000.00");
      await note(tx, "102", "2026-09-10", "5000.00");
      await note(tx, "103", "2026-09-12", "3000.00");
      await note(tx, "103", "2026-09-13", "0", "EVENTO", "101101", "K103"); // 103 cancelada
      await note(tx, "099", "2026-08-28", "800.00"); // antes do início do plano: fora
      await declare(tx, "11222333202609001", "1437.15");
      const snap = (await storeExternalSnapshot(tx, { source: "teste", requestKey: "pagtoweb", payload: { a: 1 }, fetchedAt: new Date(), entityId })).id;
      const pay = (doc: string, on: string, code: string, total: string, items: Record<string, string>[]) =>
        tx.query(
          `INSERT INTO federal_payment (id, tenant_id, entity_id, document_number, competence, collected_on, due_on, revenue_code, amount_total, breakdown, source, snapshot_id)
           VALUES ($1, current_tenant(), $2, $3, '2026-08-01', $4, $4, $5, $6, $7, 'teste', $8)`,
          [newId(), entityId, doc, on, code, total, JSON.stringify(items), snap],
        );
      await pay("07202600000000001", "2026-09-19", "3333", "900.00", [{ competence: "2026-08-01", principal: "900.00", revenueDescription: "IRPJ - Simples Nacional" }]);
      await pay("07202600000000002", "2026-09-18", "1410", "403.00", [
        { competence: "2026-08-01", revenueCode: "1082", principal: "300.00", revenueDescription: "Contribuição previdenciária descontada de segurados empregados" },
        { competence: "2026-08-01", revenueCode: "1708", principal: "100.00", fine: "2.00", interest: "1.00", revenueDescription: "IRRF - Remuneração Serviços Prestados por Pessoa Jurídica" },
      ]);
    });
    await applyStandardChart(appPool, t, entityId, "2026-09-01", LUAN);
    await importBankStatement(appPool, t, entityId, {
      name: "itau.ofx",
      bytes: ofx(
        trn("DEBIT", "20260918", "-403,00", "B1", "PAGTO DARF") +
        trn("DEBIT", "20260919", "-900,00", "B2", "PAGTO DAS SIMPLES") +
        trn("CREDIT", "20260920", "10.000,00", "B3", "PIX RECEBIDO CLIENTE ALFA") +
        trn("CREDIT", "20260925", "5.000,00", "B4", "TED RECEBIDA CLIENTE ALFA") +
        trn("DEBIT", "20260926", "-35,90", "B5", "TARIFA PACOTE SERVIÇOS") +
        trn("DEBIT", "20260927", "-250,00", "B6", "PAGTO FORNECEDOR XYZ") +
        trn("CREDIT", "20260928", "777,00", "B7", "DEPOSITO") +
        trn("DEBIT", "20260930", "-35,90", "B8", "TARIFA PACOTE SERVICOS"),
      ),
    }, LUAN);

    const r1 = await runAutoPosting(appPool, t, entityId);
    // 2 notas + provisão do Simples + DARF + DAS + 2 recebimentos
    expect(r1).toMatchObject({ skipped: null, posted: 7, reversed: 0, pendingBank: 4 });
    expect(await runAutoPosting(appPool, t, entityId)).toMatchObject({ posted: 0, pendingBank: 4 });

    const pend = await pendingMovements(appPool, t, entityId);
    expect(pend.map((p) => [p.memo, p.amount])).toEqual([
      ["TARIFA PACOTE SERVIÇOS", "-35.90"], ["PAGTO FORNECEDOR XYZ", "-250.00"], ["DEPOSITO", "777.00"], ["TARIFA PACOTE SERVICOS", "-35.90"],
    ]);
    expect(pend[2]!.reason).toMatch(/Entrada sem nota/);

    // Pessoa classifica a tarifa e cria a regra: a outra tarifa entra sozinha
    await expect(classifyMovement(appPool, t, { transactionId: pend[0]!.id, account: "4.4.1.01", history: "Tarifa bancária" }, { kind: "AGENT", id: "x" })).rejects.toThrow(LedgerError);
    const c = await classifyMovement(appPool, t, { transactionId: pend[0]!.id, account: "4.4.1.01", history: "Tarifa bancária", rule: { pattern: "tarifa pacote", scope: "ESCRITORIO" } }, LUAN);
    expect(c).toMatchObject({ rule: true, alsoPosted: 1 });
    expect((await pendingMovements(appPool, t, entityId)).map((p) => p.memo)).toEqual(["PAGTO FORNECEDOR XYZ", "DEPOSITO"]);

    // Retificadora: provisão anterior estornada e nova lançada
    await withTenant(appPool, t, (tx) => declare(tx, "11222333202609002", "1500.00"));
    expect(await runAutoPosting(appPool, t, entityId)).toMatchObject({ posted: 1, reversed: 1 });

    // Sem PDF da declaração: provisão pelo cálculo que conferiu com o DAS pago; quando a declaração chega, troca.
    await withTenant(appPool, t, (tx) =>
      tx.query(
        `INSERT INTO simples_calculation (id, tenant_id, entity_id, competence, mode, status, engine_version, inputs, total, reference_kind, reference_total, difference, fingerprint)
         VALUES ($1, current_tenant(), $2, '2026-10-01', 'CONFERENCIA', 'CONFERE', 'teste', '{}', 200.00, 'DAS_PAGO', 200.00, 0, 'f1')`,
        [newId(), entityId],
      ),
    );
    expect(await runAutoPosting(appPool, t, entityId)).toMatchObject({ posted: 1, reversed: 0 });
    await withTenant(appPool, t, async (tx) => {
      const pdf = newId();
      await tx.query("INSERT INTO pgdas_declaration_pdf (id, tenant_id, entity_id, competence, kind, pdf, sha256) VALUES ($1, current_tenant(), $2, '2026-10-01', 'DECLARACAO', 'x', $3)",
        [pdf, entityId, createHash("sha256").update("out").digest()]);
      await tx.query(
        `INSERT INTO pgdas_declared_tax (id, tenant_id, entity_id, competence, declaration_number, pdf_id, seq, activity, annex, local_withheld,
                                         revenue, irpj, csll, cofins, pis, cpp, icms, ipi, iss, total, parser)
         VALUES ($1, current_tenant(), $2, '2026-10-01', '11222333202610001', $3, 1, 'Serviços - Anexo III', 'III', false, 1000, 0, 0, 0, 0, 0, 0, 0, 0, 200.00, 'pgdas-pdf-2')`,
        [newId(), entityId, pdf],
      );
    });
    expect(await runAutoPosting(appPool, t, entityId)).toMatchObject({ posted: 1, reversed: 1 });
    expect(await runAutoPosting(appPool, t, entityId)).toMatchObject({ posted: 0, reversed: 0 });

    const tb = await withTenant(appPool, t, (tx) => trialBalance(tx, entityId, "2026-09-01", "2026-09-30"));
    expect(tb.totals.balanced).toBe(true);
    const by = Object.fromEntries(tb.rows.map((r) => [r.code, r.closing]));
    expect(by["3.1.1.01"]).toBe("-15000.00"); // nota 103 cancelada e 099 de agosto fora
    expect(by["1.1.2.01"]).toBe("0.00"); // as duas notas recebidas
    expect(by["2.1.2.01"]).toBe("-600.00"); // provisão 1.500,00 (retificadora) − DAS de agosto 900,00 (saldo herdado)
    expect(by["2.1.2.02"]).toBe("100.00");
    expect(by["2.1.3.03"]).toBe("300.00");
    expect(by["4.4.1.02"]).toBe("3.00");
    expect(by["4.4.1.01"]).toBe("71.80");
    expect(by["1.1.1.02.01"]).toBe("13625.20"); // 15.000 − 403 − 900 − 71,80 (fornecedor e depósito ainda sem classificação)

    await withTenant(appPool, t, async (tx) => {
      const m = await tx.query("SELECT method, count(*)::int AS n FROM bank_match GROUP BY 1 ORDER BY 1");
      expect(m.rows).toEqual([{ method: "NFSE", n: 2 }, { method: "PAGAMENTO_FEDERAL", n: 2 }, { method: "PESSOA", n: 1 }, { method: "REGRA", n: 1 }]);
      const ev = await tx.query("SELECT count(*)::int AS n FROM outbox WHERE type = 'ACCOUNTING_BATCH_POSTED'");
      expect(ev.rows[0].n).toBe(5);
    });
  });
});
