import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { accessMap } from "../src/modules/onboarding/plan.js";
import { PowerError, powerRequirements, powersExpiringSoon, refreshPowerRequirements, registerPower } from "../src/modules/onboarding/powers.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { humanQueue } from "../src/web/ops.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const LUAN: Actor = { kind: "USER", id: "luan@legacy.test" };
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
const plus = (n: number) => {
  const d = new Date(`${today()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

describe("procurações estaduais e municipais", () => {
  it("sabe quais a empresa precisa, pede ao cliente, registra com termo e avisa vencimento", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    await withTenant(appPool, t, async (tx) => {
      await tx.query(
        `INSERT INTO establishment (id, tenant_id, entity_id, kind, cnpj, uf, municipio_ibge, opened_at)
         VALUES ($1, current_tenant(), $2, 'MATRIZ', $3, 'MG', '3105608', '2020-01-01')`,
        [newId(), entityId, CNPJ_MATRIZ],
      );
    });
    // Sem serviço Fiscal contratado: nada exigido
    expect(await withTenant(appPool, t, (tx) => powerRequirements(tx, entityId))).toEqual([]);

    await withTenant(appPool, t, async (tx) => {
      await tx.query("INSERT INTO contracted_service_history (id, tenant_id, entity_id, service, valid_from, source) VALUES ($1, current_tenant(), $2, 'FISCAL', '2026-01-01', 'teste')", [newId(), entityId]);
      const pdf = newId();
      await tx.query("INSERT INTO pgdas_declaration_pdf (id, tenant_id, entity_id, competence, kind, pdf, sha256) VALUES ($1, current_tenant(), $2, '2026-08-01', 'DECLARACAO', 'x', $3)",
        [pdf, entityId, createHash("sha256").update("p").digest()]);
      await tx.query(
        `INSERT INTO pgdas_declared_tax (id, tenant_id, entity_id, competence, declaration_number, pdf_id, seq, activity, annex, local_withheld,
                                         revenue, irpj, csll, cofins, pis, cpp, icms, ipi, iss, total, parser)
         VALUES ($1, current_tenant(), $2, '2026-08-01', '1', $3, 1, 'Revenda de mercadorias', 'I', false, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'pgdas-pdf-2')`,
        [newId(), entityId, pdf],
      );
      await tx.query(
        `INSERT INTO nfse_document (id, tenant_id, entity_id, nsu, role, issued_at, service_value, xml, sha256)
         VALUES ($1, current_tenant(), $2, 1, 'PRESTADA', now(), 100, '<x/>', $3)`,
        [newId(), entityId, createHash("sha256").update("n").digest()],
      );
    });
    const req = await withTenant(appPool, t, (tx) => powerRequirements(tx, entityId));
    expect(req.map((r) => [r.system, r.jurisdiction, r.status])).toEqual([["SEFAZ", "MG", "FALTA"], ["PREFEITURA", "3105608", "FALTA"]]);
    expect(req[0]!.name).toBe("SEFAZ-MG");

    expect(await refreshPowerRequirements(appPool, t, entityId)).toMatchObject({ required: 2, opened: 2 });
    expect(await refreshPowerRequirements(appPool, t, entityId)).toMatchObject({ opened: 0 });
    await withTenant(appPool, t, async (tx) => {
      const p = await tx.query("SELECT type, responsible_source FROM pending_item WHERE entity_id = $1 AND status = 'OPEN' ORDER BY type", [entityId]);
      expect(p.rows).toEqual([{ type: "PROCURACAO_PREFEITURA", responsible_source: "CLIENT" }, { type: "PROCURACAO_SEFAZ", responsible_source: "CLIENT" }]);
    });

    await expect(registerPower(appPool, t, { entityId, system: "PREFEITURA", validFrom: "2026-01-01", validTo: null, protocol: null, scopes: [], file: null }, { kind: "AGENT", id: "x" })).rejects.toThrow(PowerError);
    // Prefeitura: termo anexado, vence em 10 dias
    await registerPower(appPool, t, { entityId, system: "PREFEITURA", validFrom: "2026-01-01", validTo: plus(10), protocol: "PR-123", scopes: ["NFS-e", "ISS"],
      file: { name: "termo.pdf", bytes: Buffer.from("%PDF-1.4 termo") } }, LUAN);
    // SEFAZ: declarada, já vencida
    await registerPower(appPool, t, { entityId, system: "SEFAZ", validFrom: "2025-01-01", validTo: plus(-1), protocol: null, scopes: [], file: null }, LUAN);

    const after = await withTenant(appPool, t, (tx) => powerRequirements(tx, entityId));
    expect(after.map((r) => [r.system, r.status, r.current?.verification])).toEqual([["SEFAZ", "VENCIDA", "DECLARACAO"], ["PREFEITURA", "VENCE_EM_BREVE", "DOCUMENTO"]]);
    await withTenant(appPool, t, async (tx) => {
      const p = await tx.query("SELECT type, status FROM pending_item WHERE entity_id = $1 ORDER BY type", [entityId]);
      expect(p.rows).toEqual([{ type: "PROCURACAO_PREFEITURA", status: "RESOLVED" }, { type: "PROCURACAO_SEFAZ", status: "OPEN" }]);
      expect((await powersExpiringSoon(tx)).map((x) => x.name)).toEqual([expect.stringMatching(/^Prefeitura de /)]);
      const q = (await humanQueue(tx)).filter((x) => x.kind === "power");
      expect(q).toHaveLength(1);
      const acc = await accessMap(tx, entityId);
      expect(acc.find((a) => a.system === "SEFAZ-MG (procuração)")).toMatchObject({ status: "PENDENTE", detail: expect.stringMatching(/vencida/) });
      const doc = await tx.query("SELECT file_name, document_sha256 IS NOT NULL AS sha FROM power_of_attorney WHERE system = 'PREFEITURA'");
      expect(doc.rows[0]).toEqual({ file_name: "termo.pdf", sha: true });
      const ev = await tx.query("SELECT count(*)::int AS n FROM outbox WHERE type = 'POWER_OF_ATTORNEY_REGISTERED'");
      expect(ev.rows[0].n).toBe(2);
    });
  });
});
