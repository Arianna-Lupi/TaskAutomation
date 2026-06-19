import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { resolveSpanishDate } from "./dates.js";

const ZONE = "America/Caracas"; // UTC-4, no DST

/** start-of-day epoch ms for a given calendar date IN ZONE (the convention). */
function dayMs(year: number, month: number, day: number): number {
  return DateTime.fromObject({ year, month, day }, { zone: ZONE })
    .startOf("day")
    .toMillis();
}

/** Build a `now` epoch ms from in-zone wall-clock components. */
function nowMs(
  year: number,
  month: number,
  day: number,
  hour = 10,
  minute = 0,
): number {
  return DateTime.fromObject(
    { year, month, day, hour, minute },
    { zone: ZONE },
  ).toMillis();
}

// Thursday 2026-06-18 10:00 local Caracas.
const NOW = nowMs(2026, 6, 18, 10, 0);

describe("resolveSpanishDate (PARSE-04)", () => {
  it("'hoy' → start-of-day of now's local date", () => {
    expect(resolveSpanishDate("hoy", NOW, ZONE)).toBe(dayMs(2026, 6, 18));
  });

  it("'mañana' → next local day", () => {
    expect(resolveSpanishDate("mañana", NOW, ZONE)).toBe(dayMs(2026, 6, 19));
    // accent-insensitive
    expect(resolveSpanishDate("manana", NOW, ZONE)).toBe(dayMs(2026, 6, 19));
  });

  it("'pasado mañana' → now + 2 days", () => {
    expect(resolveSpanishDate("pasado mañana", NOW, ZONE)).toBe(
      dayMs(2026, 6, 20),
    );
  });

  it("weekday 'viernes' / 'el viernes' / 'este viernes' → next Friday on-or-after now", () => {
    // 2026-06-18 is Thursday → next Friday is 2026-06-19.
    const friday = dayMs(2026, 6, 19);
    expect(resolveSpanishDate("viernes", NOW, ZONE)).toBe(friday);
    expect(resolveSpanishDate("el viernes", NOW, ZONE)).toBe(friday);
    expect(resolveSpanishDate("este viernes", NOW, ZONE)).toBe(friday);
  });

  it("weekday resolves to today when now IS that weekday (on-or-after)", () => {
    // Thursday → 'jueves' is today.
    expect(resolveSpanishDate("jueves", NOW, ZONE)).toBe(dayMs(2026, 6, 18));
  });

  it("'lunes' → the following Monday", () => {
    // After Thursday 06-18, next Monday is 2026-06-22.
    expect(resolveSpanishDate("el lunes", NOW, ZONE)).toBe(dayMs(2026, 6, 22));
  });

  it("'en 3 días' → now + 3 days", () => {
    expect(resolveSpanishDate("en 3 días", NOW, ZONE)).toBe(dayMs(2026, 6, 21));
    expect(resolveSpanishDate("en 3 dias", NOW, ZONE)).toBe(dayMs(2026, 6, 21));
  });

  it("explicit dd/mm → that date in the current year", () => {
    expect(resolveSpanishDate("12/07", NOW, ZONE)).toBe(dayMs(2026, 7, 12));
  });

  it("explicit dd/mm/yyyy → that exact date", () => {
    expect(resolveSpanishDate("25/12/2027", NOW, ZONE)).toBe(dayMs(2027, 12, 25));
  });

  it("expands a 2-digit year to 20xx (no longer year 0026 AD)", () => {
    expect(resolveSpanishDate("12/07/26", NOW, ZONE)).toBe(dayMs(2026, 7, 12));
    expect(resolveSpanishDate("25/12/27", NOW, ZONE)).toBe(dayMs(2027, 12, 25));
  });

  it("bare dd/mm in the past rolls forward to next year (weekday-consistent)", () => {
    // NOW is 2026-06-18; Jan 1 already passed → next occurrence is 2027-01-01.
    expect(resolveSpanishDate("01/01", NOW, ZONE)).toBe(dayMs(2027, 1, 1));
    // A future dd/mm stays in the current year (regression guard).
    expect(resolveSpanishDate("12/07", NOW, ZONE)).toBe(dayMs(2026, 7, 12));
  });

  it("OFF-BY-ONE GUARD: 23:30 local (03:30 UTC next day) — 'mañana' uses the LOCAL day", () => {
    const lateNight = nowMs(2026, 6, 18, 23, 30); // 2026-06-19 03:30 UTC
    // mañana must be local June 19, NOT the UTC-shifted June 20.
    expect(resolveSpanishDate("mañana", lateNight, ZONE)).toBe(dayMs(2026, 6, 19));
    expect(resolveSpanishDate("hoy", lateNight, ZONE)).toBe(dayMs(2026, 6, 18));
  });

  it("returns null for unparseable phrases", () => {
    expect(resolveSpanishDate("algún día", NOW, ZONE)).toBeNull();
    expect(resolveSpanishDate("", NOW, ZONE)).toBeNull();
    expect(resolveSpanishDate(null, NOW, ZONE)).toBeNull();
  });
});
