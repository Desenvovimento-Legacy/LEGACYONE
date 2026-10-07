import type { Pool } from "pg";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";
import { eventCause, type StoredEvent } from "../events/outbox.js";
import type { EventType } from "../events/registry.js";

/**
 * Orquestrador: liga os agentes por evento, sem repasse manual.
 *
 * Cada vínculo diz "quando acontecer X, o agente Y faz Z". O orquestrador lê o
 * outbox, entrega a cada vínculo os eventos que ele ainda não tratou (inbox,
 * consumidor = id do vínculo) e registra cada reação em agent_reaction.
 *
 * - Eventos da mesma empresa chegando juntos viram UMA reação (as reações
 *   recalculam o estado, então tratar o último basta).
 * - O que a reação gravar no outbox aponta para o evento que a disparou
 *   (causation_id) e herda a correlação: a cadeia fica visível.
 * - Reações são idempotentes: o inbox é marcado depois do sucesso; se cair no
 *   meio, refazer não duplica nada.
 * - Erro é refeito até MAX_ATTEMPTS vezes; depois vai para a Fila humana.
 * - Uma reação pode gerar eventos que disparam outros vínculos: o ciclo roda
 *   em rodadas até não sobrar nada (limite de MAX_ROUNDS contra laço).
 */

export const MAX_ATTEMPTS = 3;
const MAX_ROUNDS = 6;
const LOOKBACK_DAYS = 30;

export interface LinkContext<D> {
  pool: Pool;
  tenantId: string;
  entityId: string | null;
  /** eventos tratados nesta reação, do mais antigo ao mais recente */
  events: StoredEvent[];
  deps: D;
}

export interface Link<D> {
  id: string;
  on: EventType[];
  /** id do agente que reage (como no catálogo) */
  agent: string;
  /** o que o agente faz, em português, para a tela */
  does: string;
  /** filtro opcional: só reage a eventos que passam */
  when?: (e: StoredEvent) => boolean;
  /** false = uma reação só para todos os eventos (sem empresa) */
  perEntity?: boolean;
  run: (ctx: LinkContext<D>) => Promise<Record<string, unknown> | void>;
}

export interface OrchestratorResult {
  reactions: number;
  errors: number;
  rounds: number;
}

const locks = new Map<string, Promise<unknown>>();

/** Roda os vínculos até não haver evento pendente. Chamadas simultâneas por escritório entram em fila. */
export function runOrchestrator<D>(pool: Pool, tenantId: string, links: Link<D>[], deps: D): Promise<OrchestratorResult> {
  const prev = locks.get(tenantId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => runRounds(pool, tenantId, links, deps));
  locks.set(tenantId, next);
  return next;
}

async function runRounds<D>(pool: Pool, tenantId: string, links: Link<D>[], deps: D): Promise<OrchestratorResult> {
  const total: OrchestratorResult = { reactions: 0, errors: 0, rounds: 0 };
  const failed = new Set<string>(); // vínculo que errou nesta execução só tenta de novo no próximo ciclo
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let did = 0;
    for (const link of links) {
      if (failed.has(link.id)) continue;
      const r = await runLink(pool, tenantId, link, deps);
      if (r.errors) failed.add(link.id);
      did += r.reactions; // erro não puxa nova rodada: tenta de novo no próximo ciclo
      total.reactions += r.reactions;
      total.errors += r.errors;
    }
    total.rounds = round + 1;
    if (!did) break;
  }
  return total;
}

async function runLink<D>(pool: Pool, tenantId: string, link: Link<D>, deps: D) {
  const pending = await withTenant(pool, tenantId, async (tx) => {
    const { rows } = await tx.query<StoredEvent>(
      `SELECT o.* FROM outbox o
        WHERE o.type = ANY($1) AND o.occurred_at > now() - make_interval(days => $3)
          AND NOT EXISTS (SELECT 1 FROM inbox i WHERE i.consumer = $2 AND i.event_id = o.event_id)
          AND (SELECT count(*) FROM agent_reaction r
                WHERE r.link_id = $2 AND r.status = 'ERRO'
                  AND (r.event_id = o.event_id OR r.result->'event_ids' ? o.event_id::text)) < $4
        ORDER BY o.occurred_at, o.event_id
        LIMIT 500`,
      [link.on, link.id, LOOKBACK_DAYS, MAX_ATTEMPTS],
    );
    // Eventos que o filtro descarta: marcados como vistos, sem reação.
    const skip = link.when ? rows.filter((e) => !link.when!(e)) : [];
    for (const e of skip) {
      await tx.query("INSERT INTO inbox (consumer, event_id, tenant_id) VALUES ($1, $2, current_tenant()) ON CONFLICT DO NOTHING", [link.id, e.event_id]);
    }
    return link.when ? rows.filter((e) => link.when!(e)) : rows;
  });
  if (!pending.length) return { reactions: 0, errors: 0 };

  const groups = new Map<string, StoredEvent[]>();
  for (const e of pending) {
    const key = link.perEntity === false ? "*" : (e.entity_id ?? "-");
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }

  let reactions = 0;
  let errors = 0;
  for (const [key, events] of groups) {
    const last = events[events.length - 1]!;
    const entityId = key === "*" || key === "-" ? null : key;
    const started = new Date();
    try {
      const result =
        (await eventCause.run({ causationId: last.event_id, correlationId: last.correlation_id }, () =>
          link.run({ pool, tenantId, entityId, events, deps }),
        )) ?? {};
      await withTenant(pool, tenantId, async (tx) => {
        for (const e of events) {
          await tx.query("INSERT INTO inbox (consumer, event_id, tenant_id) VALUES ($1, $2, current_tenant()) ON CONFLICT DO NOTHING", [link.id, e.event_id]);
        }
        await tx.query(
          `INSERT INTO agent_reaction (id, tenant_id, link_id, agent, event_id, event_type, events, entity_id, status, result, started_at)
           VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, 'OK', $8, $9)`,
          [newId(), link.id, link.agent, last.event_id, last.type, events.length, entityId, JSON.stringify(result), started],
        );
      });
      reactions++;
    } catch (err) {
      const message = String((err as Error)?.message ?? err).slice(0, 500);
      await withTenant(pool, tenantId, (tx) =>
        tx.query(
          `INSERT INTO agent_reaction (id, tenant_id, link_id, agent, event_id, event_type, events, entity_id, status, error, started_at, result)
           VALUES ($1, current_tenant(), $2, $3, $4, $5, $6, $7, 'ERRO', $8, $9, $10)`,
          [newId(), link.id, link.agent, last.event_id, last.type, events.length, entityId, message, started, JSON.stringify({ event_ids: events.map((e) => e.event_id) })],
        ),
      );
      errors++;
    }
  }
  return { reactions, errors };
}
