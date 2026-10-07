import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkVault } from "../src/integrations/integra-contador/from-vault.js";
import {
  IntegraContadorError,
  parseObterProcuracao,
  SerproIntegraContador,
  type HttpRequest,
  type HttpResponse,
} from "../src/integrations/integra-contador/serpro.js";
import { secretStoreFromText } from "../src/shared/secrets/secrets-file.js";
import { CNPJ_MATRIZ } from "./fixtures/cnpj.js";

const OFFICE = "11222333000181";
const NOW = new Date("2026-10-05T15:00:00Z");

/** Transporte simulado: registra as requisições e responde por URL. */
function fakeTransport(routes: Record<string, (req: HttpRequest) => HttpResponse>) {
  const calls: HttpRequest[] = [];
  const transport = async (req: HttpRequest) => {
    calls.push(req);
    const path = new URL(req.url).pathname.split("/").pop()!;
    const route = routes[path];
    if (!route) throw new Error(`rota não simulada: ${path}`);
    return route(req);
  };
  return { calls, transport };
}

const authOk = () => ({ status: 200, body: JSON.stringify({ access_token: "ACCESS", jwt_token: "JWT", expires_in: 2008 }) });

function connector(routes: Record<string, (req: HttpRequest) => HttpResponse>) {
  const t = fakeTransport({ authenticate: authOk, ...routes });
  const c = new SerproIntegraContador({
    consumerKey: "KEY",
    consumerSecret: "SECRET",
    officeCnpj: OFFICE,
    certificate: { pfx: Buffer.from("pfx"), passphrase: "pin" },
    transport: t.transport,
    now: () => NOW,
  });
  return { c, calls: t.calls };
}

const procuracoes = (list: unknown[], codigo = "[Aviso-PROCURACOES-20001]") => ({
  status: 200,
  body: JSON.stringify({ status: 200, dados: JSON.stringify(list), mensagens: [{ codigo, texto: "ok" }] }),
});

describe("SERPRO Integra Contador: procuração e-CAC", () => {
  it("autentica com TLS mútuo e pede OBTERPROCURACAO41 com outorgante = contribuinte e outorgado = escritório", async () => {
    const { c, calls } = connector({
      Consultar: () =>
        procuracoes([
          { dtexpiracao: "20271231", nrsistemas: 2, sistemas: ["PGDAS-D - a partir de 01/2018", "Acessar o sistema DCTFWeb"] },
          { dtexpiracao: "20250101", nrsistemas: 1, sistemas: ["Caixa Postal - Mensagens"] },
        ]),
    });
    const r = await c.checkPowerOfAttorney(CNPJ_MATRIZ);

    const [auth, call] = calls;
    expect(auth!.headers.authorization).toBe(`Basic ${Buffer.from("KEY:SECRET").toString("base64")}`);
    expect(auth!.headers["role-type"]).toBe("TERCEIROS");
    expect(auth!.body).toBe("grant_type=client_credentials");
    expect(auth!.clientCert).toBeDefined();

    expect(call!.url).toBe("https://gateway.apiserpro.serpro.gov.br/integra-contador/v1/Consultar");
    expect(call!.headers).toMatchObject({ authorization: "Bearer ACCESS", jwt_token: "JWT" });
    expect(call!.clientCert).toBeUndefined();
    const body = JSON.parse(call!.body);
    expect(body).toMatchObject({
      contratante: { numero: OFFICE, tipo: 2 },
      autorPedidoDados: { numero: OFFICE, tipo: 2 },
      contribuinte: { numero: CNPJ_MATRIZ, tipo: 2 },
      pedidoDados: { idSistema: "PROCURACOES", idServico: "OBTERPROCURACAO41", versaoSistema: "1" },
    });
    expect(JSON.parse(body.pedidoDados.dados)).toEqual({
      outorgante: CNPJ_MATRIZ,
      tipoOutorgante: "2",
      outorgado: OFFICE,
      tipoOutorgado: "2",
    });

    // Expirada não conta como vigente.
    expect(r.value).toEqual({
      contributor: CNPJ_MATRIZ,
      grantee: OFFICE,
      active: true,
      grants: [{ validFrom: null, validTo: "2027-12-31", services: ["Acessar o sistema DCTFWeb", "PGDAS-D - a partir de 01/2018"] }],
      services: ["Acessar o sistema DCTFWeb", "PGDAS-D - a partir de 01/2018"],
    });
  });

  it("a evidência não contém token nem credencial", async () => {
    const { c } = connector({ Consultar: () => procuracoes([{ dtexpiracao: "20271231", sistemas: [] }]) });
    const r = await c.checkPowerOfAttorney(CNPJ_MATRIZ);
    const s = JSON.stringify(r.raw) + JSON.stringify(c);
    for (const secret of ["ACCESS", "JWT", "KEY", "SECRET", "pin"]) expect(s).not.toContain(secret);
  });

  it("'Não possui procuração ativa' significa sem procuração, não erro", async () => {
    const { c } = connector({
      Consultar: () => ({
        status: 404,
        body: JSON.stringify({ status: 404, dados: "", mensagens: [{ codigo: "[Aviso-PROCURACOES-40400]", texto: "Não possui procuração ativa." }] }),
      }),
    });
    const r = await c.checkPowerOfAttorney(CNPJ_MATRIZ);
    expect(r.value.active).toBe(false);
    expect(r.value.grants).toEqual([]);
  });

  it("renova o token uma vez em 401 e reaproveita o token nas chamadas seguintes", async () => {
    let n = 0;
    const { c, calls } = connector({
      Consultar: () => (++n === 1 ? { status: 401, body: "" } : procuracoes([{ dtexpiracao: "20271231", sistemas: [] }])),
    });
    await c.checkPowerOfAttorney(CNPJ_MATRIZ);
    await c.checkPowerOfAttorney(CNPJ_MATRIZ);
    expect(calls.map((x) => new URL(x.url).pathname.split("/").pop())).toEqual([
      "authenticate",
      "Consultar",
      "authenticate",
      "Consultar",
      "Consultar",
    ]);
  });

  it("falha de autenticação não repassa o corpo da resposta", async () => {
    const t = fakeTransport({ authenticate: () => ({ status: 401, body: '{"echo":"SECRET"}' }) });
    const c2 = new SerproIntegraContador({
      consumerKey: "KEY",
      consumerSecret: "SECRET",
      officeCnpj: OFFICE,
      certificate: { pfx: Buffer.from("x"), passphrase: "pin" },
      transport: t.transport,
    });
    const err = await c2.authenticate().catch((e) => e);
    expect(err).toBeInstanceOf(IntegraContadorError);
    expect(err.message).toContain("HTTP 401");
    expect(err.message).not.toContain("SECRET");
  });

  it("erro de negócio vira IntegraContadorError com as mensagens do SERPRO", async () => {
    const { c } = connector({
      Consultar: () => ({
        status: 403,
        body: JSON.stringify({ mensagens: [{ codigo: "[AcessoNegado-PROCURACOES-40300]", texto: "Procurador diferente do Autor do pedido." }] }),
      }),
    });
    await expect(c.checkPowerOfAttorney(CNPJ_MATRIZ)).rejects.toThrow(/40300/);
  });

  it("interpreta datas aaaaMMdd e vencimento no próprio dia", () => {
    const v = parseObterProcuracao(
      { dados: JSON.stringify([{ dtexpiracao: "20261005", sistemas: ["B", "A"] }]), mensagens: [] },
      { contributor: CNPJ_MATRIZ, grantee: OFFICE, today: "2026-10-05" },
    );
    expect(v.grants).toEqual([{ validFrom: null, validTo: "2026-10-05", services: ["A", "B"] }]);
  });
});

