import { request } from "node:https";
import { gunzipSync } from "node:zlib";
import type { ClientCertificate } from "../sefaz/dist-dfe.js";

/**
 * NFS-e Nacional — ADN, API de distribuição aos contribuintes.
 *
 *   GET https://adn.nfse.gov.br/contribuintes/DFe/{NSU}?lote=true
 *   TLS mútuo com certificado da mesma raiz do CNPJ (manual ADN, v1.0 de 12/02/2026)
 *   200 → { StatusProcessamento, LoteDFe: [{ NSU, ChaveAcesso, TipoDocumento, TipoEvento, ArquivoXml, DataHoraGeracao }] }
 *   404 com NENHUM_DOCUMENTO/E2220 → sem documento novo · 429 → esperar (Retry-After)
 *   ArquivoXml = gzip + base64 · até 50 por lote
 * Não é cobrado. Sequência própria, independente da NF-e.
 */

export const ADN_URL = "https://adn.nfse.gov.br/contribuintes";
export const LOTE_SIZE = 50;

export interface AdnDoc {
  nsu: number;
  accessKey: string | null;
  docType: string | null;
  eventType: string | null;
  generatedAt: string | null;
  xml: string;
}

export interface AdnLote {
  httpStatus: number;
  /** DOCUMENTOS_LOCALIZADOS · NENHUM_DOCUMENTO_LOCALIZADO · outro texto do ADN */
  status: string;
  docs: AdnDoc[];
  /** Segundos pedidos pelo ADN em 429. */
  retryAfter?: number;
}

export interface NfseDistribution {
  lote(input: { cnpj: string; nsu: number; certificate: ClientCertificate }): Promise<AdnLote>;
}

export class AdnError extends Error {
  constructor(message: string, readonly httpStatus: number) {
    super(message);
    this.name = "AdnError";
  }
}

interface RawLote {
  StatusProcessamento?: string;
  LoteDFe?: { NSU?: number | string; ChaveAcesso?: string; TipoDocumento?: string; TipoEvento?: string; ArquivoXml?: string; DataHoraGeracao?: string }[];
}

export function parseLote(httpStatus: number, body: string, retryAfter?: string | null): AdnLote {
  if (httpStatus === 429) return { httpStatus, status: "LIMITE", docs: [], retryAfter: Number(retryAfter) || 30 };
  if (httpStatus === 401 || httpStatus === 403) throw new AdnError("certificado recusado pelo ADN (precisa ser da mesma raiz do CNPJ e estar válido)", httpStatus);
  let json: RawLote | null = null;
  try {
    json = JSON.parse(body) as RawLote;
  } catch {
    json = null;
  }
  if (httpStatus === 404) {
    if (json && Array.isArray(json.LoteDFe) && json.LoteDFe.length) {
      // segue para a leitura do lote
    } else if (/NENHUM_DOCUMENTO|E2220/i.test(body)) {
      return { httpStatus, status: "NENHUM_DOCUMENTO_LOCALIZADO", docs: [] };
    } else {
      throw new AdnError(`ADN respondeu 404: ${body.slice(0, 200)}`, httpStatus);
    }
  } else if (httpStatus !== 200) {
    throw new AdnError(`ADN respondeu HTTP ${httpStatus}: ${body.slice(0, 200)}`, httpStatus);
  }
  if (!json) throw new AdnError("resposta do ADN não é JSON", httpStatus);
  const docs: AdnDoc[] = [];
  for (const d of json.LoteDFe ?? []) {
    const nsu = Number(d.NSU);
    if (!Number.isSafeInteger(nsu) || !d.ArquivoXml) continue;
    docs.push({
      nsu,
      accessKey: d.ChaveAcesso ?? null,
      docType: d.TipoDocumento ?? null,
      eventType: d.TipoEvento ?? null,
      generatedAt: d.DataHoraGeracao ?? null,
      xml: gunzipSync(Buffer.from(d.ArquivoXml, "base64")).toString("utf8"),
    });
  }
  return { httpStatus, status: json.StatusProcessamento ?? (docs.length ? "DOCUMENTOS_LOCALIZADOS" : "NENHUM_DOCUMENTO_LOCALIZADO"), docs };
}

export class AdnDistribution implements NfseDistribution {
  constructor(private readonly base = ADN_URL) {}

  lote(input: { cnpj: string; nsu: number; certificate: ClientCertificate }): Promise<AdnLote> {
    const url = `${this.base}/DFe/${Math.max(0, Math.trunc(input.nsu))}?lote=true&cnpjConsulta=${encodeURIComponent(input.cnpj)}`;
    return new Promise((resolve, reject) => {
      const r = request(
        url,
        {
          method: "GET",
          headers: { accept: "application/json", "user-agent": "IARIS-Documentos" },
          pfx: input.certificate.pfx,
          passphrase: input.certificate.passphrase,
          timeout: 60_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            try {
              resolve(parseLote(res.statusCode ?? 0, Buffer.concat(chunks).toString("utf8"), res.headers["retry-after"] as string | undefined));
            } catch (e) {
              reject(e);
            }
          });
          res.on("error", reject);
        },
      );
      r.on("timeout", () => r.destroy(new Error("tempo esgotado no ADN")));
      r.on("error", reject);
      r.end();
    });
  }
}
