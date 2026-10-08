import type { Pool } from "pg";
import { withTenant } from "../../shared/db/tenant-tx.js";
import { newId } from "../../shared/ids.js";

/**
 * Rotinas em horários fixos do dia (horário de Brasília). Ex.: busca de notas
 * às 07:00 e às 18:00. Se o computador estava desligado no horário, roda assim
 * que o sistema abrir (o horário mais recente que passou e ainda não rodou).
 */

export const DEFAULT_NOTE_SLOTS = ["07:00", "18:00"];

export function parseSlots(raw: string | undefined, fallback: string[]): string[] {
  const list = (raw ?? "").split(",").map((x) => x.trim()).filter((x) => /^([01]\d|2[0-3]):[0-5]\d$/.test(x));
  return (list.length ? list : fallback).sort();
}

/** Instante (UTC) do horário "HH:MM" de Brasília no dia AAAA-MM-DD. */
export function slotAt(day: string, hhmm: string): Date {
  return new Date(`${day}T${hhmm}:00-03:00`);
}

const dayOf = (d: Date) => d.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
const prevDay = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/** Horário mais recente que já passou (hoje ou o último de ontem). */
export function latestSlot(now: Date, slots: string[]): Date {
  const today = dayOf(now);
  const past = slots.map((s) => slotAt(today, s)).filter((d) => d <= now);
  if (past.length) return past[past.length - 1]!;
  return slotAt(prevDay(today), slots[slots.length - 1]!);
}

/** Próximo horário depois de agora. */
export function nextSlot(now: Date, slots: string[]): Date {
  const today = dayOf(now);
  const next = slots.map((s) => slotAt(today, s)).find((d) => d > now);
  if (next) return next;
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return slotAt(d.toISOString().slice(0, 10), slots[0]!);
}

/** Se o horário mais recente ainda não rodou, devolve-o (para rodar agora). */
export async function dueSlot(pool: Pool, tenantId: string, job: string, slots: string[], now = new Date()): Promise<Date | null> {
  const latest = latestSlot(now, slots);
  const r = await withTenant(pool, tenantId, (tx) =>
    tx.query("SELECT 1 FROM scheduled_run WHERE job = $1 AND trigger = 'HORARIO' AND slot >= $2 LIMIT 1", [job, latest]),
  );
  return r.rowCount ? null : latest;
}

export async function recordRun(pool: Pool, tenantId: string, input: { job: string; slot: Date; trigger: "HORARIO" | "PESSOA"; actorId: string; result: unknown }) {
  await withTenant(pool, tenantId, (tx) =>
    tx.query("INSERT INTO scheduled_run (id, tenant_id, job, slot, trigger, actor_id, result) VALUES ($1, current_tenant(), $2, $3, $4, $5, $6)", [
      newId(), input.job, input.slot, input.trigger, input.actorId, JSON.stringify(input.result ?? {}),
    ]),
  );
}

export async function lastRuns(pool: Pool, tenantId: string, job: string) {
  const r = await withTenant(pool, tenantId, (tx) =>
    tx.query<{ ran_at: Date; trigger: string; actor_id: string; result: Record<string, unknown> }>(
      "SELECT ran_at, trigger, actor_id, result FROM scheduled_run WHERE job = $1 ORDER BY ran_at DESC LIMIT 5",
      [job],
    ),
  );
  return r.rows;
}
