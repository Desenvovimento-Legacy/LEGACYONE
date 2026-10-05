import { v7 } from "uuid";

/** UUID v7: ordenável no tempo, bom para índices e para o event_id. */
export function newId(): string {
  return v7();
}
