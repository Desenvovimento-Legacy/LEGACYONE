import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { IntegraContador, PgdasDeclarationData } from "../../../integrations/integra-contador/types.js";
import { audit } from "../../../platform/audit/audit.js";
import { consumeGrant, requestAuthorization } from "../../../platform/authorization/authorization.js";
import { appendEvent } from "../../../platform/events/outbox.js";
import { storeExternalSnapshot } from "../../../platform/evidence/snapshot.js";
import { reserveBilledCalls, type MeteringPolicy } from "../../../platform/metering/metering.js";
import { openPendingItem } from "../../../platform/pending/pending.js";
import type { Actor } from "../../../shared/actor.js";
import { Dec, sumDec } from "../../../shared/decimal.js";
import { withTenant } from "../../../shared/db/tenant-tx.js";
import { newId } from "../../../shared/ids.js";
import { loadSimplesRules } from "./apuracao.js";
import { activityIdOf, isFactorR, isGoodsActivity, isServiceActivity, PGDAS_ACTIVITIES, serviceVariant, TAX_CODE } from "./pgdas-activities.js";
import type { Tax } from "./rules.js";

/**
 * PGDAS-D pronta para transmitir (agente Tributos). NADA É TRANSMITIDO.
 *
 * 1. Montagem (automática, a cada nota, cálculo ou declaração nova): para cada
 *    mês completo ainda não declarado, a IARIS monta o pedido do serviço de
 *    entrega da PGDAS-D (TRANSDECLARACAO11) com:
 *      receita do mês pelas NFS-e prestadas (sem canceladas), por estabelecimento;
 *      atividade de cada receita pela atividade já declarada pela empresa
 *      (o PDF da declaração traz a descrição oficial), na variante certa
 *      (ISS retido, ISS do próprio município ou de outro);
 *      todos os estabelecimentos vigentes; original ou retificadora.
 *    O que a IARIS ainda não sabe montar vira bloqueio com o motivo (nunca um
 *    valor inventado): vendas de mercadorias sem leitura dos itens, fator r sem
 *    folha, regime de caixa, ISS de outro município sem o código do município.
 * 2. Conferência com a Receita (botão, consulta cobrada): o mesmo pedido com
 *    indicadorTransmissao = false. A Receita calcula e devolve os valores devidos,
 *    sem transmitir. Iguais ao cálculo da IARIS → PRONTA. O pedido de
 *    transmissão (indicadorTransmissao = true + valores para comparação) fica
 *    guardado, mas a IARIS não tem como enviá-lo nesta fase.
 */

export const PGDAS_AGENT: Actor = { kind: "AGENT", id: "tax" };
const PRODUCER = { kind: "agent" as const, name: "tax", version: "pgdas-draft-1" };
const SERVICE_PGDAS = "PGDAS-D - a partir de 01/2018";
const TAX_BY_CODE: Record<number, Tax> = Object.fromEntries(Object.entries(TAX_CODE).map(([t, c]) => [c, t as Tax]));

