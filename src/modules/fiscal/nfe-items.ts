import type { Pool, PoolClient } from "pg";
import { NFE_ITEMS_PARSER, readNfeItems } from "../../integrations/sefaz/nfe-items.js";
import { audit } from "../../platform/audit/audit.js";
import { appendEvent } from "../../platform/events/outbox.js";
import type { Actor } from "../../shared/actor.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";
import { activityIdOf, isGoodsActivity, isServiceActivity } from "../tax/simples/pgdas-activities.js";
import { CFOP_RULES_VERSION, CREDIT_RULES_VERSION, credits, entryCfop, hasSt, isMonophasic, itemChecks, type Destination } from "./cfop-rules.js";

/**
 * Agente Fiscal — itens das NF-e/NFC-e: lê CFOP, CST/CSOSN, ST e monofásico de
 * cada item, confere as regras de CFOP/CST, propõe o CFOP de entrada e decide o
 * crédito de cada tributo pelo regime da empresa na data. Só lê o banco.
 */

const RULES = `${CFOP_RULES_VERSION}+${CREDIT_RULES_VERSION}`;
const FISCAL: Actor = { kind: "AGENT", id: "fiscal" };

/** Destinação das compras pela atividade declarada no PGDAS-D (revenda, industrialização ou só serviços). */
export async function purchaseDestination(tx: PoolClient, entityId: string): Promise<Destination | null> {
  const r = await tx.query<{ activity: string }>(
    `SELECT DISTINCT t.activity FROM pgdas_declared_tax t
      WHERE t.entity_id = $1 AND t.competence = (SELECT max(competence) FROM pgdas_declared_tax WHERE entity_id = $1)`,
    [entityId],
  );
  const ids = r.rows.map((x) => activityIdOf(x.activity)).filter((x): x is number => x !== null);
  if (!ids.length) return null;
  if (ids.some((i) => i === 4 || i === 5 || i === 6)) return "INDUSTRIALIZACAO";
  if (ids.some((i) => i >= 1 && i <= 3)) return "REVENDA";
  if (ids.every((i) => isServiceActivity(i) || !isGoodsActivity(i))) return "USO_CONSUMO";
  return null;
}

async function regimeAt(tx: PoolClient, entityId: string, day: string | null): Promise<string | null> {
  if (!day) return null;
  const r = await tx.query<{ regime: string }>(
    "SELECT regime FROM tax_regime_history WHERE entity_id = $1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to >= $2) ORDER BY valid_from DESC LIMIT 1",
    [entityId, day],
  );
  return r.rows[0]?.regime ?? null;
}

const brDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }) : null);

