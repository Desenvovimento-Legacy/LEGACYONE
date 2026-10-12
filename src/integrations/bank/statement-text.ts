import { Dec } from "../../shared/decimal.js";
import { normalize } from "../../shared/text.js";
import type { OfxStatement, OfxTransaction } from "./ofx.js";

/**
 * Extrato em planilha (CSV/XLSX) ou PDF do internet banking — leitura
 * determinística, sem IA.
 *
 * Planilha: acha a linha de cabeçalho (data, histórico/descrição, valor ou
 * débito/crédito, saldo opcional) e lê as linhas abaixo dela.
 * PDF: cada linha "data  histórico  valor [saldo]" vira movimento.
 *
 * Prova (nunca chute): o PDF só é aceito se o saldo fecha — saldo da linha
 * anterior + valor = saldo da linha, ou saldo anterior + movimentos = saldo
 * final. Na planilha com coluna de saldo, a mesma conta é conferida. Linhas de
 * saldo (SALDO ANTERIOR, SALDO DO DIA...) não são movimento.
 * Banco, agência e conta: lidos do cabeçalho quando aparecem; senão, quem envia informa.
 */

export class StatementTextError extends Error {}

export interface ParsedStatement extends OfxStatement {
  format: "CSV" | "XLSX" | "PDF";
  /** como o saldo foi conferido */
  proof: "SALDO_POR_LINHA" | "SALDO_INICIAL_FINAL" | "SEM_SALDO";
}

const BALANCE_ROW = /\b(SALDO|S A L D O|SDO|SALDO ANTERIOR|SALDO DO DIA|SALDO FINAL|SALDO DISPONIVEL|SALDO BLOQUEADO|TOTAL)\b/;

/** Valor brasileiro ou internacional: "1.234,56", "-1234.56", "1.234,56 D", "(1.234,56)". */
export function parseMoney(raw: string | null | undefined): string | null {
  let s = (raw ?? "").trim().toUpperCase().replace(/R\$\s*/g, "").replace(/\s+/g, "");
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/D$/.test(s)) { neg = true; s = s.slice(0, -1); } else if (/C$/.test(s)) s = s.slice(0, -1);
  if (s.startsWith("-")) { neg = !neg; s = s.slice(1); } else if (s.endsWith("-")) { neg = !neg; s = s.slice(0, -1); } else if (s.startsWith("+")) s = s.slice(1);
  if (/^\d{1,3}(\.\d{3})*,\d{1,2}$/.test(s) || /^\d+,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(,\d{3})*\.\d{1,2}$/.test(s)) s = s.replace(/,/g, "");
  else if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const v = Dec.of(s);
  return (neg ? v.mul("-1") : v).toFixed(2);
}

/** Data dd/mm/aaaa, dd/mm/aa, aaaa-mm-dd, dd/mm (ano dado) ou número de série do Excel. */
export function parseDate(raw: string | null | undefined, year?: number): string | null {
  const s = (raw ?? "").trim();
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(s);
  if (m) {
    const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return iso(y, Number(m[2]), Number(m[1]));
  }
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (m && year) return iso(year, Number(m[2]), Number(m[1]));
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const n = Math.floor(Number(s));
    if (n > 30000 && n < 80000) return new Date(Date.UTC(1899, 11, 30) + n * 86_400_000).toISOString().slice(0, 10);
  }
  return null;
}
function iso(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCMonth() === mo - 1 ? dt.toISOString().slice(0, 10) : null;
}

/** Banco, agência e conta citados no cabeçalho do arquivo. */
export function accountHints(text: string): { bankCode: string | null; branch: string | null; account: string | null } {
  const t = normalize(text);
  const branch = /\bAG(?:ENCIA|\.)?\s*:?\s*(\d{3,5})(?:-\d)?\b/.exec(t)?.[1] ?? null;
  const account = /\b(?:C\/C|CC|CONTA(?: CORRENTE)?)\s*(?:N[OºO.]*)?\s*:?\s*(\d[\d.]{2,12}-?[\dX])\b/.exec(t)?.[1]?.replace(/\./g, "") ?? null;
  const names: [RegExp, string][] = [[/\bITAU\b/, "341"], [/\bBRADESCO\b/, "237"], [/\bSANTANDER\b/, "033"], [/\bBANCO DO BRASIL\b|\bBB\b/, "001"], [/\bCAIXA ECONOMICA|\bCEF\b/, "104"],
    [/\bSICOOB\b/, "756"], [/\bSICREDI\b/, "748"], [/\bNU ?BANK|\bNU PAGAMENTOS/, "260"], [/\bINTER\b/, "077"], [/\bC6\b/, "336"], [/\bBANRISUL\b/, "041"], [/\bMERCADO PAGO\b/, "323"]];
  const bankCode = names.find(([re]) => re.test(t))?.[1] ?? null;
  return { bankCode, branch, account };
}

// ------------------------------------------------------------------ planilha

