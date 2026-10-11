import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { extractText, getDocumentProxy } from "unpdf";
import { appendEvent } from "../../platform/events/outbox.js";
import { audit } from "../../platform/audit/audit.js";
import type { Actor } from "../../shared/actor.js";
import { Dec } from "../../shared/decimal.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";
import { normalize } from "../../shared/text.js";
import { chartConfig } from "./chart-config.js";
import { LedgerError, OPENING_RULE, postEntry, type EntryLine } from "./ledger.js";

/**
 * Saldos de abertura herdados do escritório anterior (implantação).
 *
 * 1. Leitura determinística do balancete (PDF do Domínio): cada linha traz
 *    saldo atual, crédito, débito, saldo anterior, código reduzido e nome.
 *    Cada linha é conferida (anterior + débito − crédito = atual).
 * 2. Árvore pelas somas: uma conta é sintética quando as linhas seguintes somam
 *    exatamente os seus quatro valores; as demais são analíticas. Conferência:
 *    analíticas devedoras = "CONTAS DEVEDORAS" do resumo e D = C.
 * 3. De/para para o plano da empresa, nesta ordem: conta bancária (pelo banco),
 *    código reduzido + nome iguais, nome igual, papel (clientes/fornecedores),
 *    nome equivalente (mesmas palavras), nome semelhante. Sem de/para = o
 *    lançamento não sai (nunca contrapartida fictícia).
 * 4. Um lançamento de abertura (origem MIGRACAO, regra saldo-abertura) no
 *    primeiro dia do plano; nos relatórios vale como saldo da véspera.
 *    Todo saldo nasce INHERITED_NOT_VALIDATED (responsabilidade do anterior).
 */

export type InheritedStatus = "CONFIRMED" | "RECONCILED" | "INHERITED_NOT_VALIDATED" | "DIVERGENT" | "NO_COMPOSITION" | "UNDER_INVESTIGATION";
export type MapMethod = "CONTA_BANCARIA" | "CODIGO_E_NOME" | "NOME" | "PAPEL" | "NOME_EQUIVALENTE" | "NOME_SEMELHANTE";

export interface BalanceteLine { code: string; name: string; prev: string; debit: string; credit: string; curr: string }
export interface BalanceteLeaf extends BalanceteLine { path: string[] }
export interface Balancete {
  cnpj: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  firm: string | null;
  lines: BalanceteLine[];
  leaves: BalanceteLeaf[];
  totalDebit: string;
}

export class OpeningBalanceError extends LedgerError {}

const N = String.raw`\d{1,3}(?:\.\d{3})*,\d{2}`;
const LINE = new RegExp(String.raw`^(${N})([DC]?)(${N})(${N})(${N})([DC]?)(\d+) (.+?)\s*$`);
const money = (s: string) => s.replace(/\./g, "").replace(",", ".");
const signed = (v: string, side: string) => (side === "C" ? Dec.of(money(v)).mul("-1") : Dec.of(money(v))).toFixed(2);
const brDate = (d: string) => d.split("/").reverse().join("-");

