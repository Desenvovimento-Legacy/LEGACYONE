import { request } from "node:https";
import { z } from "zod";
import { isValidCnpj, normalizeCnpj } from "../../shared/br/documents.js";
import { parseLastDeclaration, parsePayments, parsePgdasYear, stripPdfs } from "./parsers.js";
import type {
  FederalPaymentPage,
  IntegraContador,
  IntegraContadorResult,
  PgdasLastDeclaration,
  PgdasYearIndex,
  PowerOfAttorneyGrant,
  PowerOfAttorneyStatus,
} from "./types.js";

/**
 * Conector real do SERPRO Integra Contador.
 *
 * Autenticação (documentação oficial, "Como autenticar na API"):
 *   POST https://autenticacao.sapi.serpro.gov.br/authenticate
 *   Authorization: Basic base64(consumerKey:consumerSecret) · Role-Type: TERCEIROS
 *   corpo grant_type=client_credentials · TLS mútuo com o e-CNPJ do contratante
 *   → access_token + jwt_token (+ expires_in)
 * Chamadas: POST https://gateway.apiserpro.serpro.gov.br/integra-contador/v1/{Apoiar|Consultar|Declarar|Emitir|Monitorar}
 *   Authorization: Bearer access_token · jwt_token: jwt_token
 *
 * Segredos (consumer key/secret, certificado e senha) chegam já abertos pelo
 * Credential Vault e ficam só em memória: nunca entram em log, erro, evidência
 * ou prompt. A evidência guardada é o corpo da resposta de negócio, sem tokens.
 */

export interface HttpRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  /** Certificado do cliente para TLS mútuo (só na autenticação). */
  clientCert?: { pfx: Buffer; passphrase: string };
  timeoutMs: number;
}
export interface HttpResponse {
  status: number;
  body: string;
}
export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

/** Transporte padrão: node:https (permite TLS mútuo com .pfx). */
export const httpsTransport: HttpTransport = (req) =>
  new Promise((resolve, reject) => {
    const r = request(
      req.url,
      {
        method: req.method,
        headers: { ...req.headers, "content-length": Buffer.byteLength(req.body).toString() },
        ...(req.clientCert ? { pfx: req.clientCert.pfx, passphrase: req.clientCert.passphrase } : {}),
        timeout: req.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    r.on("timeout", () => r.destroy(new Error(`tempo esgotado (${req.timeoutMs} ms) em ${new URL(req.url).host}`)));
    r.on("error", (e) => reject(sanitizeTlsError(e)));
    r.end(req.body);
  });

/** Erros de certificado do OpenSSL viram mensagem acionável, sem dados do certificado. */
function sanitizeTlsError(e: Error): Error {
  const msg = e.message ?? "";
  if (/mac verify failure|bad decrypt/i.test(msg)) return new Error("Senha do certificado (CERT_PFX_PASSWORD) não confere com o arquivo .pfx");
  if (/unsupported/i.test(msg)) {
    return new Error(
      "O .pfx usa criptografia legada (RC2/3DES) que o Node não abre. Reexporte o certificado no Windows marcando 'AES256-SHA256'",
    );
  }
  return e;
}

export class IntegraContadorError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly messages: { codigo: string; texto: string }[] = [],
  ) {
    super(message);
    this.name = "IntegraContadorError";
  }
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  jwt_token: z.string().min(1),
  expires_in: z.coerce.number().optional(),
});

const Mensagem = z.object({ codigo: z.string(), texto: z.string() });
const GatewayResponse = z.object({
  status: z.number().optional(),
  dados: z.string().nullish(),
  mensagens: z.array(Mensagem).default([]),
});

const Procuracao = z.object({
  dtexpiracao: z.string().regex(/^\d{8}$/),
  nrsistemas: z.coerce.number().optional(),
  sistemas: z.array(z.string()).default([]),
});

