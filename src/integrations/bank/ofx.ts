/**
 * Leitura determinística de extrato OFX (1.x SGML e 2.x XML), sem IA.
 *
 * Bancos brasileiros variam: tags sem fechamento, CHARSET 1252, valor com
 * vírgula, data com fuso "[-3:BRT]", BRANCHID ausente (agência dentro do
 * ACCTID). O que não dá para ler com segurança vira erro, nunca chute.
 */

export interface OfxTransaction {
  type: string | null;
  postedOn: string;
  amount: string;
  fitId: string | null;
  checkNumber: string | null;
  memo: string | null;
  payee: string | null;
}

export interface OfxStatement {
  bankCode: string | null;
  branch: string | null;
  account: string;
  currency: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  balance: string | null;
  balanceDate: string | null;
  transactions: OfxTransaction[];
}

export class OfxError extends Error {}

export function decodeOfx(buf: Buffer): string {
  const head = buf.subarray(0, 600).toString("latin1");
  const utf8 = /ENCODING:\s*UTF-?8|encoding=["']utf-?8/i.test(head) && !/CHARSET:\s*1252/i.test(head);
  return buf.toString(utf8 ? "utf8" : "latin1").replace(/^﻿/, "");
}

const unescape = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();

/** Valor de uma tag simples dentro de um trecho (SGML ou XML). */
function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}>([^<\\r\\n]*)`, "i").exec(block);
  if (!m) return null;
  const v = unescape(m[1]!);
  return v === "" ? null : v;
}

/** Blocos <NAME>...</NAME>; em SGML o fim é a próxima abertura do mesmo bloco ou o fecho do pai. */
function blocks(text: string, name: string, endOf: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}>`, "gi");
  const idx: number[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) idx.push(m.index);
  for (let i = 0; i < idx.length; i++) {
    const start = idx[i]!;
    const close = text.toUpperCase().indexOf(`</${name.toUpperCase()}>`, start);
    const next = idx[i + 1] ?? Infinity;
    const parentEnd = text.toUpperCase().indexOf(`</${endOf.toUpperCase()}>`, start);
    const end = Math.min(close >= 0 ? close : Infinity, next, parentEnd >= 0 ? parentEnd : Infinity, text.length);
    out.push(text.slice(start, end));
  }
  return out;
}

/** "20260915120000[-3:BRT]" → "2026-09-15" */
export function ofxDate(v: string | null): string | null {
  if (!v) return null;
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(v);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  return `${y}-${mo}-${d}`;
}

/** "-1.234,56" | "-1234.56" | "1234,5" → "-1234.56" */
export function ofxAmount(v: string | null): string | null {
  if (!v) return null;
  let s = v.replace(/\s/g, "");
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
  const neg = s.startsWith("-");
  const [i, d = ""] = s.replace(/^[+-]/, "").split(".");
  if (d.length > 2 && !/^0+$/.test(d.slice(2))) return null;
  const out = `${Number(i)}.${(d + "00").slice(0, 2)}`;
  return neg && Number(out) !== 0 ? `-${out}` : out;
}

export function parseOfx(raw: string): OfxStatement {
  const start = raw.search(/<OFX>/i);
  if (start < 0) throw new OfxError("Arquivo sem bloco <OFX>: não é um extrato OFX");
  const body = raw.slice(start);
  const stmt = blocks(body, "STMTRS", "BANKMSGSRSV1")[0] ?? blocks(body, "CCSTMTRS", "CREDITCARDMSGSRSV1")[0];
  if (!stmt) throw new OfxError("Extrato sem STMTRS (conta corrente) nem CCSTMTRS (cartão)");
  const from = blocks(stmt, "BANKACCTFROM", "STMTRS")[0] ?? blocks(stmt, "CCACCTFROM", "CCSTMTRS")[0] ?? "";
  const account = tag(from, "ACCTID");
  if (!account) throw new OfxError("Extrato sem número da conta (ACCTID)");
  const list = blocks(stmt, "BANKTRANLIST", "STMTRS")[0] ?? "";
  const transactions: OfxTransaction[] = [];
  for (const b of blocks(list, "STMTTRN", "BANKTRANLIST")) {
    const postedOn = ofxDate(tag(b, "DTPOSTED"));
    const amount = ofxAmount(tag(b, "TRNAMT"));
    if (!postedOn || amount === null) throw new OfxError(`Lançamento ilegível no extrato (data ${tag(b, "DTPOSTED") ?? "—"}, valor ${tag(b, "TRNAMT") ?? "—"})`);
    if (Number(amount) === 0) continue;
    transactions.push({
      type: tag(b, "TRNTYPE"),
      postedOn,
      amount,
      fitId: tag(b, "FITID"),
      checkNumber: tag(b, "CHECKNUM"),
      memo: tag(b, "MEMO"),
      payee: tag(b, "NAME") ?? tag(b, "PAYEEID"),
    });
  }
  const bal = blocks(stmt, "LEDGERBAL", "STMTRS")[0] ?? "";
  return {
    bankCode: tag(from, "BANKID"),
    branch: tag(from, "BRANCHID"),
    account,
    currency: tag(stmt, "CURDEF"),
    periodStart: ofxDate(tag(list, "DTSTART")),
    periodEnd: ofxDate(tag(list, "DTEND")),
    balance: ofxAmount(tag(bal, "BALAMT")),
    balanceDate: ofxDate(tag(bal, "DTASOF")),
    transactions,
  };
}

/** Bancos mais comuns (código COMPE) para o nome da conta. */
export const BANK_NAMES: Record<string, string> = {
  "001": "Banco do Brasil", "033": "Santander", "041": "Banrisul", "070": "BRB", "077": "Inter", "085": "Ailos", "104": "Caixa",
  "136": "Unicred", "197": "Stone", "208": "BTG Pactual", "212": "Original", "237": "Bradesco", "260": "Nubank", "290": "PagSeguro",
  "323": "Mercado Pago", "336": "C6 Bank", "341": "Itaú", "380": "PicPay", "403": "Cora", "422": "Safra", "748": "Sicredi", "756": "Sicoob",
};

export function bankName(code: string | null): string {
  if (!code) return "Banco";
  const k = code.replace(/\D/g, "").padStart(3, "0").slice(-3);
  return BANK_NAMES[k] ?? `Banco ${k}`;
}
