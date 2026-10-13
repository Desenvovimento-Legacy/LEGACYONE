import type { Pool, PoolClient } from "pg";
import { normalizeBrasilApi } from "../../integrations/cnpj-public/brasilapi.js";
import { audit } from "../../platform/audit/audit.js";
import { appendEvent } from "../../platform/events/outbox.js";
import { resolvePendingItem } from "../../platform/pending/pending.js";
import type { Actor } from "../../shared/actor.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";

/**
 * Agente Implantação — regime tributário pela evidência oficial, sem pessoa:
 *
 *   1. DARF pagos (PagtoWeb): o código de receita do IRPJ/CSLL decide o ano
 *      (2089/2372 Presumido; 0220/3373/6012 Real trimestral; 2362/5993/2484
 *      e ajuste 2430/2456/6773 Real anual). PIS/COFINS cumulativo (8109/2172)
 *      ou não cumulativo (6912/5856) confirma o ano sem IRPJ pago ainda.
 *   2. Dados abertos da Receita (forma de tributação declarada na ECF, por ano).
 *
 * Anos seguidos com o mesmo regime viram uma vigência; ano sem evidência
 * interrompe. O ano corrente só fica em aberto com evidência do próprio ano.
 * Nunca sobrescreve regime já registrado (pessoa ou outra fonte).
 */

export const REGIME_DETECT_VERSION = "regime-1";
const AGENT: Actor = { kind: "AGENT", id: "onboarding" };

type Regime = "LUCRO_PRESUMIDO" | "LUCRO_REAL_TRIMESTRAL" | "LUCRO_REAL_ANUAL" | "LUCRO_ARBITRADO" | "IMUNE" | "ISENTA";
const IRPJ_CODES: Record<string, Regime> = {
  "2089": "LUCRO_PRESUMIDO", "2372": "LUCRO_PRESUMIDO",
  "0220": "LUCRO_REAL_TRIMESTRAL", "3373": "LUCRO_REAL_TRIMESTRAL", "6012": "LUCRO_REAL_TRIMESTRAL",
  "2362": "LUCRO_REAL_ANUAL", "5993": "LUCRO_REAL_ANUAL", "2484": "LUCRO_REAL_ANUAL", "2430": "LUCRO_REAL_ANUAL", "2456": "LUCRO_REAL_ANUAL", "6773": "LUCRO_REAL_ANUAL",
  "5625": "LUCRO_ARBITRADO",
};
const CUMULATIVE = new Set(["8109", "2172"]);
const NONCUMULATIVE = new Set(["6912", "5856"]);

export interface YearEvidence {
  year: number;
  /** regime decidido para o ano (null = sem evidência suficiente) */
  regime: Regime | null;
  why: string[];
}

function publicRegime(s: string): Regime | "LUCRO_REAL" | null {
  const u = s.toUpperCase();
  if (u.includes("PRESUMIDO")) return "LUCRO_PRESUMIDO";
  if (u.includes("ARBITRADO")) return "LUCRO_ARBITRADO";
  if (u.includes("REAL")) return "LUCRO_REAL";
  if (u.includes("IMUNE")) return "IMUNE";
  if (u.includes("ISENT")) return "ISENTA";
  return null;
}