export interface SerproConfig {
  consumerKey: string;
  consumerSecret: string;
  /** CNPJ do contratante (titular do contrato e do e-CNPJ). */
  officeCnpj: string;
  certificate: { pfx: Buffer; passphrase: string };
  authUrl?: string;
  gatewayUrl?: string;
  transport?: HttpTransport;
  timeoutMs?: number;
  now?: () => Date;
}

const ymdToIso = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

/** Data civil em São Paulo (vencimento de procuração é por dia). */
function todayInBrazil(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(now);
}

/**
 * Interpreta a resposta do serviço PROCURACOES/OBTERPROCURACAO41.
 * "[Aviso-PROCURACOES-40400] Não possui procuração ativa" → sem procuração.
 * Procurações expiradas não contam como vigentes.
 */
export function parseObterProcuracao(
  body: unknown,
  ctx: { contributor: string; grantee: string; today: string },
): PowerOfAttorneyStatus {
  const r = GatewayResponse.parse(body);
  const none = r.mensagens.some((m) => m.codigo.includes("PROCURACOES-40400"));
  const list = none || !r.dados ? [] : z.array(Procuracao).parse(JSON.parse(r.dados));
  const grants: PowerOfAttorneyGrant[] = list
    .map((p) => ({ validFrom: null, validTo: ymdToIso(p.dtexpiracao), services: [...p.sistemas].sort() }))
    .filter((g) => g.validTo >= ctx.today)
    .sort((a, b) => a.validTo.localeCompare(b.validTo));
  const services = [...new Set(grants.flatMap((g) => g.services))].sort();
  return { contributor: ctx.contributor, grantee: ctx.grantee, active: grants.length > 0, grants, services };
}

export class SerproIntegraContador implements IntegraContador {
  readonly name = "serpro-integra-contador";
  private readonly authUrl: string;
  private readonly gatewayUrl: string;
  private readonly transport: HttpTransport;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly officeCnpj: string;
  private token: { access: string; jwt: string; expiresAt: number } | null = null;

  constructor(private readonly cfg: SerproConfig) {
    this.officeCnpj = normalizeCnpj(cfg.officeCnpj);
    if (!isValidCnpj(this.officeCnpj)) throw new Error("OFFICE_CNPJ do cofre não é um CNPJ válido");
    this.authUrl = cfg.authUrl ?? "https://autenticacao.sapi.serpro.gov.br/authenticate";
    this.gatewayUrl = (cfg.gatewayUrl ?? "https://gateway.apiserpro.serpro.gov.br/integra-contador/v1").replace(/\/$/, "");
    this.transport = cfg.transport ?? httpsTransport;
    this.timeoutMs = cfg.timeoutMs ?? 60_000;
    this.now = cfg.now ?? (() => new Date());
  }

  // Nunca expor credenciais por inspeção/serialização.
  toJSON() {
    return { name: this.name, office: this.officeCnpj };
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `SerproIntegraContador(${this.officeCnpj})`;
  }

  get office(): string {
    return this.officeCnpj;
  }

  /** Obtém (ou reaproveita) o token. Não é bilhetado pelo SERPRO. */
  async authenticate(force = false): Promise<{ expiresAt: Date }> {
    if (!force && this.token && this.token.expiresAt > this.now().getTime() + 60_000) {
      return { expiresAt: new Date(this.token.expiresAt) };
    }
    const basic = Buffer.from(`${this.cfg.consumerKey}:${this.cfg.consumerSecret}`).toString("base64");
    const res = await this.transport({
      url: this.authUrl,
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "role-type": "TERCEIROS",
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: "grant_type=client_credentials",
      clientCert: this.cfg.certificate,
      timeoutMs: this.timeoutMs,
    });
    if (res.status !== 200) {
      // O corpo da autenticação não é repassado: pode ecoar dados da credencial.
      const hint =
        res.status === 401
          ? "consumer key/secret recusados ou certificado não é o do contratante"
          : res.status === 403
            ? "certificado recusado: use o e-CNPJ do titular do contrato"
            : "falha no serviço de autenticação";
      throw new IntegraContadorError(`Autenticação SERPRO falhou (HTTP ${res.status}): ${hint}`, res.status);
    }
    const t = TokenResponse.parse(JSON.parse(res.body));
    const ttl = (t.expires_in ?? 3600) * 1000;
    this.token = { access: t.access_token, jwt: t.jwt_token, expiresAt: this.now().getTime() + ttl };
    return { expiresAt: new Date(this.token.expiresAt) };
  }

