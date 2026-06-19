import { resolveCliente } from "./cliente.js";
import { resolveAssignees } from "./assignees.js";
import { resolveSpanishDate } from "./dates.js";
import type { ParsedTask, ResolvedTask } from "./types.js";

/** Default team timezone (mirrors the env default — plan 03 passes env.TEAM_TIMEZONE). */
const DEFAULT_TIMEZONE = "America/Caracas";

export type ResolveTaskOpts = {
  timezone?: string;
  slackToMember?: Record<string, number>;
};

/**
 * Compose the three deterministic resolvers into a single ClickUp-ready
 * ResolvedTask. Pure: no I/O, no Date.now() — `now` is injected. Title,
 * description, and links pass through unchanged; cliente/assignees/dates are
 * resolved to real ids / epoch-ms (or null/empty when unmatched — Pitfall 4).
 */
export function resolveTask(
  parsed: ParsedTask,
  now: number,
  opts: ResolveTaskOpts = {},
): ResolvedTask {
  const timezone = opts.timezone ?? DEFAULT_TIMEZONE;
  const { ids, unresolved } = resolveAssignees(parsed.assigneesRaw, {
    slackToMember: opts.slackToMember,
  });

  return {
    title: parsed.title,
    description: parsed.description,
    clienteOptionId: resolveCliente(parsed.clienteRaw),
    assigneeIds: ids,
    unresolvedAssignees: unresolved,
    startDateMs: resolveSpanishDate(parsed.startDatePhrase, now, timezone),
    dueDateMs: resolveSpanishDate(parsed.dueDatePhrase, now, timezone),
    links: parsed.links,
  };
}

// Barrel: the resolve/ public surface.
export { resolveCliente } from "./cliente.js";
export { resolveAssignees } from "./assignees.js";
export { resolveSpanishDate } from "./dates.js";
export type { ParsedTask, ResolvedTask } from "./types.js";