describe("Credential Vault (arquivo local)", () => {
  it("lê KEY=VALOR, informa só o que está preenchido e não vaza valores", () => {
    const s = secretStoreFromText('﻿# comentário\r\nA=1\r\nB=\r\nC="com espaço"\r\n', "teste");
    expect(s.describe()).toEqual({ A: true, B: false, C: true });
    expect(s.require("C")).toBe("com espaço");
    expect(() => s.require("B")).toThrow(/B não preenchido/);
    expect(JSON.stringify(s)).not.toContain("com espaço");
  });

  it("confere o certificado A1 com a senha sem expor a chave", () => {
    const dir = mkdtempSync(join(tmpdir(), "iaris-pfx-"));
    const key = join(dir, "k.pem");
    const crt = join(dir, "c.pem");
    const pfx = join(dir, "c.pfx");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "30", "-subj", "/CN=ESCRITORIO TESTE:11222333000181"], { stdio: "ignore" });
    execFileSync("openssl", ["pkcs12", "-export", "-inkey", key, "-in", crt, "-out", pfx, "-passout", "pass:certo"], { stdio: "ignore" });
    const env = (pwd: string) =>
      `SERPRO_CONTRACT=1\nSERPRO_CONSUMER_KEY=k\nSERPRO_CONSUMER_SECRET=s\nOFFICE_CNPJ=${OFFICE}\nCERT_PFX_PATH=${pfx}\nCERT_PFX_PASSWORD=${pwd}\n`;

    const ok = checkVault(secretStoreFromText(env("certo")));
    expect(ok.certificateOpened).toBe(true);
    expect(ok.certificate?.subject).toContain("ESCRITORIO TESTE");
    expect(ok.certificate?.expired).toBe(false);
    expect(JSON.stringify(ok)).not.toContain("certo");

    const bad = checkVault(secretStoreFromText(env("errada")));
    expect(bad.certificateOpened).toBe(false);
    expect(bad.certificateError).toBe("senha não confere com o .pfx");

    expect(checkVault(secretStoreFromText("CERT_PFX_PATH=/nao/existe")).certificateFileFound).toBe(false);
  });
});