const ym = (c: string) => c.slice(0, 7);
const my = (c: string) => `${c.slice(5, 7)}/${c.slice(0, 4)}`;
const brl = (v: string | number) => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const num = (v: string | Dec) => Number(typeof v === "string" ? v : v.toFixed(2));
function addMonths(comp: string, n: number): string {
  const d = new Date(`${comp.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return `${d.toISOString().slice(0, 7)}-01`;
}

export class PgdasDraftError extends Error {}

export interface DraftBuild {
  competence: string;
  status: "MONTADA" | "BLOQUEADA";
  declarationType: 1 | 2;
  revenue: string;
  payload: PgdasDeclarationData;
  blockers: string[];
  notes: string[];
  iarisTotal: string | null;
  iarisTaxes: Record<string, string> | null;
  calculationId: string | null;
  alerts: { type: string; text: string; impact: string }[];
}

interface DeclaredActivity { seq: number; activity: string; annex: string | null; id: number | null }

/** Atividades da declaração mais recente até a competência (ou a primeira depois, se não houver antes). */
async function declaredActivities(tx: PoolClient, entityId: string, competence: string): Promise<{ from: string; acts: DeclaredActivity[] } | null> {
  const { rows } = await tx.query<{ competence: string; seq: number; activity: string; annex: string | null }>(
    `WITH last AS (
       SELECT DISTINCT ON (competence) competence, pdf_id FROM pgdas_declared_tax
        WHERE entity_id = $1 ORDER BY competence, declaration_number DESC NULLS LAST, created_at DESC
     ), pick AS (
       SELECT coalesce((SELECT max(competence) FROM last WHERE competence <= $2), (SELECT min(competence) FROM last)) AS c
     )
     SELECT t.competence::text, t.seq, t.activity, t.annex
       FROM pgdas_declared_tax t JOIN last l ON l.pdf_id = t.pdf_id AND l.competence = t.competence
      WHERE t.entity_id = $1 AND t.competence = (SELECT c FROM pick)
        AND t.parser = (SELECT max(x.parser) FROM pgdas_declared_tax x WHERE x.pdf_id = t.pdf_id)
      ORDER BY t.seq`,
    [entityId, competence],
  );
  if (!rows.length) return null;
  return { from: rows[0]!.competence, acts: rows.map((r) => ({ seq: r.seq, activity: r.activity, annex: r.annex, id: activityIdOf(r.activity) })) };
}

/** Monta a declaração do mês (não grava). */
export async function buildPgdasDraft(tx: PoolClient, entityId: string, competence: string): Promise<DraftBuild> {
  const blockers: string[] = [];
  const notes: string[] = [];
  const alerts: DraftBuild["alerts"] = [];
  const ent = (await tx.query<{ cnpj: string }>("SELECT cnpj FROM entity WHERE id = $1", [entityId])).rows[0];
  if (!ent?.cnpj) throw new PgdasDraftError("Empresa sem CNPJ");
  const end = addMonths(competence, 1);
  const ests = (await tx.query<{ cnpj: string; kind: string; city: string | null; opened: string | null }>(
    `SELECT cnpj, kind, municipio_ibge AS city, opened_at::text AS opened FROM establishment
      WHERE entity_id = $1 AND cnpj IS NOT NULL AND (opened_at IS NULL OR opened_at < $3) AND (closed_at IS NULL OR closed_at >= $2)
      ORDER BY kind = 'MATRIZ' DESC, cnpj`,
    [entityId, competence, end],
  )).rows;
  if (!ests.length) blockers.push("Nenhum estabelecimento vigente cadastrado na competência");
  const matriz = ests[0];

  // tipo: já existe declaração transmitida do PA → retificadora
  const declared = await tx.query("SELECT 1 FROM pgdas_declaration WHERE entity_id = $1 AND competence = $2 LIMIT 1", [entityId, competence]);
  const declarationType: 1 | 2 = declared.rowCount ? 2 : 1;
  if (declarationType === 2) notes.push("Já existe declaração transmitida deste mês: esta seria retificadora");

  // regime de apuração da receita (o da última declaração lida)
  const regime = (await tx.query<{ regime: string | null }>(
    "SELECT regime FROM pgdas_declared_revenue WHERE entity_id = $1 AND regime IS NOT NULL ORDER BY declared_in DESC, created_at DESC LIMIT 1",
    [entityId],
  )).rows[0]?.regime;
  if (regime === "CAIXA") blockers.push("Regime de caixa: a receita recebida no mês (pelo extrato) ainda não é montada automaticamente");

  const decl = await declaredActivities(tx, entityId, competence);
  if (!decl) blockers.push("Sem declaração anterior lida: a IARIS não sabe as atividades da empresa (busque uma declaração do PGDAS-D)");
  const acts = decl?.acts ?? [];
  for (const a of acts) if (a.id === null) blockers.push(`Atividade da declaração não reconhecida: "${a.activity.slice(0, 120)}"`);
  if (decl && ym(decl.from) !== ym(competence)) notes.push(`Atividades tiradas da declaração de ${my(decl.from)}`);
  const ids = acts.map((a) => a.id).filter((x): x is number => x !== null);
  const services = [...new Set(ids.filter(isServiceActivity))];
  const goods = ids.filter(isGoodsActivity);
  if (ids.some(isFactorR)) blockers.push("Atividade sujeita ao fator r: falta a folha de salários dos 12 meses anteriores (folha ainda não integrada)");
  if (goods.length) {
    // itens das notas de saída do mês (agente Fiscal): mostra a separação, mas a montagem das vendas ainda não é automática
    const out = (await tx.query<{ n: number; total: string | null; st: string | null; mono: string | null }>(
      `SELECT count(DISTINCT access_key)::int AS n, sum(total - discount)::text AS total,
              sum(total - discount) FILTER (WHERE has_st)::text AS st, sum(total - discount) FILTER (WHERE monophasic AND NOT has_st)::text AS mono
         FROM nfe_item WHERE entity_id = $1 AND direction = 'SAIDA' AND competence = $2`,
      [entityId, competence],
    )).rows[0];
    blockers.push(out?.n
      ? `Vendas de mercadorias de ${my(competence)}: ${out.n} nota(s) de saída lidas (${brl(out.total ?? 0)}, sendo ${brl(out.st ?? 0)} com ST e ${brl(out.mono ?? 0)} monofásico); a montagem das vendas por atividade na declaração ainda não é automática`
      : `Vendas de mercadorias (NF-e/NFC-e) de ${my(competence)}: nenhuma nota de saída do mês na IARIS (envie os XML das NFC-e/NF-e emitidas pela entrada de XML)`);
  }
  const other = ids.filter((i) => !isServiceActivity(i) && !isGoodsActivity(i));
  if (other.length) blockers.push(`Atividade ainda não montada automaticamente: ${other.map((i) => `${i} (${PGDAS_ACTIVITIES[i]!.slice(0, 60)}…)`).join("; ")}`);
  if (services.length > 1) blockers.push("Mais de uma atividade de serviço declarada: a separação das notas por atividade (item da lista de serviços) ainda não é automática");

  // receita de serviços: NFS-e prestadas do mês, sem canceladas
  const notesRows = (await tx.query<{ provider: string | null; withheld: boolean | null; city: string | null; value: string; n: number }>(
    `WITH cancelled AS (
       SELECT DISTINCT access_key FROM nfse_document
        WHERE entity_id = $1 AND role = 'EVENTO' AND access_key IS NOT NULL
          AND (event_type ILIKE '%101101%' OR event_type ILIKE '%105102%' OR event_type ILIKE '%cancel%'))
     SELECT d.provider_doc AS provider, coalesce(t.iss_withheld > 0, d.iss_withheld, false) AS withheld,
            coalesce(t.incidence_city, '') AS city, sum(d.service_value)::text AS value, count(*)::int AS n
       FROM nfse_document d
       LEFT JOIN LATERAL (SELECT * FROM nfse_tax x WHERE x.nfse_id = d.id ORDER BY x.created_at DESC LIMIT 1) t ON true
      WHERE d.entity_id = $1 AND d.role = 'PRESTADA' AND d.service_value > 0
        AND d.issued_at >= ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AND d.issued_at < ($3::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
        AND (d.access_key IS NULL OR d.access_key NOT IN (SELECT access_key FROM cancelled))
      GROUP BY 1, 2, 3`,
    [entityId, competence, end],
  )).rows;
  const serviceTotal = sumDec(notesRows.map((r) => Dec.of(r.value)));
  if (notesRows.length && !services.length && decl) blockers.push("Há NFS-e prestadas no mês, mas nenhuma atividade de serviço na declaração anterior");

  // estabelecimento → atividade → valor
  const byEst = new Map<string, Map<number, Dec>>();
  const otherCities = new Set<string>();
  if (services.length === 1) {
    for (const r of notesRows) {
      const est = ests.find((e) => e.cnpj === r.provider) ?? matriz;
      if (!est) continue;
      const otherCity = Boolean(r.city && est.city && r.city !== est.city);
      if (otherCity) otherCities.add(r.city!);
      const id = serviceVariant(services[0]!, { withheld: Boolean(r.withheld), otherCity });
      const m = byEst.get(est.cnpj) ?? new Map<number, Dec>();
      m.set(id, (m.get(id) ?? Dec.ZERO).add(r.value));
      byEst.set(est.cnpj, m);
    }
  }
  if (otherCities.size) blockers.push(`ISS devido a outro município (IBGE ${[...otherCities].join(", ")}): falta o código do município na tabela da Receita para a declaração`);
  if (!notesRows.length && !goods.length) notes.push("Sem NFS-e prestada no mês: declaração sem receita (confirme que não houve faturamento)");

  const revenue = serviceTotal.toFixed(2);
  const estabelecimentos = ests.map((e) => {
    const m = byEst.get(e.cnpj);
    if (!m) return { cnpjCompleto: e.cnpj };
    return {
      cnpjCompleto: e.cnpj,
      atividades: [...m.entries()].sort(([a], [b]) => a - b).map(([id, v]) => ({
        idAtividade: id,
        valorAtividade: num(v),
        receitasAtividade: [{ valor: num(v), codigoOutroMunicipio: null, outraUf: null, isencoes: null, reducoes: null, qualificacoesTributarias: null, exigibilidadesSuspensas: null }],
      })),
    };
  });
  const payload: PgdasDeclarationData = {
    cnpjCompleto: ent.cnpj,
    pa: Number(ym(competence).replace("-", "")),
    declaracao: {
      tipoDeclaracao: declarationType,
      receitaPaCompetenciaInterno: num(revenue),
      receitaPaCompetenciaExterno: 0,
      receitaPaCaixaInterno: null,
      receitaPaCaixaExterno: null,
      valorFixoIcms: null,
      valorFixoIss: null,
      receitasBrutasAnteriores: null,
      folhasSalario: null,
      naoOptante: null,
      estabelecimentos,
    },
  };

  // cálculo da própria IARIS (motor do Simples) para conferir com o da Receita
  const calc = (await tx.query<{ id: string; status: string; total: string | null; result: { taxes?: Record<Tax, string>; reason?: string } | null; inputs: { rpa?: string } }>(
    "SELECT id, status, total::text, result, inputs FROM simples_calculation WHERE entity_id = $1 AND competence = $2 ORDER BY created_at DESC, id DESC LIMIT 1",
    [entityId, competence],
  )).rows[0];
  let iarisTotal: string | null = null;
  let iarisTaxes: Record<string, string> | null = null;
  if (calc?.status === "CALCULADO" && calc.result?.taxes) {
    if (calc.inputs.rpa && !Dec.of(calc.inputs.rpa).sub(revenue).isZero()) notes.push(`O cálculo do Simples usou receita de ${brl(calc.inputs.rpa)} e a declaração tem ${brl(revenue)}: recalcular`);
    iarisTotal = calc.total;
    iarisTaxes = Object.fromEntries(Object.entries(calc.result.taxes).filter(([, v]) => !Dec.of(v).isZero()).map(([t, v]) => [String(TAX_CODE[t as Tax]), v]));
  } else if (calc) {
    notes.push(`Cálculo da IARIS indisponível (${calc.result?.reason ?? calc.status}): os valores virão só da Receita na conferência`);
  } else {
    notes.push("Cálculo da IARIS ainda não feito para este mês: os valores virão só da Receita na conferência");
  }

  // receita do ano × sublimite e limite (alerta ao escritório; regra aprovada)
  const rules = await loadSimplesRules(tx, competence);
  if (rules.params) {
    const year = competence.slice(0, 4);
    const prev = (await tx.query<{ total: string | null }>(
      `SELECT sum(total)::text AS total FROM (
         SELECT DISTINCT ON (competence) competence, total FROM pgdas_declared_revenue
          WHERE entity_id = $1 AND competence >= $2 AND competence < $3 ORDER BY competence, declared_in DESC, created_at DESC) x`,
      [entityId, `${year}-01-01`, competence],
    )).rows[0]?.total ?? "0";
    const rba = Dec.of(prev).add(revenue);
    const opened = matriz?.opened && matriz.opened.slice(0, 4) === year ? Number(matriz.opened.slice(5, 7)) : 1;
    const months = 13 - opened;
    const prop = (v: string) => Dec.of(v).mul(BigInt(months)).div(12n);
    const tol = Dec.pct(rules.params.def.excessTolerance).add("1");
    const sub = prop(rules.params.def.sublimit);
    const lim = prop(rules.params.def.limit);
    const nextMonth = my(addMonths(competence, 1));
    if (rba.gt(lim.mul(tol))) {
      alerts.push({ type: `SIMPLES_LIMIT_EXCESS_${year}`, text: `Receita de ${year} até ${my(competence)} (${brl(rba.toFixed(2))}) passou o limite do Simples (${brl(lim.toFixed(2))}) em mais de 20%: exclusão com efeitos a partir de ${nextMonth} e comunicação obrigatória à Receita (LC 123/2006, art. 3º, §§ 9º e 9º-A, e art. 30)`, impact: "A partir do mês seguinte a empresa sai do Simples (Lucro Presumido ou Real); sem a comunicação, multa do art. 36 da LC 123" });
    } else if (rba.gt(lim)) {
      alerts.push({ type: `SIMPLES_LIMIT_EXCESS_${year}`, text: `Receita de ${year} até ${my(competence)} (${brl(rba.toFixed(2))}) passou o limite do Simples (${brl(lim.toFixed(2))}): exclusão a partir de 01/${Number(year) + 1}, salvo se passar 20% antes (LC 123/2006, art. 3º, § 9º-A)`, impact: "Planejar o regime de " + (Number(year) + 1) });
    }
    if (rba.gt(sub.mul(tol))) {
      alerts.push({ type: `SIMPLES_SUBLIMIT_EXCESS_${year}`, text: `Receita de ${year} até ${my(competence)} (${brl(rba.toFixed(2))}) passou o sublimite (${brl(sub.toFixed(2))}) em mais de 20%: a partir de ${nextMonth} ICMS e ISS saem do DAS e são pagos direto ao estado/município (Res. CGSN 140/2018, art. 12, § 1º)`, impact: "Guia municipal/estadual própria a partir do mês seguinte; o DAS deixa de trazer ISS/ICMS" });
    } else if (rba.gt(sub)) {
      alerts.push({ type: `SIMPLES_SUBLIMIT_EXCESS_${year}`, text: `Receita de ${year} até ${my(competence)} (${brl(rba.toFixed(2))}) passou o sublimite (${brl(sub.toFixed(2))}): ICMS e ISS fora do DAS a partir de 01/${Number(year) + 1}, salvo se passar 20% antes`, impact: "ISS/ICMS pagos fora do DAS no ano seguinte" });
    }
    for (const a of alerts) notes.push(a.text);
  }

  return {
    competence, status: blockers.length ? "BLOQUEADA" : "MONTADA", declarationType, revenue, payload, blockers, notes,
    iarisTotal, iarisTaxes, calculationId: calc?.id ?? null, alerts,
  };
}

/** Meses completos ainda não declarados (depois da última declaração), até 3. */
async function pendingCompetences(tx: PoolClient, entityId: string, today: string): Promise<string[]> {
  const last = (await tx.query<{ c: string | null }>(
    `SELECT greatest((SELECT max(competence) FROM pgdas_declaration WHERE entity_id = $1),
                     (SELECT max(declared_in) FROM pgdas_declared_revenue WHERE entity_id = $1))::text AS c`,
    [entityId],
  )).rows[0]?.c;
  if (!last) return [];
  const current = `${today.slice(0, 7)}-01`;
  const out: string[] = [];
  for (let c = addMonths(last, 1); c < current && out.length < 3; c = addMonths(c, 1)) out.push(c);
  return out;
}

const fingerprintOf = (b: DraftBuild) =>
  createHash("sha256").update(JSON.stringify([b.status, b.declarationType, b.payload, b.blockers, b.notes, b.iarisTotal, b.iarisTaxes])).digest("hex");

/** Monta (ou mantém) as declarações dos meses em aberto. Idempotente: só cria versão quando muda. */
export async function preparePgdasDrafts(pool: Pool, tenantId: string, entityId: string, today: string, actor: Actor = PGDAS_AGENT) {
  return withTenant(pool, tenantId, async (tx) => {
    const isSimples = await tx.query(
      "SELECT 1 FROM pgdas_declared_revenue WHERE entity_id = $1 LIMIT 1",
      [entityId],
    );
    if (!isSimples.rowCount) return { prepared: 0, competences: [] as string[] };
    const comps = await pendingCompetences(tx, entityId, today);
    let prepared = 0;
    for (const c of comps) {
      const b = await buildPgdasDraft(tx, entityId, c);
      for (const a of b.alerts) {
        await openPendingItem(tx, { type: a.type, entityId, responsibleSource: "OFFICE", requiredInformation: a.text, impact: a.impact }, actor);
      }
      const fp = fingerprintOf(b);
      const last = (await tx.query<{ version: number; fingerprint: string }>(
        "SELECT version, fingerprint FROM pgdas_draft WHERE entity_id = $1 AND competence = $2 ORDER BY version DESC LIMIT 1",
        [entityId, c],
      )).rows[0];
      if (last?.fingerprint === fp) continue;
      const id = newId();
      const version = (last?.version ?? 0) + 1;
      await tx.query(
        `INSERT INTO pgdas_draft (id, tenant_id, entity_id, competence, version, status, declaration_type, revenue, payload, blockers, notes,
                                  iaris_total, iaris_taxes, simples_calculation_id, fingerprint, created_by)
         VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [id, entityId, c, version, b.status, b.declarationType, b.revenue, JSON.stringify(b.payload), JSON.stringify(b.blockers), JSON.stringify(b.notes),
          b.iarisTotal, b.iarisTaxes ? JSON.stringify(b.iarisTaxes) : null, b.calculationId, fp, `${actor.kind}:${actor.id}`],
      );
      await appendEvent(tx, {
        type: "PGDAS_DRAFT_PREPARED", schemaVersion: 1, producer: PRODUCER, idempotencyKey: `pgdas-rascunho:${entityId}:${ym(c)}:v${version}`,
        entityId, competence: c,
        payload: { entity_id: entityId, draft_id: id, competence: c, version, status: b.status, revenue: b.revenue, blockers: b.blockers.length },
      });
      await audit(tx, { actor, action: "tax.pgdas_draft_prepared", resourceType: "pgdas_draft", resourceId: id, entityId, competence: c, data: { version, status: b.status, revenue: b.revenue, blockers: b.blockers } });
      prepared++;
    }
    return { prepared, competences: comps };
  });
}

