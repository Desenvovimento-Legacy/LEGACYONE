import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { unzipSync } from "fflate";
import type { Pool } from "pg";
import { parseFiscalXml, roleOf, type FiscalDoc } from "../../integrations/fiscal-xml/parse.js";
import { audit } from "../../platform/audit/audit.js";
import { appendEvent } from "../../platform/events/outbox.js";
import type { Actor } from "../../shared/actor.js";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";

/**
 * Agente Documentos — entrada de XML fiscal por upload na tela ou por pasta
 * (ex.: o PDV do cliente exporta as NFC-e numa pasta). Aceita XML soltos e ZIP.
 *
 * Para cada arquivo: identifica o tipo (NF-e, NFC-e, CT-e, NFS-e, evento),
 * acha a empresa pelo CNPJ (raiz) entre as partes do documento, guarda o XML
 * original com SHA-256 e não duplica (mesmo hash ou mesma chave). O que não é
 * de nenhuma empresa do escritório ou não é XML fiscal é recusado e listado.
 */

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_FILES = 3000;

export interface IncomingFile {
  name: string;
  bytes: Buffer;
}

export type IntakeStatus = "IMPORTADO" | "DUPLICADO" | "SEM_EMPRESA" | "INVALIDO" | "IGNORADO";

export interface IntakeItem {
  file: string;
  status: IntakeStatus;
  docType?: string;
  entity?: string;
  role?: string;
  accessKey?: string | null;
  reason?: string;
}

export interface IntakeReport {
  items: IntakeItem[];
  imported: number;
  duplicated: number;
  rejected: number;
  byEntity: Record<string, Record<string, number>>;
}

