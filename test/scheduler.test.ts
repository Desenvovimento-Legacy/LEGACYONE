import { describe, expect, it } from "vitest";
import { dueSlot, latestSlot, nextSlot, parseSlots, recordRun } from "../src/platform/scheduler/daily-slots.js";
import { appPool, newTenant } from "./helpers.js";

const at = (s: string) => new Date(`${s}-03:00`);
const SLOTS = ["07:00", "18:00"];

describe("agenda de horários fixos", () => {
  it("horário mais recente, próximo e recuperação quando o computador estava desligado", async () => {
    expect(parseSlots("18:00, 7:00, 07:30", ["07:00"])).toEqual(["07:30", "18:00"]);
    expect(parseSlots("", ["07:00", "18:00"])).toEqual(["07:00", "18:00"]);
    expect(latestSlot(at("2026-10-08T06:30:00"), SLOTS)).toEqual(at("2026-10-07T18:00:00"));
    expect(latestSlot(at("2026-10-08T10:00:00"), SLOTS)).toEqual(at("2026-10-08T07:00:00"));
    expect(latestSlot(at("2026-10-08T19:00:00"), SLOTS)).toEqual(at("2026-10-08T18:00:00"));
    expect(nextSlot(at("2026-10-08T10:00:00"), SLOTS)).toEqual(at("2026-10-08T18:00:00"));
    expect(nextSlot(at("2026-10-08T19:00:00"), SLOTS)).toEqual(at("2026-10-09T07:00:00"));

    const t = await newTenant();
    // Ligou às 10:00: a busca das 07:00 roda agora
    const due = await dueSlot(appPool, t, "busca-notas", SLOTS, at("2026-10-08T10:00:00"));
    expect(due).toEqual(at("2026-10-08T07:00:00"));
    await recordRun(appPool, t, { job: "busca-notas", slot: due!, trigger: "HORARIO", actorId: "docs", result: {} });
    expect(await dueSlot(appPool, t, "busca-notas", SLOTS, at("2026-10-08T12:00:00"))).toBeNull();
    // Pedido de pessoa no meio do dia não conta como o horário das 18:00
    await recordRun(appPool, t, { job: "busca-notas", slot: at("2026-10-08T14:00:00"), trigger: "PESSOA", actorId: "luan", result: {} });
    expect(await dueSlot(appPool, t, "busca-notas", SLOTS, at("2026-10-08T18:01:00"))).toEqual(at("2026-10-08T18:00:00"));
  });
});
