import type { PoolClient } from "pg";

/**
 * Calendário de dias úteis (base calendar_day_off) e ajuste de vencimento.
 *
 * Regra conservadora — na dúvida, a data mais cedo:
 *  - ANTECIPA (PREVIOUS_BUSINESS_DAY): pula fim de semana, feriado nacional e
 *    dia sem expediente bancário;
 *  - PRORROGA (NEXT_BUSINESS_DAY): pula só fim de semana e feriado nacional.
 *    Dia só sem expediente bancário (Carnaval, Corpus Christi...) não prorroga.
 * Feriados municipais ainda não entram (próxima etapa, por município).
 */

export type DueAdjust = "NONE" | "NEXT_BUSINESS_DAY" | "PREVIOUS_BUSINESS_DAY";
export type DayOffKind = "FERIADO_NACIONAL" | "SEM_EXPEDIENTE_BANCARIO";

export interface DayOff {
  day: string;
  kind: DayOffKind;
  name: string;
}

export class BusinessCalendar {
  private readonly days = new Map<string, DayOff>();
  constructor(daysOff: DayOff[]) {
    for (const d of daysOff) this.days.set(d.day, d);
  }

  dayOff(iso: string): DayOff | null {
    return this.days.get(iso) ?? null;
  }

  static weekend(iso: string): boolean {
    const w = new Date(`${iso}T12:00:00Z`).getUTCDay();
    return w === 0 || w === 6;
  }

  /** Dia útil para o sentido do ajuste (ver regra conservadora acima). */
  isBusinessDay(iso: string, direction: "forward" | "backward"): boolean {
    if (BusinessCalendar.weekend(iso)) return false;
    const off = this.days.get(iso);
    if (!off) return true;
    return direction === "forward" ? off.kind !== "FERIADO_NACIONAL" : false;
  }

  /** Vencimento ajustado e o motivo, quando a data mudou. */
  adjust(iso: string, policy: DueAdjust | undefined): { due: string; reason: string | null } {
    if (!policy || policy === "NONE") return { due: iso, reason: null };
    const forward = policy === "NEXT_BUSINESS_DAY";
    let d = iso;
    for (let i = 0; i < 15 && !this.isBusinessDay(d, forward ? "forward" : "backward"); i++) d = addDays(d, forward ? 1 : -1);
    if (d === iso) return { due: iso, reason: null };
    const off = this.days.get(iso);
    const why = off ? off.name : BusinessCalendar.weekend(iso) ? (new Date(`${iso}T12:00:00Z`).getUTCDay() === 0 ? "domingo" : "sábado") : "dia não útil";
    return { due: d, reason: `${fmt(iso)} é ${why}: ${forward ? "prorrogado" : "antecipado"}` };
  }
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function fmt(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/** Calendário nacional (jurisdição BR). */
export async function loadCalendar(tx: PoolClient): Promise<BusinessCalendar> {
  const { rows } = await tx.query<DayOff>(
    "SELECT day::text AS day, kind, name FROM calendar_day_off WHERE jurisdiction = 'BR' ORDER BY day",
  );
  return new BusinessCalendar(rows);
}