export async function pdfText(bytes: Uint8Array): Promise<string> {
  // pdf.js recusa Buffer: cópia em Uint8Array puro
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(doc, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}

/** Lê o balancete (texto do PDF). Erro se alguma linha não fechar ou a árvore não bater com o resumo. */
export function parseBalancete(text: string): Balancete {
  const raw = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lines: BalanceteLine[] = [];
  for (const l of raw) {
    const m = LINE.exec(l);
    if (!m) continue;
    const [, curr, cs, credit, debit, prev, ps, code, name] = m;
    const line = { code: code!, name: name!.trim(), prev: signed(prev!, ps!), debit: Dec.of(money(debit!)).toFixed(2), credit: Dec.of(money(credit!)).toFixed(2), curr: signed(curr!, cs!) };
    if (Dec.of(line.prev).add(line.debit).sub(line.credit).cmp(line.curr) !== 0) {
      throw new OpeningBalanceError(`Linha do balancete não fecha (anterior + débito − crédito ≠ atual): ${code} ${name}`);
    }
    lines.push(line);
  }
  if (!lines.length) throw new OpeningBalanceError("Nenhuma conta reconhecida no balancete");
  const cnpj = /C\.?N\.?P\.?J\.?:?\s*([0-9A-Z.\/-]{14,18})/i.exec(text)?.[1]?.replace(/[^0-9A-Z]/gi, "").toUpperCase() ?? null;
  const per = /Per[íi]odo:?\s*(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4})/i.exec(text);
  const crcIdx = raw.findIndex((l) => /CRC/i.test(l));
  const firm = crcIdx > 0 ? `${raw[crcIdx - 1]} (${raw[crcIdx]})`.replace(/\s+/g, " ").slice(0, 200) : null;

  // Árvore pelas somas: memo por linha (o resultado de uma linha não depende de quem é o pai)
  const vec = (l: BalanceteLine) => [Dec.of(l.prev), Dec.of(l.debit), Dec.of(l.credit), Dec.of(l.curr)];
  const memo = new Map<number, { end: number; kids: number[] }>();
  const parse = (i: number): { end: number; kids: number[] } => {
    const hit = memo.get(i);
    if (hit) return hit;
    const target = vec(lines[i]!);
    let acc = [Dec.ZERO, Dec.ZERO, Dec.ZERO, Dec.ZERO];
    const kids: number[] = [];
    let result = { end: i, kids: [] as number[] };
    for (let j = i + 1; j < lines.length; ) {
      const r = parse(j);
      const child = vec(lines[j]!);
      acc = acc.map((a, k) => a.add(child[k]!));
      if (acc[1]!.cmp(target[1]!) > 0 || acc[2]!.cmp(target[2]!) > 0) break;
      kids.push(j);
      if (acc.every((a, k) => a.cmp(target[k]!) === 0)) { result = { end: r.end, kids }; break; }
      j = r.end + 1;
    }
    memo.set(i, result);
    return result;
  };
  const leaves: BalanceteLeaf[] = [];
  const collect = (i: number, path: string[]) => {
    const r = parse(i);
    if (!r.kids.length) leaves.push({ ...lines[i]!, path });
    else for (const k of r.kids) collect(k, [...path, lines[i]!.name]);
  };
  for (let i = 0; i < lines.length; i = parse(i).end + 1) collect(i, []);

  const deb = leaves.reduce((s, l) => (Dec.of(l.curr).gt("0") ? s.add(l.curr) : s), Dec.ZERO);
  const net = leaves.reduce((s, l) => s.add(l.curr), Dec.ZERO);
  if (!net.isZero()) throw new OpeningBalanceError(`Contas analíticas do balancete não fecham: diferença de ${net.toFixed(2)}`);
  const summary = new RegExp(String.raw`CONTAS DEVEDORAS\s.*?(${N})D\s*$`, "m").exec(text);
  if (summary && Dec.of(money(summary[1]!)).cmp(deb) !== 0) {
    throw new OpeningBalanceError(`Soma das contas devedoras (${deb.toFixed(2)}) diferente do resumo do balancete (${money(summary[1]!)})`);
  }
  return { cnpj, periodStart: per ? brDate(per[1]!) : null, periodEnd: per ? brDate(per[2]!) : null, firm, lines, leaves, totalDebit: deb.toFixed(2) };
}

// ------------------------------------------------------------------ de/para

interface Account { code: string; name: string; short_code: string | null; parent_code: string | null }
export interface Mapped extends BalanceteLeaf { account: string | null; accountName: string | null; method: MapMethod | null; status: InheritedStatus; note?: string }

const STOP = new Set(["DE", "DA", "DO", "DOS", "DAS", "E", "A", "O", "EM", "COM", "PARA", "POR", "S/A", "SA", "LTDA"]);
const key = (s: string) => normalize(s).replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const tokens = (s: string) => key(s).split(" ").filter((w) => w && !STOP.has(w));
const same = (a: string, b: string) => a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));

const BANKS: [RegExp, string][] = [
  [/\bITAU\b/, "341"], [/\bBRADESCO\b/, "237"], [/\bNU ?BANK\b/, "260"], [/\bBANCO DO BRASIL\b|\bBB\b/, "001"], [/\bCAIXA ECONOMICA\b|\bCEF\b/, "104"],
  [/\bSANTANDER\b/, "033"], [/\bINTER\b/, "077"], [/\bSICOOB\b/, "756"], [/\bSICREDI\b/, "748"], [/\bC6\b/, "336"], [/\bBTG\b/, "208"], [/\bSAFRA\b/, "422"],
];
const BANK_WORD: Record<string, RegExp> = { "341": /ITAU/, "237": /BRADESCO/, "260": /NUBANK|NU BANK/, "001": /BANCO DO BRASIL/, "104": /CAIXA ECONOMICA/, "033": /SANTANDER/, "077": /INTER\b/, "756": /SICOOB/, "748": /SICREDI/, "336": /C6/, "208": /BTG/, "422": /SAFRA/ };

