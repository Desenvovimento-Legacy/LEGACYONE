import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FakeIntegraContador } from "../src/integrations/integra-contador/fake.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { createWebServer } from "../src/web/server.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";
import { AUTH_KEY, session } from "./auth-helpers.js";
import { appPool, newEntity, newTenant } from "./helpers.js";

const OFFICE = "11222333000181";
let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function start(dailyLimit = 20) {
  const t = await newTenant();
  const { entityId } = await newEntity(t, CNPJ_MATRIZ);
  await withTenant(appPool, t, (tx) =>
    tx.query(
      `INSERT INTO power_of_attorney (id, tenant_id, entity_id, system, grantee_document, scopes, valid_from, valid_to, source, verified_at)
       VALUES ($1, current_tenant(), $2, 'ECAC', $3, '{TODOS}', '2025-01-01', '2030-12-31', 'teste', now())`,
      [newId(), entityId, OFFICE],
    ),
  );
  const integra = new FakeIntegraContador(OFFICE, {}, {
    [CNPJ_MATRIZ]: {
      declarations: [{ competence: "2026-08-01", number: "00000000202608001", operation: "ORIGINAL", transmittedAt: null, malha: null }],
      das: [],
      payments: [],
    },
  });
  const server = createWebServer({
    appPool,
    tenantId: t,
    officeName: "Escritório Teste",
    integra,
    metering: { provider: "serpro", dailyLimit },
    port: 0,
    authKey: AUTH_KEY,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((r) => server.close(() => r()));
  const cookie = await session(base, t);
  const fetch = ((u: string, init?: RequestInit) =>
    globalThis.fetch(u, { ...init, headers: { ...((init?.headers as Record<string, string>) ?? {}), cookie } })) as typeof globalThis.fetch;
  return { base, integra, entityId, fetch };
}

describe("tela local: abrir não consulta; só o botão Buscar consulta", () => {
  it("abrir a tela, listar e ver detalhe não chamam o SERPRO", async () => {
    const { base, integra, entityId, fetch } = await start();
    expect((await fetch(`${base}/`)).status).toBe(200);
    const res = await fetch(`${base}/api/competencia/2026-08`);
    const list = await res.json();
    expect(res.status, JSON.stringify(list)).toBe(200);
    expect(list.entities).toHaveLength(1);
    expect(list).toMatchObject({ billedToday: 0, dailyLimit: 20, callsPerSearch: 2 });
    expect((await fetch(`${base}/api/empresa/${entityId}/competencia/2026-08`)).status).toBe(200);
    expect(integra.calls).toEqual([]);
  });

  it("Buscar sem o cabeçalho da tela ou vindo de outro site é recusado", async () => {
    const { base, integra, entityId, fetch } = await start();
    const url = `${base}/api/empresa/${entityId}/competencia/2026-08/buscar`;
    expect((await fetch(url, { method: "POST" })).status).toBe(403);
    expect(
      (await fetch(url, { method: "POST", headers: { "X-IARIS-Acao": "buscar", Origin: "https://evil.example" } })).status,
    ).toBe(403);
    expect(integra.calls).toEqual([]);
  });

  it("Buscar faz 2 consultas e o contador do dia sobe", async () => {
    const { base, integra, entityId, fetch } = await start();
    const r = await fetch(`${base}/api/empresa/${entityId}/competencia/2026-08/buscar`, {
      method: "POST",
      headers: { "X-IARIS-Acao": "buscar" },
    });
    const body = await r.json();
    expect(r.status, JSON.stringify(body)).toBe(200);
    expect(body.calls).toBe(2);
    expect(body.detail.declarations).toHaveLength(1);
    expect(integra.calls).toHaveLength(2);
    const list = await (await fetch(`${base}/api/competencia/2026-08`)).json();
    expect(list.billedToday).toBe(2);
    expect(list.entities[0].lastFetchedAt).not.toBeNull();
  });

  it("teto do dia atingido: Buscar responde 429 e não consulta", async () => {
    const { base, integra, entityId, fetch } = await start(1);
    const r = await fetch(`${base}/api/empresa/${entityId}/competencia/2026-08/buscar`, {
      method: "POST",
      headers: { "X-IARIS-Acao": "buscar" },
    });
    expect(r.status).toBe(429);
    expect(integra.calls).toEqual([]);
  });
});