export interface PgdasCheckDeps {
  appPool: Pool;
  integra: IntegraContador;
  metering: MeteringPolicy;
  now?: () => Date;
}

/**
 * Conferência com a Receita, por pedido de uma pessoa (consulta cobrada): o
 * Integra Contador calcula a declaração SEM transmitir. Nada é transmitido.
 */
export async function checkPgdasDraft(deps: PgdasCheckDeps, tenantId: string, draftId: string, actor: Actor) {
  if (actor.kind !== "USER") throw new PgdasDraftError("Conferir com a Receita (consulta cobrada) é pedido de uma pessoa");
  const now = (deps.now ?? (() => new Date()))();
  const d = await withTenant(deps.appPool, tenantId, async (tx) => {
    const r = (await tx.query<{ id: string; entity_id: string; competence: string; version: number; status: string; payload: PgdasDeclarationData; iaris_total: string | null; iaris_taxes: Record<string, string> | null; cnpj: string }>(
      `SELECT d.id, d.entity_id, d.competence::text, d.version, d.status, d.payload, d.iaris_total::text, d.iaris_taxes, e.cnpj
         FROM pgdas_draft d JOIN entity e ON e.id = d.entity_id WHERE d.id = $1`,
      [draftId],
    )).rows[0];
    if (!r) throw new PgdasDraftError("Declaração não encontrada");
    const latest = await tx.query<{ id: string }>("SELECT id FROM pgdas_draft WHERE entity_id = $1 AND competence = $2 ORDER BY version DESC LIMIT 1", [r.entity_id, r.competence]);
    if (latest.rows[0]?.id !== r.id) throw new PgdasDraftError("A declaração mudou desde que a tela abriu: atualize e confira a versão nova");
    if (r.status !== "MONTADA") throw new PgdasDraftError("Declaração bloqueada: resolva os bloqueios antes de conferir com a Receita");
    const auth = await requestAuthorization(tx, { action: "integra.simulate", entityId: r.entity_id, service: SERVICE_PGDAS, scope: { period: r.payload.pa } }, actor);
    // a negação fica auditada: a transação não é desfeita
    if (auth.decision === "DENY") return { ...r, denied: auth.reason };
    await consumeGrant(tx, auth.grantId, "integra.simulate");
    return { ...r, denied: null as string | null };
  });
  if (d.denied) throw new PgdasDraftError(d.denied);
  await reserveBilledCalls(deps.appPool, tenantId, deps.metering, [{ entityId: d.entity_id, system: "PGDASD", service: "TRANSDECLARACAO11", requestRef: { period: d.payload.pa, transmissao: false } }], actor, now);

  let values: { code: number; value: string }[] | null = null;
  let messages: { code: string; text: string }[] = [];
  let raw: unknown = null;
  let error: string | null = null;
  try {
    const r = await deps.integra.simulatePgdas(d.cnpj, d.payload);
    values = r.value.values;
    messages = r.value.messages;
    raw = r.raw;
  } catch (e) {
    error = (e as Error).message;
    const m = (e as { messages?: { codigo: string; texto: string }[] }).messages ?? [];
    messages = m.map((x) => ({ code: x.codigo, text: x.texto }));
  }

  return withTenant(deps.appPool, tenantId, async (tx) => {
    const snap = raw ? await storeExternalSnapshot(tx, { source: deps.integra.name, requestKey: `pgdasd:calculo-sem-transmissao:${d.cnpj}:pa:${d.payload.pa}`, payload: raw, fetchedAt: now, entityId: d.entity_id }) : null;
    let status: "CONFERE" | "DIVERGE" | "SO_RECEITA" | "ERRO";
    let total: string | null = null;
    let difference: string | null = null;
    let ready: Record<string, unknown> | null = null;
    if (error || !values) {
      status = "ERRO";
      if (!messages.length && error) messages = [{ code: "ERRO", text: error }];
    } else {
      total = sumDec(values.map((v) => Dec.of(v.value))).toFixed(2);
      const mine = d.iaris_taxes ?? null;
      if (!mine) status = "SO_RECEITA";
      else {
        const codes = new Set([...values.filter((v) => !Dec.of(v.value).isZero()).map((v) => String(v.code)), ...Object.keys(mine)]);
        const same = [...codes].every((c) => Dec.of(values!.find((v) => String(v.code) === c)?.value ?? "0").sub(mine[c] ?? "0").isZero());
        difference = Dec.of(total).sub(d.iaris_total ?? "0").toFixed(2);
        status = same ? "CONFERE" : "DIVERGE";
      }
      if (status !== "DIVERGE") {
        // pedido pronto para a transmissão (a IARIS não envia: fica guardado)
        ready = {
          ...d.payload,
          indicadorTransmissao: true,
          indicadorComparacao: true,
          valoresParaComparacao: values.filter((v) => !Dec.of(v.value).isZero()).map((v) => ({ codigoTributo: v.code, valor: Number(v.value) })),
        };
      }
    }
    const id = newId();
    await tx.query(
      `INSERT INTO pgdas_draft_check (id, tenant_id, entity_id, draft_id, status, values, total, difference, messages, ready_payload, snapshot_id, checked_by)
       VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, d.entity_id, d.id, status, values ? JSON.stringify(values) : null, total, difference, JSON.stringify(messages), ready ? JSON.stringify(ready) : null, snap?.id ?? null, actor.id],
    );
    await appendEvent(tx, {
      type: "PGDAS_DRAFT_CHECKED", schemaVersion: 1, producer: { kind: "user", name: actor.id, version: "1" }, idempotencyKey: `pgdas-conferencia:${id}`,
      entityId: d.entity_id, competence: d.competence,
      payload: { entity_id: d.entity_id, draft_id: d.id, competence: d.competence, status, total, difference },
    });
    await audit(tx, { actor, action: "tax.pgdas_draft_checked", resourceType: "pgdas_draft_check", resourceId: id, entityId: d.entity_id, competence: d.competence, data: { status, total, difference, version: d.version, transmitted: false } });
    return { checkId: id, status, total, difference, values, messages };
  });
}

/** Declarações em preparo da empresa, com a última conferência de cada uma (para a tela). */
export async function pgdasDraftView(tx: PoolClient, entityId: string) {
  const { rows } = await tx.query<{
    id: string; competence: string; version: number; status: string; declaration_type: number; revenue: string; payload: PgdasDeclarationData;
    blockers: string[]; notes: string[]; iaris_total: string | null; iaris_taxes: Record<string, string> | null; created_at: Date;
  }>(
    `SELECT DISTINCT ON (competence) id, competence::text, version, status, declaration_type, revenue::text, payload, blockers, notes,
            iaris_total::text, iaris_taxes, created_at
       FROM pgdas_draft WHERE entity_id = $1 ORDER BY competence DESC, version DESC`,
    [entityId],
  );
  const out = [];
  for (const r of rows) {
    const c = (await tx.query<{ status: string; values: { code: number; value: string }[] | null; total: string | null; difference: string | null; messages: { code: string; text: string }[]; ready_payload: unknown; checked_by: string; checked_at: Date }>(
      "SELECT status, values, total::text, difference::text, messages, ready_payload, checked_by, checked_at FROM pgdas_draft_check WHERE draft_id = $1 ORDER BY checked_at DESC LIMIT 1",
      [r.id],
    )).rows[0] ?? null;
    const readiness = r.status === "BLOQUEADA" ? "BLOQUEADA" : !c ? "FALTA_CONFERIR" : c.status === "CONFERE" ? "PRONTA" : c.status === "SO_RECEITA" ? "PRONTA_SO_RECEITA" : c.status;
    out.push({
      ...r,
      taxes: Object.fromEntries(Object.entries(r.iaris_taxes ?? {}).map(([code, v]) => [TAX_BY_CODE[Number(code)] ?? code, v])),
      check: c ? { ...c, values: (c.values ?? []).map((v) => ({ tax: TAX_BY_CODE[v.code] ?? String(v.code), value: v.value })) } : null,
      readiness,
    });
  }
  return out;
}
