import type { FederalPayment, PgdasDasIndex, PgdasDeclarationIndex, PgdasYearIndex } from "./types.js";

/**
 * Interpretação das respostas de negócio do Integra Contador. A documentação
 * oficial mistura maiúsculas/minúsculas nos nomes dos campos (ex.:
 * "dataHoraEmissaoDas" e "datahoraEmissaoDas"), então as chaves são
 * normalizadas para minúsculas antes de ler.
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function lowerKeys(v: unknown): Json {
  if (Array.isArray(v)) return v.map(lowerKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k.toLowerCase(), lowerKeys(x)]));
  }
  return v as Json;
}

const obj = (v: Json | undefined): Record<string, Json> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Json>) : {};
const arr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const str = (v: Json | undefined): string | null => (v === null || v === undefined || v === "" ? null : String(v));

/** "dados" vem como texto JSON escapado; às vezes já como objeto. */
export function parseDados(dados: unknown): Json {
  if (dados === null || dados === undefined || dados === "") return null;
  return lowerKeys(typeof dados === "string" ? JSON.parse(dados) : dados);
}

/** 201801 → 2018-01-01 */
function competenceFromPa(v: Json | undefined): string {
  const s = String(v ?? "");
  if (!/^\d{6}$/.test(s)) throw new Error(`Período de apuração inválido: ${s}`);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-01`;
}

/** yyyyMMddHHmmss (horário de Brasília) → ISO 8601 com -03:00 */
function brDateTime(v: Json | undefined): string | null {
  const s = str(v);
  if (!s || !/^\d{14}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}-03:00`;
}

function declarationOperation(t: string): PgdasDeclarationIndex["operation"] | null {
  if (/retific/i.test(t)) return "RETIFICADORA";
  if (/original/i.test(t)) return "ORIGINAL";
  return null;
}

function dasOperation(t: string): PgdasDasIndex["operation"] {
  if (/avulso/i.test(t)) return "DAS_AVULSO";
  if (/judicial/i.test(t)) return "DAS_MEDIDA_JUDICIAL";
  if (/cobran/i.test(t)) return "DAS_COBRANCA";
  if (/gera/i.test(t)) return "GERACAO_DAS";
  return "OUTRO";
}

/** PGDASD/CONSDECLARACAO13 por ano-calendário. `dados` nulo = nenhuma declaração. */
export function parsePgdasYear(dados: unknown, ctx: { contributor: string; year: number }): PgdasYearIndex {
  const d = obj(parseDados(dados));
  const periods = [...arr(d.periodos), ...(d.periodo ? [d.periodo] : [])];
  const declarations: PgdasDeclarationIndex[] = [];
  const das: PgdasDasIndex[] = [];
  for (const p of periods.map(obj)) {
    const competence = competenceFromPa(p.periodoapuracao);
    for (const op of arr(p.operacoes).map(obj)) {
      const tipo = String(op.tipooperacao ?? "");
      const di = obj(op.indicedeclaracao);
      const ds = obj(op.indicedas);
      const decNumber = str(di.numerodeclaracao);
      const dasNumber = str(ds.numerodas);
      if (decNumber) {
        const operation = declarationOperation(tipo);
        if (!operation) throw new Error(`Tipo de operação de declaração não reconhecido: ${tipo}`);
        declarations.push({
          competence,
          number: decNumber,
          operation,
          transmittedAt: brDateTime(di.datahoratransmissao),
          malha: str(di.malha),
        });
      }
      if (dasNumber) {
        das.push({
          competence,
          number: dasNumber,
          operation: dasOperation(tipo),
          issuedAt: brDateTime(ds.datahoraemissaodas),
          paid: typeof ds.daspago === "boolean" ? ds.daspago : null,
        });
      }
    }
  }
  return { contributor: ctx.contributor, year: ctx.year, declarations, das };
}

/** Número da API (float) → texto decimal com 2 casas, para gravar em numeric. */
function money(v: Json | undefined): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`Valor monetário inválido: ${String(v)}`);
  return (Math.round(n * 100) / 100).toFixed(2);
}

/** "2022-03-01T00:00:00-03:00" → "2022-03-01" (data civil de Brasília, como veio). */
function day(v: Json | undefined): string | null {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}
const monthOf = (d: string | null) => (d ? `${d.slice(0, 7)}-01` : null);

/** PAGTOWEB/PAGAMENTOS71 → lista de pagamentos. */
export function parsePayments(dados: unknown): FederalPayment[] {
  return arr(parseDados(dados)).map((raw) => {
    const r = obj(raw);
    const tipo = obj(r.tipo);
    const rec = obj(r.receitaprincipal);
    const collectedOn = day(r.dataarrecadacao);
    const total = money(r.valortotal);
    const number = str(r.numerodocumento);
    if (!number || !collectedOn || total === null) {
      throw new Error("Pagamento sem número, data de arrecadação ou valor total na resposta do PagtoWeb");
    }
    return {
      documentNumber: number,
      documentTypeCode: str(tipo.codigo),
      documentType: str(tipo.descricaoabreviada) ?? str(tipo.descricao),
      competence: monthOf(day(r.periodoapuracao)),
      collectedOn,
      dueOn: day(r.datavencimento),
      revenueCode: str(rec.codigo),
      revenueDescription: str(rec.descricao),
      total,
      principal: money(r.valorprincipal),
      fine: money(r.valormulta),
      interest: money(r.valorjuros),
      breakdown: arr(r.desmembramentos).map((x) => {
        const b = obj(x);
        const br = obj(b.receitaprincipal);
        return {
          revenueCode: str(br.codigo),
          revenueDescription: str(br.descricao) ?? str(obj(br.extensaoreceita).descricao),
          competence: monthOf(day(b.periodoapuracao)),
          dueOn: day(b.datavencimento),
          total: money(b.valortotal),
          principal: money(b.valorprincipal),
          fine: money(b.valormulta),
          interest: money(b.valorjuros),
        };
      }),
    };
  });
}