/** Propõe a conta do plano da empresa para cada analítica do balancete. */
export async function mapLeaves(tx: PoolClient, entityId: string, leaves: BalanceteLeaf[]): Promise<Mapped[]> {
  const acc = (await tx.query<Account>(
    "SELECT code, name, short_code, parent_code FROM chart_account WHERE entity_id = $1 AND analytic AND valid_to IS NULL ORDER BY code",
    [entityId],
  )).rows;
  const all = (await tx.query<Account>("SELECT code, name, short_code, parent_code FROM chart_account WHERE entity_id = $1 AND valid_to IS NULL", [entityId])).rows;
  const nameOf = new Map(all.map((a) => [a.code, a.name]));
  const banks = (await tx.query<{ bank_code: string | null; code: string }>(
    "SELECT b.bank_code, c.code FROM bank_account b JOIN chart_account c ON c.id = b.ledger_account_id WHERE b.entity_id = $1 ORDER BY b.created_at",
    [entityId],
  )).rows;
  const cfg = await chartConfig(tx, entityId);
  const under = (a: Account, root: string | undefined) => Boolean(root) && (a.code === root || a.code.startsWith(`${root}.`));
  const out: Mapped[] = [];
  for (const l of leaves) {
    const k = key(l.name);
    const pathKey = l.path.map(key).join(" > ");
    const ok = (a: Account, method: MapMethod, note?: string): Mapped => ({ ...l, account: a.code, accountName: a.name, method, status: "INHERITED_NOT_VALIDATED", ...(note ? { note } : {}) });
    let m: Mapped | null = null;

    // 1. Banco: pelo código do banco no nome da conta
    const isMov = /BANCOS? CONTA MOVIMENTO|BANCOS?\b/.test(pathKey) && !/APLICAC/.test(pathKey);
    const isApl = /APLICAC/.test(pathKey) || /APLICAC/.test(k);
    const bank = BANKS.find(([re]) => re.test(k))?.[1];
    if (bank && (isMov || isApl)) {
      if (isMov) {
        const own = banks.find((b) => (b.bank_code ?? "").replace(/\D/g, "").padStart(3, "0").slice(-3) === bank);
        const ownAcc = own ? acc.find((a) => a.code === own.code) : undefined;
        if (ownAcc) m = ok(ownAcc, "CONTA_BANCARIA", "conta do extrato do banco");
        else {
          const c = acc.filter((a) => under(a, cfg.roles.BANCOS) && BANK_WORD[bank]!.test(key(a.name)));
          if (c.length === 1) m = ok(c[0]!, "CONTA_BANCARIA");
        }
      } else {
        const c = acc.filter((a) => under(a, cfg.roles.APLICACOES) && BANK_WORD[bank]!.test(key(a.name)));
        if (c.length === 1) m = ok(c[0]!, "CONTA_BANCARIA");
      }
    }
    // 2. Código reduzido e nome iguais
    m ??= ((a) => (a ? ok(a, "CODIGO_E_NOME") : null))(acc.find((a) => a.short_code === l.code && key(a.name) === k));
    // 3. Nome igual (único; empate: o de mesmo grupo pai)
    if (!m) {
      const c = acc.filter((a) => key(a.name) === k);
      const parentKey = l.path.length ? key(l.path[l.path.length - 1]!) : null;
      const pick = c.length === 1 ? c[0] : c.find((a) => a.parent_code && key(nameOf.get(a.parent_code) ?? "") === parentKey);
      if (pick) m = ok(pick, "NOME");
    }
    // 4. Papel
    if (!m) {
      const role = /CLIENTES|DUPLICATAS A RECEBER/.test(k) && /ATIVO/.test(pathKey) ? cfg.roles.CLIENTES
        : /FORNECEDORES/.test(k) && /PASSIVO/.test(pathKey) ? cfg.roles.FORNECEDORES : undefined;
      const a = role ? acc.find((x) => x.code === role) : undefined;
      if (a) m = ok(a, "PAPEL");
    }
    // 5/6. Mesmas palavras; senão a mais parecida (empate: menor código), no mesmo grupo de natureza
    if (!m) {
      const t = tokens(l.name);
      const group = (code: string) => code.split(".")[0];
      const leafGroup = /^ATIVO/.test(pathKey) ? "1" : /PATRIMONIO|PASSIVO/.test(pathKey) ? "2" : /RECEITA/.test(pathKey) ? "3" : /CUSTO|DESPESA/.test(pathKey) ? "4" : null;
      const scored = acc
        .filter((a) => !leafGroup || group(a.code) === leafGroup)
        .map((a) => {
          const at = tokens(a.name);
          const hit = t.filter((w) => at.some((x) => same(w, x))).length;
          return { a, hit, score: t.length ? hit / t.length : 0, extra: at.length - hit, equal: hit === t.length && at.length === t.length };
        })
        .filter((x) => x.score >= 0.6)
        .sort((x, y) => Number(y.equal) - Number(x.equal) || y.score - x.score || x.extra - y.extra || x.a.code.localeCompare(y.a.code));
      const best = scored[0];
      if (best) m = ok(best.a, best.equal ? "NOME_EQUIVALENTE" : "NOME_SEMELHANTE", best.equal ? undefined : "de/para por semelhança de nome: revisar");
    }
    out.push(m ?? { ...l, account: null, accountName: null, method: null, status: "INHERITED_NOT_VALIDATED" });
  }
  return out;
}

