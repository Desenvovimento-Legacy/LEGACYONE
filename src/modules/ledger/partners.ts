import type { PoolClient } from "pg";
import { NFSE_TAX_PARSER } from "../../integrations/nfse/nfse-taxes.js";
import { audit } from "../../platform/audit/audit.js";
import { appendEvent, type Producer } from "../../platform/events/outbox.js";
import type { Actor } from "../../shared/actor.js";
import { Dec } from "../../shared/decimal.js";
import { newId } from "../../shared/ids.js";
import { normalize } from "../../shared/text.js";
import { openItems } from "./reports.js";
import { serviceAccount, TAKEN_SERVICES_RULE } from "./service-accounts.js";
import { chartConfig, roleAccount } from "./chart-config.js";

/**
 * Cadastro de parceiros (fornecedores e clientes) de cada empresa.
 *
 * Nasce sozinho das NFS-e: prestador da nota tomada = FORNECEDOR, tomador da
 * nota emitida = CLIENTE. Com ele a IARIS sabe, no mês seguinte, quem é
 * recorrente, qual conta usa, o que está em aberto e se a nota esperada chegou;
 * e reconhece o parceiro no histórico do extrato (CNPJ, nome ou como ele já
 * apareceu no banco antes).
 *
 * Reconhecer o parceiro no banco NÃO lança nada sozinho: só desempata notas de
 * mesmo valor e permite quitar várias notas do mesmo parceiro num pagamento
 * (soma exata). Valor que não fecha vira pendência com hipóteses.
 */

const PRODUCER: Producer = { kind: "engine", name: "ledger", version: "0.1.0" };

export type PartnerRole = "FORNECEDOR" | "CLIENTE";

export class PartnerError extends Error {}

/** Palavras que não identificam ninguém (natureza jurídica, conectivos, ramo genérico). */
const GENERIC = new Set([
  "LTDA", "ME", "EPP", "EIRELI", "SA", "S/A", "SS", "SLU", "DE", "DA", "DO", "DOS", "DAS", "E", "EM", "CIA", "COMERCIO", "COMERCIAL",
  "SERVICOS", "SERVICO", "INDUSTRIA", "COOPERATIVA", "TRABALHO", "MEDICO", "ASSOCIACAO", "SOCIEDADE", "EMPRESA", "GRUPO", "BRASIL",
  "TECNOLOGIA", "SOLUCOES", "SISTEMAS", "EQUIPAMENTOS", "CONSULTORIA", "ASSESSORIA", "TRANSPORTES", "COLETIVO", "MANUTENCAO", "NACIONAL",
  "PARTICIPACOES", "ADMINISTRACAO", "CENTRO", "INSTITUTO", "CLINICA", "LOJA", "CASA", "CIDADE", "BANCO", "PAGAMENTOS", "PAGAMENTO",
]);
/** Palavras do extrato que não são o nome de ninguém. */
const BANK_WORDS = new Set([
  "PIX", "TED", "DOC", "TEF", "ENVIADO", "ENVIADA", "ENV", "RECEBIDO", "RECEBIDA", "REC", "TRANSF", "TRANSFERENCIA", "PAGTO", "PGTO", "PAGAMENTO",
  "PAG", "BOLETO", "BOLETOS", "TIT", "TITULO", "TITULOS", "COBRANCA", "DEB", "DEBITO", "CRED", "CREDITO", "AUT", "AUTOMATICO", "SISPAG",
  "FORNECEDOR", "FORNECEDORES", "CONTA", "CC", "AG", "QRCODE", "QR", "CODE", "INTERNET", "IB", "APP", "MOBILE", "PARA", "DE", "DA", "DO",
  "A", "O", "EM", "MESMA", "TITULARIDADE", "OUTRA", "INSTITUICAO", "SALDO", "LANC", "LANCAMENTO", "COMPRA", "CARTAO", "DEVOLUCAO", "TARIFA",
  "CPF", "CNPJ", "CHAVE", "ELETRONICO", "ELETRONICA", "BCO", "BANCO",
]);