  private async call(
    path: "Apoiar" | "Consultar" | "Declarar" | "Emitir" | "Monitorar",
    contributor: { numero: string; tipo: 1 | 2 },
    pedido: { idSistema: string; idServico: string; versaoSistema: string; dados: unknown },
  ): Promise<{ status: number; body: unknown }> {
    const payload = JSON.stringify({
      contratante: { numero: this.officeCnpj, tipo: 2 },
      autorPedidoDados: { numero: this.officeCnpj, tipo: 2 },
      contribuinte: contributor,
      pedidoDados: { ...pedido, dados: JSON.stringify(pedido.dados) },
    });
    for (let attempt = 1; ; attempt++) {
      await this.authenticate(attempt > 1);
      const res = await this.transport({
        url: `${this.gatewayUrl}/${path}`,
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token!.access}`,
          jwt_token: this.token!.jwt,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: payload,
        timeoutMs: this.timeoutMs,
      });
      if (res.status === 401 && attempt === 1) continue; // token expirado: renova uma vez
      let body: unknown = null;
      try {
        body = res.body ? JSON.parse(res.body) : null;
      } catch {
        body = null;
      }
      return { status: res.status, body };
    }
  }

  /**
   * Chamada de negócio: devolve a resposta interpretada ou lança
   * IntegraContadorError. Códigos em `emptyCodes` significam "nada encontrado"
   * (não é erro) e resultam em `empty: true`.
   */
  private async consult(
    path: "Consultar" | "Emitir" | "Apoiar" | "Monitorar",
    contributorCnpj: string,
    pedido: { idSistema: string; idServico: string; versaoSistema: string; dados: unknown },
    emptyCodes: string[] = [],
  ): Promise<{ status: number; body: unknown; dados: unknown; empty: boolean }> {
    const cnpj = normalizeCnpj(contributorCnpj);
    if (!isValidCnpj(cnpj)) throw new Error(`CNPJ inválido: ${contributorCnpj}`);
    const { status, body } = await this.call(path, { numero: cnpj, tipo: 2 }, pedido);
    const parsed = GatewayResponse.safeParse(body);
    const msgs = parsed.data?.mensagens ?? [];
    const empty = msgs.some((m) => emptyCodes.some((c) => m.codigo.includes(c)));
    if (status !== 200 && !empty) {
      const detail = msgs.map((m) => `${m.codigo} ${m.texto}`).join("; ") || "sem mensagem";
      throw new IntegraContadorError(
        `Integra Contador respondeu HTTP ${status} em ${pedido.idSistema}/${pedido.idServico}: ${detail}`,
        status,
        msgs,
      );
    }
    return { status, body, dados: empty ? null : (parsed.data?.dados ?? null), empty };
  }

  async checkPowerOfAttorney(contributorCnpj: string): Promise<IntegraContadorResult<PowerOfAttorneyStatus>> {
    const cnpj = normalizeCnpj(contributorCnpj);
    // Regra do serviço: outorgante = contribuinte e outorgado = autor do pedido.
    const r = await this.consult(
      "Consultar",
      cnpj,
      {
        idSistema: "PROCURACOES",
        idServico: "OBTERPROCURACAO41",
        versaoSistema: "1",
        dados: { outorgante: cnpj, tipoOutorgante: "2", outorgado: this.officeCnpj, tipoOutorgado: "2" },
      },
      ["PROCURACOES-40400"],
    );
    const value = parseObterProcuracao(r.body ?? {}, {
      contributor: cnpj,
      grantee: this.officeCnpj,
      today: todayInBrazil(this.now()),
    });
    return { value, raw: { httpStatus: r.status, body: r.body }, source: this.name, fetchedAt: this.now() };
  }

  async listPgdasDeclarations(contributorCnpj: string, year: number): Promise<IntegraContadorResult<PgdasYearIndex>> {
    const cnpj = normalizeCnpj(contributorCnpj);
    const r = await this.consult(
      "Consultar",
      cnpj,
      { idSistema: "PGDASD", idServico: "CONSDECLARACAO13", versaoSistema: "1.0", dados: { anoCalendario: String(year) } },
      // "Não há declaração transmitida para o período/parâmetro informado."
      ["MSG_ISN_005", "MSG_ISN_027"],
    );
    const value = parsePgdasYear(r.dados, { contributor: cnpj, year });
    return { value, raw: { httpStatus: r.status, body: r.body }, source: this.name, fetchedAt: this.now() };
  }

  async listPgdasPeriod(contributorCnpj: string, period: string): Promise<IntegraContadorResult<PgdasYearIndex>> {
    if (!/^\d{6}$/.test(period)) throw new Error("Período de apuração deve ser AAAAMM");
    const cnpj = normalizeCnpj(contributorCnpj);
    const r = await this.consult(
      "Consultar",
      cnpj,
      { idSistema: "PGDASD", idServico: "CONSDECLARACAO13", versaoSistema: "1.0", dados: { periodoApuracao: period } },
      ["MSG_ISN_005", "MSG_ISN_027"],
    );
    const value = parsePgdasYear(r.dados, { contributor: cnpj, year: Number(period.slice(0, 4)) });
    return { value, raw: { httpStatus: r.status, body: r.body }, source: this.name, fetchedAt: this.now() };
  }

  async lastPgdasDeclaration(contributorCnpj: string, period: string): Promise<IntegraContadorResult<PgdasLastDeclaration>> {
    if (!/^\d{6}$/.test(period)) throw new Error("Período de apuração deve ser AAAAMM");
    const cnpj = normalizeCnpj(contributorCnpj);
    const r = await this.consult(
      "Consultar",
      cnpj,
      { idSistema: "PGDASD", idServico: "CONSULTIMADECREC14", versaoSistema: "1.0", dados: { periodoApuracao: period } },
      ["MSG_ISN_005", "MSG_ISN_027"],
    );
    const value = parseLastDeclaration(r.dados, cnpj, period);
    // A evidência guarda a resposta sem os PDFs em base64 (eles vão para tabela própria, com hash).
    return { value, raw: { httpStatus: r.status, body: stripPdfs(r.body) }, source: this.name, fetchedAt: this.now() };
  }

  async listPayments(
    contributorCnpj: string,
    q: { from: string; to: string; first?: number; size?: number },
  ): Promise<IntegraContadorResult<FederalPaymentPage>> {
    const cnpj = normalizeCnpj(contributorCnpj);
    const first = q.first ?? 0;
    const size = Math.min(q.size ?? 100, 100);
    const r = await this.consult("Consultar", cnpj, {
      idSistema: "PAGTOWEB",
      idServico: "PAGAMENTOS71",
      versaoSistema: "1.0",
      dados: { intervaloDataArrecadacao: { dataInicial: q.from, dataFinal: q.to }, primeiroDaPagina: first, tamanhoDaPagina: size },
    });
    const value: FederalPaymentPage = { contributor: cnpj, from: q.from, to: q.to, first, size, payments: parsePayments(r.dados) };
    return { value, raw: { httpStatus: r.status, body: r.body }, source: this.name, fetchedAt: this.now() };
  }
}
