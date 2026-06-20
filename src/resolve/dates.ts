import { DateTime } from "luxon";

/**
 * Resolve a relative Spanish date phrase to an epoch-millisecond timestamp,
 * computed entirely in `timezone` (the team TZ, default America/Caracas) — NOT
 * the server's UTC clock (Pitfall 5). `now` is injected for determinism (the
 * function never calls Date.now()).
 *
 * Time-of-day convention: every resolved date is normalized to **start-of-day
 * in zone** (00:00 local), matching all-day ClickUp tasks. luxon converts that
 * in-zone wall time to a true UTC epoch via the zone offset, so the returned ms
 * is always a correct absolute instant.
 *
 * Returns null for anything it can't confidently parse (never guesses).
 */
export function resolveSpanishDate(
  phrase: string | null,
  now: number,
  timezone: string,
): number | null {
  if (!phrase) return null;

  const today = DateTime.fromMillis(now, { zone: timezone }).startOf("day");
  const norm = normalize(phrase);
  if (norm.length === 0) return null;

  // Keywords are matched as WORDS ANYWHERE in the phrase (not exact-equal), so a
  // phrase like "jueves a las 12 del mediodia" still resolves the date. Order
  // matters: "pasado manana" before "manana"; "en N dias" before lone weekdays.
  const has = (re: RegExp): boolean => re.test(norm);

  // hoy
  if (has(/\bhoy\b/)) return today.toMillis();

  // pasado manana (check before "manana")
  if (has(/\bpasado\s+manana\b/)) return today.plus({ days: 2 }).toMillis();

  // manana
  if (has(/\bmanana\b/)) return today.plus({ days: 1 }).toMillis();

  // "en N dias"
  const inDays = norm.match(/\ben\s+(\d+)\s+dias?\b/);
  if (inDays) {
    const n = Number(inDays[1]);
    return today.plus({ days: n }).toMillis();
  }

  // weekday names anywhere in the phrase (articles like el/este/proximo are
  // simply skipped by the word-boundary search).
  for (const [name, targetWeekday] of Object.entries(WEEKDAYS)) {
    if (has(new RegExp(`\\b${name}\\b`))) {
      let d = today;
      // on-or-after today: advance until weekday matches.
      while (d.weekday !== targetWeekday) {
        d = d.plus({ days: 1 });
      }
      return d.toMillis();
    }
  }

  // explicit dd/mm or dd/mm/yyyy (anywhere in the phrase)
  const explicit = norm.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (explicit) {
    const day = Number(explicit[1]);
    const month = Number(explicit[2]);
    const hasYear = Boolean(explicit[3]);
    // Expand 2-digit years to 20xx (e.g. "26" → 2026); 4-digit used as-is,
    // so "12/07/26" no longer becomes year 0026 AD.
    const year = hasYear
      ? explicit[3]!.length === 2
        ? 2000 + Number(explicit[3])
        : Number(explicit[3])
      : today.year;
    const dt = DateTime.fromObject({ year, month, day }, { zone: timezone });
    if (!dt.isValid) return null;
    const startOfDay = dt.startOf("day");
    // Bare dd/mm (no explicit year) rolls forward to the next future
    // occurrence when already past, consistent with the weekday logic above.
    if (!hasYear && startOfDay < today) {
      return startOfDay.plus({ years: 1 }).toMillis();
    }
    return startOfDay.toMillis();
  }

  return null;
}

/** lowercase, trim, collapse spaces, strip accents. */
function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining accents
    .replace(/\s+/g, " ");
}

/** Spanish weekday name → luxon weekday number (1=Mon … 7=Sun). */
const WEEKDAYS: Record<string, number> = {
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
  domingo: 7,
};