const words = (s: string | null | undefined) => normalize(s).replace(/[^A-Z0-9/ ]/g, " ").split(" ").filter(Boolean);
/** Histórico do banco sem números e sem palavras de banco: o que sobra é o nome. */
export const bankText = (memo: string | null | undefined) =>
  words(memo).filter((w) => !/\d/.test(w) && !BANK_WORDS.has(w)).join(" ");
/** Primeira palavra que identifica o nome (≥ 5 letras, fora das genéricas). */
export const nameKey = (name: string | null): string | null => significant(name).find((w) => w.length >= 5) ?? null;
const significant = (name: string | null) => words(name).filter((w) => w.length >= 4 && !GENERIC.has(w) && !/^\d+$/.test(w));

// ------------------------------------------------------------------ cadastro automático

/** Registra os parceiros que aparecem nas NFS-e da empresa (idempotente). */
export async function syncPartners(tx: PoolClient, entityId: string): Promise<number> {
  const { rows } = await tx.query<{ doc: string; role: PartnerRole; name: string | null; first_seen: string; source: string }>(
    `WITH n AS (
       SELECT CASE role WHEN 'TOMADA' THEN provider_doc ELSE taker_doc END AS doc,
              CASE role WHEN 'TOMADA' THEN 'FORNECEDOR' ELSE 'CLIENTE' END AS prole,
              CASE role WHEN 'TOMADA' THEN provider_name ELSE taker_name END AS name,
              CASE role WHEN 'TOMADA' THEN 'NFSE_TOMADA' ELSE 'NFSE_PRESTADA' END AS source,
              (issued_at AT TIME ZONE 'America/Sao_Paulo')::date AS issued
         FROM nfse_document WHERE entity_id = $1 AND role IN ('TOMADA', 'PRESTADA'))
     SELECT n.doc, n.prole AS role, (array_agg(n.name ORDER BY n.issued DESC) FILTER (WHERE n.name IS NOT NULL))[1] AS name,
            min(n.issued)::text AS first_seen, min(n.source) AS source
       FROM n
      WHERE n.doc ~ '^[0-9A-Z]{11}([0-9A-Z]{3})?$'
        AND NOT EXISTS (SELECT 1 FROM partner p WHERE p.entity_id = $1 AND p.doc = n.doc AND p.role = n.prole)
      GROUP BY n.doc, n.prole`,
    [entityId],
  );
  for (const r of rows) {
    await tx.query(
      `INSERT INTO partner (id, tenant_id, entity_id, doc, role, name, source, first_seen)
       VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [newId(), entityId, r.doc, r.role, r.name, r.source, r.first_seen],
    );
  }
  if (rows.length) {
    await appendEvent(tx, {
      type: "PARTNERS_REGISTERED", schemaVersion: 1, producer: PRODUCER, idempotencyKey: `parceiros:${entityId}:${newId()}`, entityId,
      payload: { entity_id: entityId, suppliers: rows.filter((r) => r.role === "FORNECEDOR").length, customers: rows.filter((r) => r.role === "CLIENTE").length, source: "NFSE" },
    });
  }
  return rows.length;
}

// ------------------------------------------------------------------ reconhecimento no extrato

interface IndexedPartner { id: string; doc: string; role: PartnerRole; name: string | null; key: string | null; aliases: string[] }
export interface PartnerIndex { partners: IndexedPartner[] }
export interface IdentifiedPartner { id: string; doc: string; name: string | null; via: "DOC" | "APELIDO" | "NOME" }

export async function loadPartnerIndex(tx: PoolClient, entityId: string): Promise<PartnerIndex> {
  const { rows } = await tx.query<{ id: string; doc: string; role: PartnerRole; name: string | null; aliases: string[] }>(
    `SELECT p.id, p.doc, p.role, p.name,
            coalesce(array_agg(a.pattern) FILTER (WHERE a.id IS NOT NULL), '{}') AS aliases
       FROM partner p LEFT JOIN partner_alias a ON a.partner_id = p.id AND a.valid_to IS NULL
      WHERE p.entity_id = $1 GROUP BY p.id`,
    [entityId],
  );
  // Nome: primeira palavra que identifica (≥ 5 letras, fora das genéricas) e que nenhum outro parceiro da empresa usa.
  const firstSig = rows.map((r) => significant(r.name).find((w) => w.length >= 5) ?? null);
  const count = new Map<string, number>();
  for (const k of firstSig) if (k) count.set(k, (count.get(k) ?? 0) + 1);
  return {
    partners: rows.map((r, i) => {
      const k = firstSig[i] ?? null;
      const sameDoc = rows.filter((x) => x.doc === r.doc).length; // fornecedor e cliente ao mesmo tempo: mesmo nome
      return { ...r, key: k && (count.get(k) ?? 0) <= sameDoc ? k : null };
    }),
  };
}

/**
 * Quem é o parceiro deste movimento? Pela ordem: CNPJ/CPF no histórico,
 * apelido já visto no banco, nome. Dois candidatos no mesmo nível = não sei.
 */
export function identifyPartner(index: PartnerIndex, memo: string, role: PartnerRole): IdentifiedPartner | { ambiguous: string[] } | null {
  const list = index.partners.filter((p) => p.role === role);
  const digits = normalize(memo).replace(/[.\-/]/g, "");
  const docs = new Set(digits.match(/[0-9A-Z]{14}|\d{11}/g) ?? []);
  const text = ` ${bankText(memo)} `;
  const levels: [IdentifiedPartner["via"], (p: IndexedPartner) => boolean][] = [
    ["DOC", (p) => docs.has(p.doc)],
    ["APELIDO", (p) => p.aliases.some((a) => text.includes(` ${a} `))],
    ["NOME", (p) => p.key !== null && text.includes(` ${p.key} `)],
  ];
  for (const [via, test] of levels) {
    const hits = list.filter(test);
    if (hits.length === 1) return { id: hits[0]!.id, doc: hits[0]!.doc, name: hits[0]!.name, via };
    if (hits.length > 1) return { ambiguous: hits.map((h) => h.name ?? h.doc) };
  }
  return null;
}

/**
 * Aprende como o parceiro aparece no extrato a partir de um movimento já
 * conciliado pela nota (valor exato). Só guarda se o texto tiver ao menos uma
 * palavra do nome do parceiro — senão é histórico genérico do banco.
 */
export async function learnAlias(tx: PoolClient, entityId: string, partnerDoc: string, role: PartnerRole, memo: string, transactionId: string, date: string, actor: Actor): Promise<boolean> {
  const pattern = bankText(memo).slice(0, 60).trim();
  if (pattern.length < 4) return false;
  const p = await tx.query<{ id: string; name: string | null }>("SELECT id, name FROM partner WHERE entity_id = $1 AND doc = $2 AND role = $3", [entityId, partnerDoc, role]);
  const row = p.rows[0];
  if (!row) return false;
  const sig = new Set(significant(row.name).concat(words(row.name).filter((w) => w.length >= 4)));
  if (!pattern.split(" ").some((w) => sig.has(w))) return false;
  const r = await tx.query(
    `INSERT INTO partner_alias (id, tenant_id, entity_id, partner_id, pattern, source, evidence, valid_from, created_by)
     VALUES ($1, current_tenant(), $2, $3, $4, 'APRENDIDO', $5, $6, $7) ON CONFLICT DO NOTHING`,
    [newId(), entityId, row.id, pattern, JSON.stringify([{ kind: "bank_transaction", id: transactionId }]), date, `${actor.kind}:${actor.id}`],
  );
  return Boolean(r.rowCount);
}

// ------------------------------------------------------------------ visão do cadastro

const ym = (d: Date) => d.toISOString().slice(0, 7);
function monthsBack(month: string, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(ym(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 - i, 1))));
  return out;
}

export type PartnerMonthStatus = "NO_MES" | "ESPERADA" | "EVENTUAL" | "SEM_NOTA";

export interface PartnerView {
  id: string;
  doc: string;
  role: PartnerRole;
  name: string | null;
  firstSeen: string;
  officeClient: string | null;
  codes: string[];
  months: { month: string; notes: number; total: string }[];
  recurring: boolean;
  status: PartnerMonthStatus;
  expected: string | null;
  account: { code: string; source: "FORNECEDOR" | "TABELA" } | null;
  open: string;
  aliases: string[];
}

/** Cadastro com o perfil de cada parceiro no mês: notas dos últimos 6 meses, recorrência, conta, em aberto, apelidos. */
export async function partnerRegistry(tx: PoolClient, entityId: string, month: string) {
  const window = monthsBack(month, 6);
  const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const { rows } = await tx.query<{ id: string; doc: string; role: PartnerRole; name: string | null; first_seen: string; office_client: string | null; aliases: string[] }>(
    `SELECT p.id, p.doc, p.role, p.name, p.first_seen::text,
            (SELECT coalesce(e.trade_name, e.legal_name) FROM entity e WHERE e.cnpj = p.doc AND e.id <> p.entity_id LIMIT 1) AS office_client,
            coalesce((SELECT array_agg(a.pattern ORDER BY a.created_at) FROM partner_alias a WHERE a.partner_id = p.id AND a.valid_to IS NULL), '{}') AS aliases
       FROM partner p WHERE p.entity_id = $1`,
    [entityId],
  );
  const notes = await tx.query<{ doc: string; role: PartnerRole; m: string; n: number; total: string; codes: string[] }>(
    `SELECT CASE d.role WHEN 'TOMADA' THEN d.provider_doc ELSE d.taker_doc END AS doc,
            CASE d.role WHEN 'TOMADA' THEN 'FORNECEDOR' ELSE 'CLIENTE' END AS role,
            to_char(d.issued_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') AS m, count(*)::int AS n, sum(d.service_value)::text AS total,
            coalesce(array_agg(DISTINCT t.national_code) FILTER (WHERE t.national_code IS NOT NULL), '{}') AS codes
       FROM nfse_document d LEFT JOIN nfse_tax t ON t.nfse_id = d.id AND t.parser = $4
      WHERE d.entity_id = $1 AND d.role IN ('TOMADA', 'PRESTADA') AND d.service_value > 0
        AND (d.issued_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2 AND $3
      GROUP BY 1, 2, 3`,
    [entityId, `${window[0]}-01`, end, NFSE_TAX_PARSER],
  );
  const byKey = new Map<string, typeof notes.rows>();
  for (const r of notes.rows) {
    const k = `${r.role}:${r.doc}`;
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const rules = await tx.query<{ supplier_doc: string; account_code: string }>(
    `SELECT DISTINCT ON (supplier_doc) supplier_doc, account_code FROM supplier_rule
      WHERE (entity_id = $1 OR entity_id IS NULL) AND valid_from <= $2 AND (valid_to IS NULL OR valid_to >= $2)
      ORDER BY supplier_doc, (entity_id IS NULL), created_at DESC`,
    [entityId, end],
  );
  const ruleBy = new Map(rules.rows.map((r) => [r.supplier_doc, r.account_code]));
  const tableOk = Boolean((await tx.query("SELECT 1 FROM accounting_rule_approval WHERE rule_set = $1", [TAKEN_SERVICES_RULE])).rowCount);
  const cfg = await chartConfig(tx, entityId);
  const openSup = new Map((await openItems(tx, entityId, roleAccount(cfg, "FORNECEDORES"), end)).items.map((i) => [i.partnerDoc, i.balance]));
  const openCli = new Map((await openItems(tx, entityId, roleAccount(cfg, "CLIENTES"), end)).items.map((i) => [i.partnerDoc, i.balance]));

  const prev3 = window.slice(2, 5);
  const list: PartnerView[] = rows.map((p) => {
    const ns = byKey.get(`${p.role}:${p.doc}`) ?? [];
    const months = window.map((m) => {
      const x = ns.find((r) => r.m === m);
      return { month: m, notes: x?.n ?? 0, total: Dec.of(x?.total ?? "0").toFixed(2) };
    });
    const codes = [...new Set(ns.flatMap((r) => r.codes))].sort();
    const before = months.filter((m) => prev3.includes(m.month) && m.notes > 0);
    const recurring = before.length >= 2;
    const inMonth = months[months.length - 1]!.notes > 0;
    const status: PartnerMonthStatus = inMonth ? "NO_MES" : recurring ? "ESPERADA" : ns.length ? "EVENTUAL" : "SEM_NOTA";
    const expected = recurring ? before.reduce((s, m) => s.add(m.total), Dec.ZERO).div(String(before.length)).toFixed(2) : null;
    let account: PartnerView["account"] = null;
    if (p.role === "FORNECEDOR") {
      const r = ruleBy.get(p.doc);
      if (r) account = { code: r, source: "FORNECEDOR" };
      else if (tableOk && codes.length === 1 && serviceAccount(codes[0]!, cfg)) account = { code: serviceAccount(codes[0]!, cfg)!, source: "TABELA" };
    } else account = { code: roleAccount(cfg, "RECEITA_SERVICOS"), source: "TABELA" };
    const open = (p.role === "FORNECEDOR" ? openSup : openCli).get(p.doc) ?? "0.00";
    return { id: p.id, doc: p.doc, role: p.role, name: p.name, firstSeen: p.first_seen, officeClient: p.office_client, codes, months, recurring, status, expected, account, open, aliases: p.aliases };
  });
  const order: Record<PartnerMonthStatus, number> = { ESPERADA: 0, NO_MES: 1, EVENTUAL: 2, SEM_NOTA: 3 };
  list.sort((a, b) => order[a.status] - order[b.status] || Number(b.months.at(-1)!.total) - Number(a.months.at(-1)!.total) || (a.name ?? "").localeCompare(b.name ?? ""));
  return {
    month, window,
    suppliers: list.filter((p) => p.role === "FORNECEDOR"),
    customers: list.filter((p) => p.role === "CLIENTE"),
    expectedMissing: list.filter((p) => p.status === "ESPERADA").map((p) => ({ role: p.role, doc: p.doc, name: p.name, expected: p.expected })),
  };
}

/** Apelido informado por uma pessoa ("no banco aparece como …"). */
export async function addAlias(tx: PoolClient, entityId: string, partnerId: string, text: string, actor: Actor): Promise<string> {
  if (actor.kind !== "USER") throw new PartnerError("Só uma pessoa informa como o parceiro aparece no banco");
  const pattern = bankText(text).slice(0, 60).trim();
  if (pattern.length < 4) throw new PartnerError("Texto curto demais (mín. 4 letras, sem números e sem palavras do banco como PIX/TED)");
  const p = await tx.query("SELECT 1 FROM partner WHERE id = $1 AND entity_id = $2", [partnerId, entityId]);
  if (!p.rowCount) throw new PartnerError("Parceiro não encontrado");
  const id = newId();
  const r = await tx.query(
    `INSERT INTO partner_alias (id, tenant_id, entity_id, partner_id, pattern, source, valid_from, created_by)
     VALUES ($1, current_tenant(), $2, $3, $4, 'PESSOA', current_date, $5) ON CONFLICT DO NOTHING`,
    [id, entityId, partnerId, pattern, `${actor.kind}:${actor.id}`],
  );
  if (r.rowCount) {
    await audit(tx, { actor, action: "ledger.partner_alias_added", resourceType: "partner_alias", resourceId: id, entityId, data: { partner_id: partnerId, pattern } });
  }
  return pattern;
}