const HEAD = {
  date: /^(DATA|DT|DATA (DO )?LANCAMENTO|DATA MOV(IMENTO)?|DATA DA TRANSACAO|DATE)$/,
  memo: /^(HISTORICO|DESCRICAO|LANCAMENTO|DETALHE|DETALHES|HISTORICO DO LANCAMENTO|DESCRICAO DO LANCAMENTO|MEMO|TITULO|IDENTIFICACAO)$/,
  amount: /^(VALOR|VALOR R|VALOR RS|VALOR \(R\$\)|VALOR LANCAMENTO|MONTANTE|QUANTIA)$/,
  debit: /^(DEBITO|DEBITOS|SAIDA|SAIDAS|VALOR DEBITO)$/,
  credit: /^(CREDITO|CREDITOS|ENTRADA|ENTRADAS|VALOR CREDITO)$/,
  balance: /^(SALDO|SALDO R|SALDO \(R\$\)|SALDO DO DIA)$/,
  doc: /^(DOCUMENTO|DOC|N DOCUMENTO|NUMERO DOCUMENTO|ID|IDENTIFICADOR)$/,
};
const cellKey = (c: string) => normalize(c).replace(/[^A-Z0-9()$ ]/g, " ").replace(/\s+/g, " ").trim();

export function parseTabular(rows: string[][], format: "CSV" | "XLSX"): ParsedStatement {
  let h = -1;
  let col: Partial<Record<keyof typeof HEAD, number>> = {};
  for (let i = 0; i < Math.min(rows.length, 40) && h < 0; i++) {
    const c: typeof col = {};
    rows[i]!.forEach((v, j) => {
      const k = cellKey(v);
      for (const [name, re] of Object.entries(HEAD) as [keyof typeof HEAD, RegExp][]) if (c[name] === undefined && re.test(k)) c[name] = j;
    });
    if (c.date !== undefined && (c.amount !== undefined || c.debit !== undefined || c.credit !== undefined)) { h = i; col = c; }
  }
  if (h < 0) throw new StatementTextError("Planilha sem cabeçalho reconhecido: precisa das colunas Data, Histórico e Valor (ou Débito/Crédito)");
  const hints = accountHints(rows.slice(0, h).map((r) => r.join(" ")).join("\n"));
  const txs: OfxTransaction[] = [];
  const balances: { i: number; balance: string }[] = [];
  let opening: string | null = null;
  let closing: string | null = null;
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i]!;
    const date = parseDate(r[col.date!]);
    const memo = col.memo !== undefined ? (r[col.memo] ?? "").trim() : "";
    const bal = col.balance !== undefined ? parseMoney(r[col.balance]) : null;
    let amount: string | null = null;
    if (col.amount !== undefined) amount = parseMoney(r[col.amount]);
    else {
      const d = col.debit !== undefined ? parseMoney(r[col.debit]) : null;
      const c = col.credit !== undefined ? parseMoney(r[col.credit]) : null;
      if (d && !Dec.of(d).isZero()) amount = Dec.of(d).abs().mul("-1").toFixed(2);
      else if (c && !Dec.of(c).isZero()) amount = Dec.of(c).abs().toFixed(2);
    }
    if (BALANCE_ROW.test(normalize(memo)) && (!amount || /SALDO/.test(normalize(memo)))) {
      if (bal ?? amount) { if (!txs.length) opening = bal ?? amount; else closing = bal ?? amount; }
      continue;
    }
    if (!date || !amount || Dec.of(amount).isZero()) continue;
    txs.push({ type: null, postedOn: date, amount, fitId: null, checkNumber: col.doc !== undefined ? (r[col.doc] || null) : null, memo: memo || null, payee: null });
    if (bal) balances.push({ i: txs.length - 1, balance: bal });
  }
  if (!txs.length) throw new StatementTextError("Nenhum movimento encontrado abaixo do cabeçalho");
  const proof = proveBalances(txs, balances, opening, closing);
  const dates = txs.map((t) => t.postedOn).sort();
  const last = balances.length ? balances[balances.length - 1]!.balance : closing;
  return {
    format, proof: proof ?? "SEM_SALDO", bankCode: hints.bankCode, branch: hints.branch, account: hints.account ?? "", currency: "BRL",
    periodStart: dates[0]!, periodEnd: dates[dates.length - 1]!, balance: last, balanceDate: last ? dates[dates.length - 1]! : null, transactions: txs,
  };
}

