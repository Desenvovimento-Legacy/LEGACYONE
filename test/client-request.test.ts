import { describe, expect, it } from "vitest";
import { importBankStatement } from "../src/modules/financial/bank-statements.js";
import { applyStandardChart } from "../src/modules/ledger/ledger.js";
import { ClientRequestError, clientRequestView, collectClientNeeds, markRequestSent, monthsLabel, prepareClientRequest } from "../src/modules/relationship/client-request.js";
import { openPendingItem } from "../src/platform/pending/pending.js";
import { newId } from "../src/shared/ids.js";
import { fixMojibake } from "../src/shared/text.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const LUAN: Actor = { kind: "USER", id: "luan@legacy.test" };
const ofx = (start: string, end: string, rows: [string, string, string, string][]) =>
  `OFXHEADER:100\r\n<OFX>\r\n<BANKMSGSRSV1>\r\n<STMTTRNRS>\r\n<STMTRS>\r\n<BANKACCTFROM>\r\n<BANKID>0341\r\n<ACCTID>1-1\r\n</BANKACCTFROM>\r\n<BANKTRANLIST>\r\n<DTSTART>${start}\r\n<DTEND>${end}\r\n` +
  rows.map(([id, d, a, m]) => `<STMTTRN>\r\n<TRNTYPE>OTHER\r\n<DTPOSTED>${d}\r\n<TRNAMT>${a}\r\n<FITID>${id}\r\n<MEMO>${m}\r\n</STMTTRN>\r\n`).join("") +
  `</BANKTRANLIST>\r\n</STMTRS>\r\n</STMTTRNRS>\r\n</BANKMSGSRSV1>\r\n</OFX>\r\n`;