/** Evidência por ano (pura sobre os dados lidos do banco). */
export function decideYears(input: {
  publicYears: { year: number; regime: string }[];
  paymentCodes: { year: number; code: string }[];
  currentYear: number;
}): YearEvidence[] {
  const years = new Set<number>([...input.publicYears.map((p) => p.year), ...input.paymentCodes.map((p) => p.year)]);
  // periodicidade do Real conhecida por qualquer ano com DARF (para dados abertos que só dizem "LUCRO REAL")
  const realKind = input.paymentCodes.map((p) => IRPJ_CODES[p.code]).find((r) => r === "LUCRO_REAL_TRIMESTRAL" || r === "LUCRO_REAL_ANUAL") ?? null;
  const out: YearEvidence[] = [];
  for (const year of [...years].sort()) {
    const codes = [...new Set(input.paymentCodes.filter((p) => p.year === year).map((p) => p.code))];
    const why: string[] = [];
    const byDarf = [...new Set(codes.map((c) => IRPJ_CODES[c]).filter((r): r is Regime => Boolean(r)))];
    const pub = input.publicYears.find((p) => p.year === year);
    const pubR = pub ? publicRegime(pub.regime) : null;
    let regime: Regime | null = null;
    if (byDarf.length === 1) {
      regime = byDarf[0]!;
      why.push(`DARF ${codes.filter((c) => IRPJ_CODES[c]).join("/")} pagos em ${year}`);
    } else if (byDarf.length > 1) {
      why.push(`DARF de regimes diferentes em ${year} (${codes.join(", ")}): a confirmar`);
    } else if (pubR) {
      regime = pubR === "LUCRO_REAL" ? realKind : pubR;
      why.push(`ECF ${year} nos dados abertos da Receita: ${pub!.regime.toLowerCase()}`);
      if (pubR === "LUCRO_REAL" && !realKind) why.push("Lucro Real sem DARF que mostre se é trimestral ou anual");
    } else if (codes.some((c) => CUMULATIVE.has(c)) || codes.some((c) => NONCUMULATIVE.has(c))) {
      // só PIS/COFINS no ano: confirma o regime do ano anterior quando compatível
      const prev = out.find((o) => o.year === year - 1)?.regime ?? null;
      const cum = codes.some((c) => CUMULATIVE.has(c));
      if (prev && (cum ? prev === "LUCRO_PRESUMIDO" || prev === "LUCRO_ARBITRADO" : prev.startsWith("LUCRO_REAL"))) {
        regime = prev;
        why.push(`PIS/COFINS ${cum ? "cumulativo" : "não cumulativo"} pago em ${year} (${codes.filter((c) => CUMULATIVE.has(c) || NONCUMULATIVE.has(c)).join("/")}), compatível com ${year - 1}`);
      }
    }
    // DARF e dados abertos em conflito: não decide
    if (regime && pubR && byDarf.length === 1 && !(pubR === regime || (pubR === "LUCRO_REAL" && regime.startsWith("LUCRO_REAL")))) {
      why.push(`ECF ${year} diz ${pub!.regime.toLowerCase()}: conflito com os DARF, a confirmar`);
      regime = null;
    }
    out.push({ year, regime, why });
  }
  void input.currentYear;
  return out;
}

/** Vigências a partir dos anos decididos: anos seguidos e iguais se juntam; o corrente fica em aberto. */
export function spansFrom(years: YearEvidence[], currentYear: number) {
  const spans: { regime: Regime; from: number; to: number; why: string[] }[] = [];
  for (const y of years) {
    const last = spans[spans.length - 1];
    if (!y.regime) continue;
    if (last && last.regime === y.regime && last.to === y.year - 1) {
      last.to = y.year;
      last.why.push(...y.why);
    } else spans.push({ regime: y.regime, from: y.year, to: y.year, why: [...y.why] });
  }
  return spans.map((s) => ({ ...s, validFrom: `${s.from}-01-01`, validTo: s.to >= currentYear ? null : `${s.to}-12-31` }));
}

async function evidence(tx: PoolClient, entityId: string) {
  const ent = (await tx.query<{ cnpj: string }>("SELECT cnpj FROM entity WHERE id = $1", [entityId])).rows[0];
  if (!ent?.cnpj) return null;
  const snap = await tx.query<{ payload: unknown }>(
    "SELECT payload FROM external_snapshot WHERE request_key = $1 AND source ILIKE '%brasilapi%' ORDER BY fetched_at DESC LIMIT 1",
    [`cnpj:${ent.cnpj}`],
  );
  let publicYears: { year: number; regime: string }[] = [];
  if (snap.rows[0]) {
    try { publicYears = normalizeBrasilApi(snap.rows[0].payload).taxRegimes ?? []; } catch { publicYears = []; }
  }
  const pays = await tx.query<{ year: number; code: string }>(
    `SELECT DISTINCT extract(year FROM coalesce(p.competence, p.collected_on))::int AS year, b->>'revenueCode' AS code
       FROM federal_payment p, jsonb_array_elements(CASE WHEN jsonb_array_length(p.breakdown) > 0 THEN p.breakdown
                                                          ELSE jsonb_build_array(jsonb_build_object('revenueCode', p.revenue_code)) END) b
      WHERE p.entity_id = $1 AND b->>'revenueCode' IS NOT NULL`,
    [entityId],
  );
  return { publicYears, paymentCodes: pays.rows.map((r) => ({ year: r.year, code: r.code.padStart(4, "0") })) };
}