/** Confere os saldos; erro quando o arquivo traz saldo e a conta não fecha. Nulo = sem saldo para conferir. */
function proveBalances(txs: OfxTransaction[], balances: { i: number; balance: string }[], opening: string | null, closing: string | null): ParsedStatement["proof"] | null {
  if (balances.length >= 2) {
    // saldo por linha: entre dois saldos consecutivos, saldo anterior + movimentos = saldo
    for (let k = 1; k < balances.length; k++) {
      const a = balances[k - 1]!;
      const b = balances[k]!;
      let sum = Dec.of(a.balance);
      for (let i = a.i + 1; i <= b.i; i++) sum = sum.add(txs[i]!.amount);
      if (sum.cmp(b.balance) !== 0) {
        throw new StatementTextError(`Saldo não fecha em ${txs[b.i]!.postedOn.split("-").reverse().join("/")} (${txs[b.i]!.memo ?? ""}): esperado ${b.balance}, pelos movimentos ${sum.toFixed(2)}`);
      }
    }
    if (opening && balances[0]) {
      let sum = Dec.of(opening);
      for (let i = 0; i <= balances[0].i; i++) sum = sum.add(txs[i]!.amount);
      if (sum.cmp(balances[0].balance) !== 0) throw new StatementTextError(`Saldo anterior (${opening}) + primeiros movimentos não fecha com o saldo da linha (${balances[0].balance})`);
    }
    return "SALDO_POR_LINHA";
  }
  if (opening && closing) {
    const sum = txs.reduce((s, t) => s.add(t.amount), Dec.of(opening));
    if (sum.cmp(closing) !== 0) throw new StatementTextError(`Saldo anterior ${opening} + movimentos (${sum.toFixed(2)}) não fecha com o saldo final ${closing}`);
    return "SALDO_INICIAL_FINAL";
  }
  return null;
}

// ------------------------------------------------------------------ CSV

export function readCsvRows(text: string): string[][] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const sample = lines.slice(0, 20).join("\n");
  const delim = [";", "\t", ","].map((d) => [d, (sample.match(new RegExp(d === "\t" ? "\t" : `\\${d}`, "g")) ?? []).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  return lines.map((line) => {
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { out.push(cur.trim()); cur = ""; } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  });
}

// ------------------------------------------------------------------ PDF

const MONEY = String.raw`-?\(?\d{1,3}(?:\.\d{3})*,\d{2}\)?\s?[DC-]?`;
const LINE = new RegExp(String.raw`^(\d{2}\/\d{2}(?:\/\d{2,4})?)\s+(.+?)\s+(${MONEY})(?:\s+(${MONEY}))?$`);

export function parsePdfStatement(text: string): ParsedStatement {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const full = /\b(\d{2})\/(\d{2})\/(\d{4})\b/.exec(text);
  let year = full ? Number(full[3]) : undefined;
  let lastMonth = 0;
  const txs: OfxTransaction[] = [];
  const balances: { i: number; balance: string }[] = [];
  let opening: string | null = null;
  let closing: string | null = null;
  let lastDate: string | null = null;
  for (const l of lines) {
    const m = LINE.exec(l);
    const isBal = BALANCE_ROW.test(normalize(l));
    if (!m) {
      // "SALDO ANTERIOR 1.234,56" sem data
      const b = /\bSALDO\b.*?(-?\d{1,3}(?:\.\d{3})*,\d{2}\s?[DC-]?)$/.exec(normalize(l));
      if (b) { if (!txs.length) opening ??= parseMoney(b[1]); else closing = parseMoney(b[1]); }
      continue;
    }
    const [, d, memoRaw, v1, v2] = m;
    if (d!.length === 5 && year) {
      const mo = Number(d!.slice(3, 5));
      if (lastMonth && mo < lastMonth) year++;
      lastMonth = mo;
    }
    const date = parseDate(d, year);
    const memo = memoRaw!.trim();
    if (isBal && /SALDO/.test(normalize(memo))) {
      const v = parseMoney(v2 ?? v1);
      if (!txs.length) opening = v; else closing = v;
      continue;
    }
    const amount = parseMoney(v1);
    if (!date || !amount || Dec.of(amount).isZero()) continue;
    lastDate = date;
    txs.push({ type: null, postedOn: date, amount, fitId: null, checkNumber: null, memo, payee: null });
    if (v2) { const b = parseMoney(v2); if (b) balances.push({ i: txs.length - 1, balance: b }); }
  }
  if (!txs.length) throw new StatementTextError("Nenhum movimento reconhecido no PDF (linhas com data, histórico e valor). Envie OFX ou Excel");
  const proof = proveBalances(txs, balances, opening, closing);
  if (!proof) throw new StatementTextError("PDF sem saldo para conferir os movimentos: a IARIS só aceita PDF quando o saldo fecha. Envie OFX ou Excel");
  const hints = accountHints(lines.slice(0, 30).join("\n"));
  const dates = txs.map((t) => t.postedOn).sort();
  const last = balances.length ? balances[balances.length - 1]!.balance : closing;
  return {
    format: "PDF", proof, bankCode: hints.bankCode, branch: hints.branch, account: hints.account ?? "", currency: "BRL",
    periodStart: dates[0]!, periodEnd: dates[dates.length - 1]!, balance: last, balanceDate: lastDate, transactions: txs,
  };
}