/** Lê os itens das NF-e/NFC-e ainda não lidas pela versão atual (leitor + regras). */
export async function readEntityNfeItems(pool: Pool, tenantId: string, entityId: string, actor: Actor = FISCAL) {
  return withTenant(pool, tenantId, async (tx) => {
    const ent = (await tx.query<{ cnpj: string }>("SELECT cnpj FROM entity WHERE id = $1", [entityId])).rows[0];
    if (!ent?.cnpj) return { documents: 0, items: 0, checks: 0 };
    const me = ent.cnpj.slice(0, 8);
    const dest = await purchaseDestination(tx, entityId);
    const docs = await tx.query<{ id: string; source: "SEFAZ" | "XML"; xml: string }>(
      `SELECT d.id, 'SEFAZ' AS source, d.xml FROM dfe_document d
        WHERE d.entity_id = $1 AND d.kind = 'NFE' AND d.access_key IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM nfe_item i WHERE i.entity_id = d.entity_id AND i.access_key = d.access_key AND i.parser = $2 AND i.rules = $3)
       UNION ALL
       SELECT x.id, 'XML', x.xml FROM fiscal_xml x
        WHERE x.entity_id = $1 AND x.doc_type IN ('NFE', 'NFCE') AND x.access_key IS NOT NULL AND coalesce(x.status, 'AUTORIZADO') = 'AUTORIZADO'
          AND NOT EXISTS (SELECT 1 FROM nfe_item i WHERE i.entity_id = x.entity_id AND i.access_key = x.access_key AND i.parser = $2 AND i.rules = $3)
       LIMIT 500`,
      [entityId, NFE_ITEMS_PARSER, RULES],
    );
    let documents = 0;
    let items = 0;
    let checks = 0;
    const seen = new Set<string>();
    for (const d of docs.rows) {
      const r = readNfeItems(d.xml);
      if (!r?.header.accessKey || seen.has(r.header.accessKey)) continue;
      seen.add(r.header.accessKey);
      const h = r.header;
      const issuerIsMe = h.issuerDoc?.slice(0, 8) === me;
      const direction = issuerIsMe ? (h.nfType === "0" ? "ENTRADA" : "SAIDA") : h.nfType === "0" ? "SAIDA" : "ENTRADA";
      const day = brDay(h.issuedAt);
      const regime = await regimeAt(tx, entityId, day);
      const purchase = direction === "ENTRADA" && !issuerIsMe;
      for (const it of r.items) {
        const ck = itemChecks(h, it);
        checks += ck.length;
        const ec = purchase ? entryCfop(it.cfop, dest) : { cfop: null, why: issuerIsMe ? "nota emitida pela empresa" : "saída" };
        const id = newId();
        const ins = await tx.query(
          `INSERT INTO nfe_item (id, tenant_id, entity_id, source, source_id, access_key, model, direction, issued_at, competence, issuer_doc, issuer_name, issuer_crt,
                                 counterpart_doc, n_item, product_code, description, ncm, cest, cfop, quantity, total, discount, freight, other, origin,
                                 icms_cst, icms_csosn, icms_base, icms_rate, icms_value, st_base, st_value, st_retained, sn_credit_rate, sn_credit_value,
                                 ipi_cst, ipi_value, pis_cst, pis_value, cofins_cst, cofins_value, has_st, monophasic, entry_cfop, entry_cfop_why, checks, parser, rules)
           VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25,
                   $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47, $48)
           ON CONFLICT DO NOTHING`,
          [id, entityId, d.source, d.id, h.accessKey, h.model, direction, h.issuedAt, day ? `${day.slice(0, 7)}-01` : null, h.issuerDoc, h.issuerName, h.issuerCrt,
            issuerIsMe ? h.recipientDoc : h.issuerDoc, it.n, it.productCode, it.description, it.ncm, it.cest, it.cfop, it.quantity, it.total, it.discount,
            it.freight, it.other, it.origin, it.icmsCst, it.icmsCsosn, it.icmsBase, it.icmsRate, it.icmsValue, it.stBase, it.stValue, it.stRetained,
            it.snCreditRate, it.snCreditValue, it.ipiCst, it.ipiValue, it.pisCst, it.pisValue, it.cofinsCst, it.cofinsValue, hasSt(it), isMonophasic(it),
            ec.cfop, ec.why, JSON.stringify(ck), NFE_ITEMS_PARSER, RULES],
        );
        if (!ins.rowCount) continue;
        items++;
        if (purchase) {
          for (const c of credits(regime, it, ec.cfop)) {
            await tx.query(
              `INSERT INTO nfe_item_credit (id, tenant_id, entity_id, item_id, tax, regime, status, base, rate, value, reason, rules)
               VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING`,
              [newId(), entityId, id, c.tax, regime, c.status, c.base, c.rate, c.value, c.reason, CREDIT_RULES_VERSION],
            );
          }
        }
      }
      documents++;
    }
    if (items) {
      const batch = newId();
      await appendEvent(tx, {
        type: "NFE_ITEMS_READ", schemaVersion: 1, producer: { kind: "agent", name: "fiscal", version: RULES },
        idempotencyKey: `nfe-itens:${entityId}:${batch}`, entityId,
        payload: { entity_id: entityId, documents, items, checks, rules: RULES, destination: dest },
      });
      await audit(tx, { actor, action: "fiscal.nfe_items_read", resourceType: "nfe_item", resourceId: batch, entityId, data: { documents, items, checks, rules: RULES, destination: dest } });
    }
    return { documents, items, checks };
  });
}

/** Resumo por mês e sentido, créditos e itens com conferência a olhar (para a tela). */
export async function nfeItemsOverview(tx: PoolClient, entityId: string) {
  const CUR = `parser = '${NFE_ITEMS_PARSER}' AND rules = '${RULES}'`;
  const months = await tx.query(
    `SELECT competence::text, direction, count(DISTINCT access_key)::int AS notes, count(*)::int AS items,
            sum(total - discount)::text AS value, coalesce(sum(total - discount) FILTER (WHERE has_st), 0)::text AS st,
            coalesce(sum(total - discount) FILTER (WHERE monophasic), 0)::text AS monophasic,
            count(*) FILTER (WHERE jsonb_array_length(checks) > 0)::int AS flagged,
            array_agg(DISTINCT cfop ORDER BY cfop) AS cfops
       FROM nfe_item WHERE entity_id = $1 AND ${CUR} GROUP BY 1, 2 ORDER BY 1 DESC, 2`,
    [entityId],
  );
  const cred = await tx.query(
    `SELECT i.competence::text, c.tax, c.status, sum(c.value)::text AS value, count(*)::int AS items, min(c.reason) AS reason
       FROM nfe_item_credit c JOIN nfe_item i ON i.id = c.item_id
      WHERE c.entity_id = $1 AND i.parser = '${NFE_ITEMS_PARSER}' AND i.rules = '${RULES}' GROUP BY 1, 2, 3 ORDER BY 1 DESC, 2, 3`,
    [entityId],
  );
  const flagged = await tx.query(
    `SELECT issued_at, issuer_name, access_key, n_item, description, cfop, icms_cst, icms_csosn, total::text, checks
       FROM nfe_item WHERE entity_id = $1 AND ${CUR} AND jsonb_array_length(checks) > 0 ORDER BY issued_at DESC LIMIT 50`,
    [entityId],
  );
  const entries = await tx.query(
    `SELECT cfop, entry_cfop, entry_cfop_why, count(*)::int AS items, sum(total - discount)::text AS value
       FROM nfe_item WHERE entity_id = $1 AND ${CUR} AND direction = 'ENTRADA' GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 30`,
    [entityId],
  );
  return {
    months: months.rows,
    credits: cred.rows,
    flagged: flagged.rows,
    entries: entries.rows,
    destination: await purchaseDestination(tx, entityId),
  };
}