describe("agente de Relacionamento: um pedido consolidado ao cliente", () => {
  it("junta balancete, extratos, comprovantes e esclarecimentos; só versiona quando muda; envio é de pessoa", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    await applyStandardChart(appPool, t, entityId, "2026-07-01", LUAN);
    await withTenant(appPool, t, async (tx) => {
      await tx.query("INSERT INTO partner_history (id, tenant_id, entity_id, name, valid_from, source) VALUES ($1, current_tenant(), $2, 'JOAO SOCIO DA SILVA', '2020-01-01', 'teste')", [newId(), entityId]);
      for (const [type, info] of [["PREV_TRIAL_BALANCE", "Balancete de 06/2026 da contabilidade anterior"], ["BANK_ACCOUNTS", "Informar os bancos da empresa"], ["CORPORATE_DOCUMENTS", "Enviar o contrato social"]]) {
        await openPendingItem(tx, { type: type!, entityId, requiredInformation: info!, responsibleSource: "CLIENT", impact: "teste" }, LUAN);
      }
    });
    await importBankStatement(appPool, t, entityId, { name: "jul1.ofx", bytes: Buffer.from(ofx("20260701", "20260715", [
      ["a", "20260705", "-830,00", "PAGAMENTOS A FORNECEDORES MARIA DAS GRACAS 123.456.789-00"],
      ["b", "20260708", "1500,00", "PIX RECEBIDO FULANO DE TAL"],
      ["s1", "20260709", "-1000,00", "PIX ENVIADO JOAO SOCIO"],
      ["s2", "20260712", "-200,00", "PIX ENVIADO JOAO SOCIO"],
    ]), "latin1") }, LUAN);

    const items = await collectClientNeeds(appPool, t, entityId, "2026-09-05");
    expect(items.map((i) => [i.kind, i.month])).toEqual([
      ["BALANCETE", "2026-07"], // o automático (com a data do saldo) substitui a pendência genérica do onboarding
      ["EXTRATO", "2026-07"],
      ["EXPLICACAO", "2026-07"], // os dois pagamentos ao sócio num item só
      ["COMPROVANTE", "2026-07"],
      ["EXPLICACAO", "2026-07"],
      ["PENDENCIA", null],
    ]);
    expect(items[1]!.text).toMatch(/de 07\/2026 e 08\/2026/);
    expect(items[2]!.text).toMatch(/^Pagamentos para JOAO SOCIO \(R\$\s?1\.000,00 em 09\/07; R\$\s?200,00 em 12\/07 — total R\$\s?1\.200,00\)/);
    expect(items[3]!.text).toMatch(/R\$\s?830,00 em 05\/07 — MARIA DAS GRACAS$/);

    const r1 = await prepareClientRequest(appPool, t, entityId, "2026-09-05");
    expect(r1).toMatchObject({ version: 1, changed: true, items: 6 });
    await withTenant(appPool, t, async (tx) => {
      // os extratos mostram quais são os bancos: a pendência do onboarding se resolve sozinha
      const p = await tx.query("SELECT type, status, resolution FROM pending_item WHERE entity_id = $1 ORDER BY type", [entityId]);
      expect(p.rows.map((x) => [x.type, x.status])).toEqual([["BANK_ACCOUNTS", "RESOLVED"], ["CORPORATE_DOCUMENTS", "OPEN"], ["PREV_TRIAL_BALANCE", "OPEN"]]);
      expect(p.rows[0].resolution).toMatch(/Bancos conhecidos pelos extratos/);
    });
    expect((await prepareClientRequest(appPool, t, entityId, "2026-09-05")).changed).toBe(false);
    await expect(markRequestSent(appPool, t, r1.requestId!, "WHATSAPP", { kind: "AGENT", id: "relationship" })).rejects.toThrow(ClientRequestError);
    await markRequestSent(appPool, t, r1.requestId!, "WHATSAPP", LUAN);

    // chega o resto do extrato de julho: o item muda (só agosto falta) e o pedido ganha versão nova
    await importBankStatement(appPool, t, entityId, { name: "jul2.ofx", bytes: Buffer.from(ofx("20260716", "20260731", [["c", "20260720", "-10,00", "TARIFA BANCARIA"]]), "latin1") }, LUAN);
    const r2 = await prepareClientRequest(appPool, t, entityId, "2026-09-05");
    expect(r2).toMatchObject({ version: 2, changed: true });
    await withTenant(appPool, t, async (tx) => {
      const v = await clientRequestView(tx, entityId);
      expect(v.request!.message).toMatch(/^Olá! Para concluirmos a contabilidade da ALPHA INDÚSTRIA LTDA de 07\/2026 e 08\/2026, precisamos de:/);
      expect(v.request!.message).toMatch(/\*Extratos bancários\*\n• Extrato da conta .* de 08\/2026/);
      expect(v.request!.message).toMatch(/\*Cadastro, acessos e outros documentos\*\n• Enviar o contrato social/);
      expect(v.lastSent).toMatchObject({ version: 1, channel: "WHATSAPP" });
      expect(v.resolvedSinceSent.map((i) => i.kind)).toEqual(["EXTRATO"]);
      expect(v.history.map((h) => h.status)).toEqual(["PREPARADO", "ENVIADO", "PREPARADO"]);
      const ev = await tx.query("SELECT type FROM outbox WHERE type LIKE 'CLIENT_REQUEST_%' ORDER BY occurred_at");
      expect(ev.rows.map((x) => x.type)).toEqual(["CLIENT_REQUEST_PREPARED", "CLIENT_REQUEST_SENT", "CLIENT_REQUEST_PREPARED"]);
    });
    // versão antiga não pode ser marcada como enviada
    await expect(markRequestSent(appPool, t, r1.requestId!, "EMAIL", LUAN)).rejects.toThrow(/mudou/);
  });

  it("textos para o cliente: meses em intervalo e nome corrompido do XML corrigido", () => {
    expect(monthsLabel(["2026-01", "2026-02", "2026-03", "2026-04", "2026-06", "2026-07", "2026-09"])).toBe("01/2026 a 04/2026, 06/2026, 07/2026 e 09/2026");
    expect(monthsLabel(["2025-12", "2026-01"])).toBe("12/2025 e 01/2026");
    expect(fixMojibake("LAB. DE AN\u00C3\u0081LISES CL\u00C3\u008DNICAS")).toBe("LAB. DE ANÁLISES CLÍNICAS");
    // o 0x8D do "Í" se perdeu no caminho (Windows-1252 não tem): "CLÃNICAS"
    expect(fixMojibake("LAB. DE AN\u00C3\u0081LISES CL\u00C3NICAS")).toBe("LAB. DE ANÁLISES CLÍNICAS");
    expect(fixMojibake("ADMINISTRA\u00C3\u0087\u00C3\u0083O")).toBe("ADMINISTRAÇÃO");
    expect(fixMojibake("CONSTRUÇÃO LTDA")).toBe("CONSTRUÇÃO LTDA");
    expect(fixMojibake("MAESTRO LOCADORA DE VEÍCULOS")).toBe("MAESTRO LOCADORA DE VEÍCULOS");
  });
});