function decodeXml(buf: Buffer): string {
  let text = buf.toString("utf8");
  if (text.includes("�") && /encoding=["']ISO-8859-1["']/i.test(buf.subarray(0, 200).toString("latin1"))) text = buf.toString("latin1");
  return text.replace(/^﻿/, "").trim();
}

/** Abre ZIPs (um nível) e devolve só os .xml. */
export function expandFiles(files: IncomingFile[]): { xmls: IncomingFile[]; ignored: IntakeItem[] } {
  const xmls: IncomingFile[] = [];
  const ignored: IntakeItem[] = [];
  for (const f of files) {
    const ext = extname(f.name).toLowerCase();
    if (ext === ".zip") {
      try {
        const entries = unzipSync(new Uint8Array(f.bytes), { filter: (e) => /\.xml$/i.test(e.name) && e.originalSize <= MAX_FILE_BYTES });
        for (const [name, data] of Object.entries(entries)) xmls.push({ name: `${f.name}/${name}`, bytes: Buffer.from(data) });
      } catch {
        ignored.push({ file: f.name, status: "INVALIDO", reason: "ZIP corrompido ou protegido" });
      }
    } else if (ext === ".xml") {
      if (f.bytes.length > MAX_FILE_BYTES) ignored.push({ file: f.name, status: "INVALIDO", reason: "Arquivo acima de 5 MB" });
      else xmls.push(f);
    } else {
      ignored.push({ file: f.name, status: "IGNORADO", reason: "Só XML ou ZIP" });
    }
  }
  return { xmls: xmls.slice(0, MAX_FILES), ignored };
}

export async function ingestFiles(
  pool: Pool,
  tenantId: string,
  files: IncomingFile[],
  opts: { source: "UPLOAD" | "PASTA"; actor: Actor },
): Promise<IntakeReport> {
  const { xmls, ignored } = expandFiles(files);
  const report: IntakeReport = { items: [...ignored], imported: 0, duplicated: 0, rejected: ignored.filter((i) => i.status === "INVALIDO").length, byEntity: {} };

  await withTenant(pool, tenantId, async (tx) => {
    const ents = await tx.query<{ id: string; cnpj: string; name: string }>(
      "SELECT id, cnpj, coalesce(trade_name, legal_name) AS name FROM entity WHERE cnpj IS NOT NULL",
    );
    const byRoot = new Map<string, { id: string; cnpj: string; name: string }[]>();
    for (const e of ents.rows) byRoot.set(e.cnpj.slice(0, 8), [...(byRoot.get(e.cnpj.slice(0, 8)) ?? []), e]);

    for (const f of xmls) {
      const xml = decodeXml(f.bytes);
      const doc: FiscalDoc | null = parseFiscalXml(xml);
      if (!doc) {
        report.items.push({ file: f.name, status: "INVALIDO", reason: "Não é XML fiscal reconhecido (NF-e, NFC-e, CT-e, NFS-e ou evento)" });
        report.rejected++;
        continue;
      }
      const targets = new Map<string, { id: string; cnpj: string; name: string }>();
      for (const p of doc.parties) for (const e of byRoot.get(p.length === 14 ? p.slice(0, 8) : p) ?? []) targets.set(e.id, e);
      if (!targets.size) {
        report.items.push({ file: f.name, status: "SEM_EMPRESA", docType: doc.docType, accessKey: doc.accessKey, reason: "Nenhuma empresa do escritório no documento" });
        report.rejected++;
        continue;
      }
      const sha = createHash("sha256").update(xml, "utf8").digest();
      for (const e of targets.values()) {
        const role = roleOf(doc, e.cnpj);
        const ins = await tx.query(
          `INSERT INTO fiscal_xml (id, tenant_id, entity_id, source, doc_type, role, access_key, number, issuer_doc, issuer_name, recipient_doc,
                                   recipient_name, issued_at, total, status, event_type, file_name, xml, sha256, received_by)
           VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
           ON CONFLICT DO NOTHING`,
          [newId(), e.id, opts.source, doc.docType, role, doc.accessKey, doc.number, doc.issuerDoc, doc.issuerName, doc.recipientDoc,
            doc.recipientName, doc.issuedAt, doc.total, doc.status, doc.eventType, basename(f.name).slice(0, 200), xml, sha, opts.actor.id],
        );
        if (ins.rowCount) {
          report.imported++;
          const per = (report.byEntity[e.id] ??= {});
          per[doc.docType] = (per[doc.docType] ?? 0) + 1;
          report.items.push({ file: f.name, status: "IMPORTADO", docType: doc.docType, entity: e.name, role, accessKey: doc.accessKey });
        } else {
          report.duplicated++;
          report.items.push({ file: f.name, status: "DUPLICADO", docType: doc.docType, entity: e.name, role, accessKey: doc.accessKey });
        }
      }
    }

    for (const [entityId, types] of Object.entries(report.byEntity)) {
      const n = Object.values(types).reduce((a, b) => a + b, 0);
      const batch = newId();
      await appendEvent(tx, {
        type: "XML_BATCH_IMPORTED",
        schemaVersion: 1,
        producer: { kind: "agent", name: "docs", version: "1" },
        idempotencyKey: `xml:${entityId}:${batch}`,
        entityId,
        payload: { entity_id: entityId, documents: n, types, source: opts.source },
      });
      await audit(tx, {
        actor: opts.actor,
        action: "documents.xml_imported",
        resourceType: "fiscal_xml",
        resourceId: batch,
        entityId,
        data: { documents: n, types, source: opts.source, files: xmls.length },
      });
    }
  });
  return report;
}

/**
 * Pasta de entrada: importa o que estiver lá e move cada arquivo para
 * processados/AAAA-MM-DD (importado ou duplicado) ou recusados/AAAA-MM-DD.
 * Nada é apagado.
 */
export async function scanInbox(pool: Pool, tenantId: string, dir: string, actor: Actor, now = new Date()): Promise<IntakeReport | null> {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const names = readdirSync(dir).filter((n) => {
    try {
      return statSync(join(dir, n)).isFile() && /\.(xml|zip)$/i.test(n);
    } catch {
      return false;
    }
  });
  if (!names.length) return null;
  const files = names.map((n) => ({ name: n, bytes: readFileSync(join(dir, n)) }));
  const report = await ingestFiles(pool, tenantId, files, { source: "PASTA", actor });
  const day = now.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  for (const n of names) {
    const items = report.items.filter((i) => i.file === n || i.file.startsWith(`${n}/`));
    const ok = items.some((i) => i.status === "IMPORTADO" || i.status === "DUPLICADO");
    const target = join(dir, ok ? "processados" : "recusados", day);
    mkdirSync(target, { recursive: true });
    let dest = join(target, n);
    if (existsSync(dest)) dest = join(target, `${Date.now()}-${n}`);
    renameSync(join(dir, n), dest);
  }
  return report;
}

/** Documentos recebidos por upload, pasta ou distribuição de CT-e. */
export async function fiscalXmlList(pool: Pool, tenantId: string, entityId: string | null) {
  return withTenant(pool, tenantId, async (tx) => {
    const summary = await tx.query(
      `SELECT x.entity_id, coalesce(e.trade_name, e.legal_name) AS entity, x.doc_type, x.role, count(*)::int AS n,
              sum(x.total) FILTER (WHERE x.status = 'AUTORIZADO')::text AS total, min(x.issued_at) AS first_at, max(x.issued_at) AS last_at
         FROM fiscal_xml x JOIN entity e ON e.id = x.entity_id
        WHERE ($1::uuid IS NULL OR x.entity_id = $1)
        GROUP BY 1, 2, 3, 4 ORDER BY 2, 3, 4`,
      [entityId],
    );
    const recent = await tx.query(
      `SELECT x.received_at, coalesce(e.trade_name, e.legal_name) AS entity, x.source, x.doc_type, x.role, x.number, x.issuer_name, x.recipient_name,
              x.issued_at, x.total::text, x.status, x.event_type, x.access_key
         FROM fiscal_xml x JOIN entity e ON e.id = x.entity_id
        WHERE ($1::uuid IS NULL OR x.entity_id = $1)
        ORDER BY x.received_at DESC, x.issued_at DESC NULLS LAST LIMIT 100`,
      [entityId],
    );
    return { summary: summary.rows, recent: recent.rows };
  });
}