// ------------------------------------------------------------------ importação

/** `text`: texto já extraído (planilha/relatório em texto); sem ele, o PDF em `bytes` é lido. */
export interface OpeningImportInput { entityId: string; fileName: string; bytes: Uint8Array; text?: string }

/** Prévia: o que seria lançado (nada é gravado). */
export async function previewOpeningBalances(pool: Pool, tenantId: string, input: OpeningImportInput) {
  const bal = parseBalancete(input.text ?? (await pdfText(input.bytes)));
  return withTenant(pool, tenantId, async (tx) => ({ balancete: bal, mapped: await mapLeaves(tx, input.entityId, bal.leaves) }));
}

/** Importa e lança os saldos de abertura (decisão de pessoa). Idempotente pelo arquivo. */
export async function importOpeningBalances(pool: Pool, tenantId: string, input: OpeningImportInput, actor: Actor) {
  if (actor.kind !== "USER") throw new OpeningBalanceError("Saldos de abertura herdados são lançados por decisão de uma pessoa");
  const sha = createHash("sha256").update(input.bytes).digest();
  const bal = parseBalancete(input.text ?? (await pdfText(input.bytes)));
  const periodEnd = bal.periodEnd;
  if (!periodEnd) throw new OpeningBalanceError("O balancete não informa o período");
  return withTenant(pool, tenantId, async (tx) => {
    const ent = await tx.query<{ cnpj: string | null }>("SELECT cnpj FROM entity WHERE id = $1", [input.entityId]);
    if (!ent.rows[0]) throw new OpeningBalanceError("Empresa não encontrada");
    if (bal.cnpj && ent.rows[0].cnpj && bal.cnpj !== ent.rows[0].cnpj.trim()) throw new OpeningBalanceError(`O balancete é de outro CNPJ (${bal.cnpj})`);
    const dup = await tx.query<{ id: string; entry_id: string }>("SELECT id, entry_id FROM opening_balance_import WHERE entity_id = $1 AND sha256 = $2", [input.entityId, sha]);
    if (dup.rows[0]) return { importId: dup.rows[0].id, entryId: dup.rows[0].entry_id, created: false, lines: [] as Mapped[] };
    const other = await tx.query(
      `SELECT 1 FROM opening_balance_import i JOIN journal_entry e ON e.id = i.entry_id
        WHERE i.entity_id = $1 AND NOT EXISTS (SELECT 1 FROM journal_entry x WHERE x.reverses_id = e.id)`,
      [input.entityId],
    );
    if (other.rowCount) throw new OpeningBalanceError("A empresa já tem saldos de abertura lançados: estorne o lançamento anterior antes de importar outro balancete");
    const start = (await tx.query<{ d: string | null }>("SELECT min(valid_from)::text AS d FROM chart_account WHERE entity_id = $1 AND source <> 'BANCO'", [input.entityId])).rows[0]?.d;
    if (!start) throw new OpeningBalanceError("A empresa ainda não tem plano de contas");
    const dayAfter = new Date(new Date(`${periodEnd}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
    if (dayAfter !== start) throw new OpeningBalanceError(`O balancete vai até ${bal.periodEnd}, mas a contabilidade no IARIS começa em ${start}: os saldos precisam ser do dia anterior ao início`);

    const mapped = await mapLeaves(tx, input.entityId, bal.leaves);
    const missing = mapped.filter((m) => !m.account && !Dec.of(m.curr).isZero());
    if (missing.length) throw new OpeningBalanceError(`Sem conta no plano para: ${missing.map((m) => `${m.code} ${m.name}`).join("; ")}`);

    const pe = periodEnd.split("-").reverse().join("/");
    const lines: EntryLine[] = mapped
      .filter((m) => !Dec.of(m.curr).isZero())
      .map((m) => {
        const v = Dec.of(m.curr);
        const h = `${m.code} ${m.name} (saldo em ${pe})`.slice(0, 200);
        return v.gt("0") ? { account: m.account!, debit: v.toFixed(2), history: h } : { account: m.account!, credit: v.mul("-1").toFixed(2), history: h };
      });
    const total = lines.reduce((s, l) => s.add(l.debit ?? "0"), Dec.ZERO).toFixed(2);
    const importId = newId();
    const entry = await postEntry(tx, {
      entityId: input.entityId, date: start, origin: "MIGRACAO", originRef: `opening_balance_import:${importId}`, rule: OPENING_RULE, confidence: "1",
      history: `Saldos de abertura em ${pe} — balancete do escritório anterior${bal.firm ? `: ${bal.firm}` : ""}`.slice(0, 300),
      idempotencyKey: `abertura:${input.entityId}:${sha.toString("hex").slice(0, 32)}`,
      evidence: [{ kind: "opening_balance_import", id: importId }], lines,
    }, actor);
    await tx.query(
      `INSERT INTO opening_balance_import (id, tenant_id, entity_id, file_name, sha256, period_end, entry_date, source_firm, lines, total_debit, total_credit, entry_id, created_by)
       VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11)`,
      [importId, input.entityId, input.fileName.slice(0, 200), sha, bal.periodEnd, start, bal.firm, JSON.stringify(mapped), total, entry.id, actor.id],
    );
    await appendEvent(tx, {
      type: "OPENING_BALANCES_IMPORTED", schemaVersion: 1, producer: { kind: "engine", name: "ledger", version: "0.1.0" },
      idempotencyKey: `abertura:${importId}`, entityId: input.entityId,
      payload: { entity_id: input.entityId, import_id: importId, entry_id: entry.id, period_end: bal.periodEnd, accounts: lines.length, total,
        by_similarity: mapped.filter((m) => m.method === "NOME_SEMELHANTE").length },
    });
    await audit(tx, { actor, action: "ledger.opening_balances_imported", resourceType: "opening_balance_import", resourceId: importId, entityId: input.entityId,
      data: { file: input.fileName, sha256: sha.toString("hex"), period_end: bal.periodEnd, firm: bal.firm, accounts: lines.length, total,
        mapping: mapped.map((m) => ({ from: `${m.code} ${m.name}`, to: m.account, method: m.method })) },
      evidenceRefs: [`arquivo:sha256:${sha.toString("hex")}`] });
    return { importId, entryId: entry.id, created: true, lines: mapped, total };
  });
}

/** Importações de saldos de abertura da empresa (para a tela). */
export async function openingBalanceImports(tx: PoolClient, entityId: string) {
  const r = await tx.query<{ id: string; file_name: string; period_end: string; source_firm: string | null; lines: Mapped[]; total_debit: string; entry_id: string; created_by: string; created_at: Date; reversed: boolean }>(
    `SELECT i.id, i.file_name, i.period_end::text, i.source_firm, i.lines, i.total_debit::text, i.entry_id, i.created_by, i.created_at,
            EXISTS (SELECT 1 FROM journal_entry x WHERE x.reverses_id = i.entry_id) AS reversed
       FROM opening_balance_import i WHERE i.entity_id = $1 ORDER BY i.created_at DESC`,
    [entityId],
  );
  return r.rows;
}
