import { z } from "zod";

/** Quem executa uma ação: pessoa, agente de IA ou o próprio sistema. */
export const Actor = z.object({
  kind: z.enum(["USER", "AGENT", "SYSTEM"]),
  id: z.string().min(1),
  /** Modelo de IA usado, quando kind = AGENT. */
  model: z.string().optional(),
});
export type Actor = z.infer<typeof Actor>;
