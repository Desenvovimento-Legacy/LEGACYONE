import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runAutoPosting } from "../src/modules/ledger/auto-posting.js";
import { applyStandardChart } from "../src/modules/ledger/ledger.js";
import { grade, isSaleCfop, reviewMonth, reviewOverview, runReview, type ReviewCheck } from "../src/modules/review/review.js";
import type { Actor } from "../src/shared/actor.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const LUAN: Actor = { kind: "USER", id: "luan@legacy.test" };
const TOMADOR = "60611420000136";

const issued = (serv: string, day: string) =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS1"><nNFSe>1</nNFSe><emit><CNPJ>${CNPJ_MATRIZ}</CNPJ><xNome>NOS</xNome></emit>` +
  `<valores><vLiq>${serv}</vLiq></valores><DPS versao="1.01"><infDPS Id="DPS1"><dhEmi>${day}T10:00:00-03:00</dhEmi><dCompet>${day}</dCompet>` +
  `<prest><CNPJ>${CNPJ_MATRIZ}</CNPJ><regTrib><opSimpNac>3</opSimpNac></regTrib></prest><toma><CNPJ>${TOMADOR}</CNPJ></toma>` +
  `<serv><cServ><cTribNac>070201</cTribNac></cServ></serv><valores><vServPrest><vServ>${serv}</vServ></vServPrest><trib><tribMun><tpRetISSQN>1</tpRetISSQN></tribMun>` +
  `<tribFed></tribFed></trib></valores></infDPS></DPS></infNFSe></NFSe>`;

const ck = (status: ReviewCheck["status"], o: Partial<ReviewCheck> = {}): ReviewCheck => ({ key: `k${Math.random()}`, area: "CONTABIL", label: "x", status, detail: "", ...o });

describe("revisão independente", () => {
  it("nota: cobertura, materialidade e risco", () => {
    expect(grade([ck("OK"), ck("OK"), ck("NAO_SE_APLICA")], "10000.00")).toMatchObject({ status: "APROVADA", coverage: "100.00", risk: "BAIXO", materiality: "0.00" });
    expect(grade([ck("OK"), ck("ALERTA", { amount: "-300.00" })], "10000.00")).toMatchObject({ status: "COM_RESSALVAS", coverage: "50.00", risk: "MEDIO", materiality: "300.00" });
    // 5% de 10.000 = 500: acima disso é risco alto
    expect(grade([ck("OK"), ck("ALERTA", { amount: "600.00" }), ck("OK")], "10000.00")).toMatchObject({ coverage: "66.67", risk: "ALTO" });
    // receita grande: teto de R$ 5.000,00
    expect(grade([ck("ALERTA", { amount: "5000.00" })], "1000000.00").risk).toBe("ALTO");
    // pendência tributária é risco alto mesmo pequena
    expect(grade([ck("PENDENTE", { amount: "10.00", critical: true })], "10000.00")).toMatchObject({ status: "PENDENTE", risk: "ALTO" });
    expect(grade([ck("NAO_SE_APLICA")], null)).toMatchObject({ status: "NAO_SE_APLICA", coverage: "0.00" });
    expect(["5102", "6108", "5405", "5933", "7101"].every(isSaleCfop)).toBe(true);
    expect(["5929", "5949", "1102", "5915", null].some(isSaleCfop)).toBe(false);
  });

  it("cruza notas × contábil e Simples × declarado; nova fotografia só quando muda", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t, CNPJ_MATRIZ);
    await withTenant(appPool, t, async (tx) => {
      await tx.query("INSERT INTO tax_regime_history (id, tenant_id, entity_id, regime, valid_from, source) VALUES ($1, current_tenant(), $2, 'SIMPLES_NACIONAL', '2026-01-01', 'teste')", [newId(), entityId]);
      const xml = issued("1000.00", "2026-08-05");
      await tx.query(
        `INSERT INTO nfse_document (id, tenant_id, entity_id, nsu, access_key, role, number, issued_at, provider_doc, provider_name, taker_doc, taker_name, service_value, xml, sha256)
         VALUES ($1, current_tenant(), $2, 1, 'K1', 'PRESTADA', '1', '2026-08-05T10:00:00-03:00', $3, 'NOS', $4, 'CLIENTE', 1000, $5, $6)`,
        [newId(), entityId, CNPJ_MATRIZ, TOMADOR, xml, createHash("sha256").update(xml).digest()],
      );
      await tx.query("UPDATE entity SET activity_started_at = '2026-08-01' WHERE id = $1", [entityId]);
    });
    await applyStandardChart(appPool, t, entityId, "2026-08-01", LUAN);

    let r = await reviewMonth(appPool, t, entityId, "2026-08", "2026-09-15");
    const by = (k: string) => r.checks.find((c) => c.key === k);
    expect(by("fiscal_contabil")).toMatchObject({ area: "FISCAL", status: "ALERTA", amount: "1000.00" });
    expect(by("simples_calculo")).toMatchObject({ status: "ALERTA", detail: expect.stringMatching(/ainda não calculado/) });
    expect(by("das_pagamento")?.status).toBe("NAO_SE_APLICA");
    expect(by("extrato")).toMatchObject({ area: "FINANCEIRO", status: "PENDENTE" });
    expect(r).toMatchObject({ status: "PENDENTE", risk: "MEDIO" });

    expect(await runReview(appPool, t, entityId, "2026-09-15")).toMatchObject({ months: 1, changed: 1, pending: 1 });
    expect(await runReview(appPool, t, entityId, "2026-09-15")).toMatchObject({ changed: 0 });

    // Nota contabilizada: receita das notas = receita do razão
    await runAutoPosting(appPool, t, entityId);
    r = await reviewMonth(appPool, t, entityId, "2026-08", "2026-09-15");
    expect(by("fiscal_contabil")).toMatchObject({ status: "OK", detail: expect.stringMatching(/= contabilizado 1\.000,00/) });

    // Simples calculado diverge do declarado: pendência tributária, risco alto
    await withTenant(appPool, t, (tx) =>
      tx.query(
        `INSERT INTO simples_calculation (id, tenant_id, entity_id, competence, mode, status, engine_version, inputs, total, reference_kind, reference_total, difference, fingerprint)
         VALUES ($1, current_tenant(), $2, '2026-08-01', 'CONFERENCIA', 'DIVERGE', 't', '{}', 60, 'DECLARACAO', 45, 15, 'f1')`,
        [newId(), entityId],
      ),
    );
    r = await reviewMonth(appPool, t, entityId, "2026-08", "2026-09-15");
    expect(by("simples_calculo")).toMatchObject({ status: "PENDENTE", critical: true, amount: "15.00" });
    expect(r.risk).toBe("ALTO");
    expect(await runReview(appPool, t, entityId, "2026-09-15")).toMatchObject({ changed: 1, high: 1 });

    await withTenant(appPool, t, async (tx) => {
      const ov = await reviewOverview(tx, entityId);
      expect(ov).toHaveLength(1);
      expect(ov[0]).toMatchObject({ competence: "2026-08", status: "PENDENTE", risk: "ALTO" });
      const ev = await tx.query("SELECT payload FROM outbox WHERE type = 'REVIEW_COMPLETED' AND entity_id = $1", [entityId]);
      expect(ev.rows).toHaveLength(2);
      const au = await tx.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'review.completed' AND entity_id = $1", [entityId]);
      expect(au.rows[0].n).toBe(2);
    });
  });
});
