import { describe, expect, it } from "vitest";
import { importBankStatement } from "../src/modules/financial/bank-statements.js";
import { applyStandardChart } from "../src/modules/ledger/ledger.js";
import { ClientRequestError, clientRequestView, collectClientNeeds, markRequestSent, prepareClientRequest } from "../src/modules/relationship/client-request.js";
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
    await importBankStatement(appPool, t, entityId, { name: "jul1.ofx", bytes: Buffer.from(ofx("20260701", "20260715", [
      ["a", "20260705", "-830,00", "PIX ENVIADO MARIA DAS GRACAS"],
      ["b", "20260708", "1500,00", "PIX RECEBIDO FULANO DE TAL"],
    ]), "latin1") }, LUAN);

    const items = await collectClientNeeds(appPool, t, entityId, "2026-09-05");
    expect(items.map((i) => [i.kind, i.month])).toEqual([
      ["BALANCETE", "2026-07"],
      ["EXTRATO", "2026-07"],
      ["COMPROVANTE", "2026-07"],
      ["EXPLICACAO", "2026-07"],
    ]);
    expect(items[1]!.text).toMatch(/de 07\/2026, 08\/2026/);
    expect(items[2]!.text).toMatch(/R\$\s?830,00 em 05\/07/);

    const r1 = await prepareClientRequest(appPool, t, entityId, "2026-09-05");
    expect(r1).toMatchObject({ version: 1, changed: true, items: 4 });
    expect((await prepareClientRequest(appPool, t, entityId, "2026-09-05")).changed).toBe(false);
    await expect(markRequestSent(appPool, t, r1.requestId!, "WHATSAPP", { kind: "AGENT", id: "relationship" })).rejects.toThrow(ClientRequestError);
    await markRequestSent(appPool, t, r1.requestId!, "WHATSAPP", LUAN);

    // chega o resto do extrato de julho: o item muda (só agosto falta) e o pedido ganha versão nova
    await importBankStatement(appPool, t, entityId, { name: "jul2.ofx", bytes: Buffer.from(ofx("20260716", "20260731", [["c", "20260720", "-10,00", "TARIFA BANCARIA"]]), "latin1") }, LUAN);
    const r2 = await prepareClientRequest(appPool, t, entityId, "2026-09-05");
    expect(r2).toMatchObject({ version: 2, changed: true });
    await withTenant(appPool, t, async (tx) => {
      const v = await clientRequestView(tx, entityId);
      expect(v.request!.message).toMatch(/^Olá! Para concluirmos a contabilidade da ALPHA INDÚSTRIA LTDA de 07\/2026, 08\/2026, precisamos de:/);
      expect(v.request!.message).toMatch(/\*Extratos bancários\*\n• Extrato da conta .* de 08\/2026/);
      expect(v.lastSent).toMatchObject({ version: 1, channel: "WHATSAPP" });
      expect(v.resolvedSinceSent.map((i) => i.kind)).toEqual(["EXTRATO"]);
      expect(v.history.map((h) => h.status)).toEqual(["PREPARADO", "ENVIADO", "PREPARADO"]);
      const ev = await tx.query("SELECT type FROM outbox WHERE type LIKE 'CLIENT_REQUEST_%' ORDER BY occurred_at");
      expect(ev.rows.map((x) => x.type)).toEqual(["CLIENT_REQUEST_PREPARED", "CLIENT_REQUEST_SENT", "CLIENT_REQUEST_PREPARED"]);
    });
    // versão antiga não pode ser marcada como enviada
    await expect(markRequestSent(appPool, t, r1.requestId!, "EMAIL", LUAN)).rejects.toThrow(/mudou/);
  });
});
