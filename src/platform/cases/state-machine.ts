import { z } from "zod";

export const CaseStatus = z.enum([
  "OPEN",
  "IN_PROGRESS",
  "WAITING_CLIENT",
  "WAITING_EXTERNAL",
  "WAITING_HUMAN",
  "IN_REVIEW",
  "COMPLETED",
  "CANCELLED",
]);
export type CaseStatus = z.infer<typeof CaseStatus>;

export const TERMINAL: ReadonlySet<CaseStatus> = new Set(["COMPLETED", "CANCELLED"]);

const WAITING: CaseStatus[] = ["WAITING_CLIENT", "WAITING_EXTERNAL", "WAITING_HUMAN"];

/**
 * Transições permitidas. Um Case só chega a COMPLETED passando por IN_REVIEW:
 * nada é concluído sem revisão. Bloqueio do Review devolve para IN_PROGRESS.
 */
const ALLOWED: Record<CaseStatus, readonly CaseStatus[]> = {
  OPEN: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: [...WAITING, "IN_REVIEW", "CANCELLED"],
  WAITING_CLIENT: ["IN_PROGRESS", "CANCELLED"],
  WAITING_EXTERNAL: ["IN_PROGRESS", "CANCELLED"],
  WAITING_HUMAN: ["IN_PROGRESS", "CANCELLED"],
  IN_REVIEW: ["COMPLETED", "IN_PROGRESS", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransition(from: CaseStatus, to: CaseStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function allowedFrom(from: CaseStatus): readonly CaseStatus[] {
  return ALLOWED[from];
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: CaseStatus,
    readonly to: CaseStatus,
  ) {
    super(`Transição inválida: ${from} -> ${to}. Permitidas: ${ALLOWED[from].join(", ") || "nenhuma (estado final)"}`);
    this.name = "InvalidTransitionError";
  }
}
