import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { resolveTask } from "./index.js";
import type { ParsedTask } from "./types.js";

const ZONE = "America/Caracas";
const FHCA = "dce8df41-786e-40f4-9427-e833daf2d6a0";
const VERO = 118065209;
const MIGUEL = 216158839;

function dayMs(y: number, m: number, d: number): number {
  return DateTime.fromObject({ year: y, month: m, day: d }, { zone: ZONE })
    .startOf("day")
    .toMillis();
}

// Thursday 2026-06-18 10:00 local.
const NOW = DateTime.fromObject(
  { year: 2026, month: 6, day: 18, hour: 10 },
  { zone: ZONE },
).toMillis();

const full: ParsedTask = {
  title: "Diseñar banner",
  description: "Para la campaña de verano",
  clienteRaw: "FHCA",
  assigneesRaw: ["vero", "Pepe"],
  startDatePhrase: "hoy",
  dueDatePhrase: "viernes",
  links: ["https://loom.com/x"],
};

describe("resolveTask", () => {
  it("resolves a fully-populated ParsedTask into a ClickUp-ready ResolvedTask", () => {
    const r = resolveTask(full, NOW, { timezone: ZONE });
    expect(r).toEqual({
      title: "Diseñar banner",
      description: "Para la campaña de verano",
      clienteOptionId: FHCA,
      assigneeIds: [VERO],
      unresolvedAssignees: ["Pepe"],
      startDateMs: dayMs(2026, 6, 18),
      dueDateMs: dayMs(2026, 6, 19),
      links: ["https://loom.com/x"],
    });
  });

  it("resolves all-null/empty fields to null/empty (never invents)", () => {
    const empty: ParsedTask = {
      title: "Algo",
      description: null,
      clienteRaw: null,
      assigneesRaw: [],
      startDatePhrase: null,
      dueDatePhrase: null,
      links: [],
    };
    expect(resolveTask(empty, NOW, { timezone: ZONE })).toEqual({
      title: "Algo",
      description: null,
      clienteOptionId: null,
      assigneeIds: [],
      unresolvedAssignees: [],
      startDateMs: null,
      dueDateMs: null,
      links: [],
    });
  });

  it("defaults the timezone to America/Caracas when not provided", () => {
    const r = resolveTask(
      { ...full, assigneesRaw: [], clienteRaw: null, startDatePhrase: "hoy", dueDatePhrase: null },
      NOW,
    );
    expect(r.startDateMs).toBe(dayMs(2026, 6, 18));
  });

  it("honors an injected slackToMember override map", () => {
    const r = resolveTask(
      { ...full, assigneesRaw: ["U999"], clienteRaw: null, startDatePhrase: null, dueDatePhrase: null },
      NOW,
      { timezone: ZONE, slackToMember: { U999: MIGUEL } },
    );
    expect(r.assigneeIds).toEqual([MIGUEL]);
  });

  it("is pure: two calls with identical inputs are deeply equal", () => {
    const a = resolveTask(full, NOW, { timezone: ZONE });
    const b = resolveTask(full, NOW, { timezone: ZONE });
    expect(a).toEqual(b);
  });

  it("threads injected clientesConfig/membersConfig (live DYN-01/03)", () => {
    const parsed: ParsedTask = {
      title: "Tarea nueva",
      description: null,
      clienteRaw: "Nuevo Cliente SA",
      assigneesRaw: ["Nuevo Miembro"],
      startDatePhrase: null,
      dueDatePhrase: null,
      links: [],
    };
    const r = resolveTask(parsed, NOW, {
      timezone: ZONE,
      clientesConfig: { byName: { "nuevo cliente sa": "live-uuid" }, aliases: {} },
      membersConfig: { byName: { "nuevo miembro": 777 }, aliases: {}, byEmail: {} },
    });
    expect(r.clienteOptionId).toBe("live-uuid");
    expect(r.assigneeIds).toEqual([777]);
  });
});