/** O que a evidência diz (para a tela), sem gravar. */
export async function regimeEvidence(tx: PoolClient, entityId: string, today: string) {
  const ev = await evidence(tx, entityId);
  if (!ev) return { years: [], spans: [] };
  const years = decideYears({ ...ev, currentYear: Number(today.slice(0, 4)) });
  return { years, spans: spansFrom(years, Number(today.slice(0, 4))) };
}

/**
 * Registra o regime pela evidência quando a empresa ainda não tem regime nesses
 * anos. Resolve a pendência TAX_REGIME_UNKNOWN quando o ano corrente fica coberto.
 */
export async function detectTaxRegime(pool: Pool, tenantId: string, entityId: string, today: string, actor: Actor = AGENT) {
  return withTenant(pool, tenantId, async (tx) => {
    const { years, spans } = await regimeEvidence(tx, entityId, today);
    let added = 0;
    for (const s of spans) {
      // regime anterior que termina dentro do ano (ex.: exclusão do Simples em julho): começa no mês seguinte
      const prior = await tx.query<{ end: string }>(
        `SELECT max(valid_to)::text AS end FROM tax_regime_history
          WHERE entity_id = $1 AND valid_to IS NOT NULL AND valid_to >= $2 AND valid_from < $2::date + interval '1 year' AND valid_from <= $2::date`,
        [entityId, s.validFrom],
      );
      const end = prior.rows[0]?.end ?? null;
      if (end) {
        const d = new Date(`${end}T12:00:00Z`);
        d.setUTCDate(1);
        d.setUTCMonth(d.getUTCMonth() + 1);
        const start = d.toISOString().slice(0, 10);
        if (s.validTo && start > s.validTo) continue;
        s.why.unshift(`depois do regime anterior encerrado em ${end.split("-").reverse().join("/")}`);
        (s as { validFrom: string }).validFrom = start;
      }
      const clash = await tx.query(
        "SELECT 1 FROM tax_regime_history WHERE entity_id = $1 AND daterange(valid_from, valid_to, '[]') && daterange($2::date, $3::date, '[]')",
        [entityId, s.validFrom, s.validTo],
      );
      if (clash.rowCount) continue;
      const id = newId();
      const source = `receita:${REGIME_DETECT_VERSION}: ${[...new Set(s.why)].join("; ")}`.slice(0, 500);
      await tx.query(
        "INSERT INTO tax_regime_history (id, tenant_id, entity_id, regime, valid_from, valid_to, source) VALUES ($1, current_tenant(), $2, $3, $4, $5, $6)",
        [id, entityId, s.regime, s.validFrom, s.validTo, source],
      );
      await audit(tx, { actor, action: "tax_regime_history.detected", resourceType: "tax_regime_history", resourceId: id, entityId,
        data: { regime: s.regime, valid_from: s.validFrom, valid_to: s.validTo, evidence: s.why, version: REGIME_DETECT_VERSION } });
      await appendEvent(tx, {
        type: "TAX_REGIME_DEFINED", schemaVersion: 1, producer: { kind: "agent", name: "onboarding", version: REGIME_DETECT_VERSION },
        idempotencyKey: `regime:${entityId}:${s.regime}:${s.validFrom}`, entityId,
        payload: { entity_id: entityId, regime: s.regime, valid_from: s.validFrom, by: `agente:onboarding (${s.why[0] ?? "evidência"})` },
      });
      added++;
    }
    const cur = await tx.query("SELECT 1 FROM tax_regime_history WHERE entity_id = $1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to >= $2)", [entityId, today]);
    let resolved = 0;
    if (cur.rowCount) {
      const pend = await tx.query<{ id: string }>("SELECT id FROM pending_item WHERE entity_id = $1 AND type = 'TAX_REGIME_UNKNOWN' AND status = 'OPEN'", [entityId]);
      for (const p of pend.rows) {
        await resolvePendingItem(tx, { id: p.id, resolution: `Regime identificado pela evidência da Receita (${REGIME_DETECT_VERSION})` }, actor);
        resolved++;
      }
    }
    return { added, resolved, years: years.map((y) => ({ year: y.year, regime: y.regime })) };
  });
}
