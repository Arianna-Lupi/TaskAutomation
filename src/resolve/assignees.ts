import {
  MEMBERS,
  MEMBER_ALIASES,
  SLACK_TO_MEMBER,
  type MemberName,
} from "../config/members.js";

export type ResolveAssigneesResult = {
  ids: number[];
  unresolved: string[];
};

export type ResolveAssigneesOpts = {
  /**
   * Slack user-id → member-id override map. Injected so tests don't depend on
   * the empty production default; the caller (plan 03) passes the real map.
   */
  slackToMember?: Record<string, number>;
};

/**
 * Resolve each raw assignee token to a ClickUp member id. Resolution order per
 * token: the Slack→member override map, then canonical MEMBERS names
 * (case-insensitive), then MEMBER_ALIASES. Resolved ids are deduped and
 * order-stable; unmatched tokens are dropped and surfaced in `unresolved`
 * (never mapped to an invented id — Pitfall 4). Pure: no I/O.
 */
export function resolveAssignees(
  rawNames: string[],
  opts: ResolveAssigneesOpts = {},
): ResolveAssigneesResult {
  const slackToMember = opts.slackToMember ?? SLACK_TO_MEMBER;
  const ids: number[] = [];
  const seen = new Set<number>();
  const unresolved: string[] = [];

  for (const raw of rawNames) {
    const id = resolveOne(raw, slackToMember);
    if (id === null) {
      unresolved.push(raw);
      continue;
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  return { ids, unresolved };
}

function resolveOne(
  raw: string,
  slackToMember: Record<string, number>,
): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // 1) Slack user-id override (exact, case-sensitive — Slack ids are opaque).
  const slackHit = slackToMember[trimmed];
  if (slackHit !== undefined) return slackHit;

  const norm = trimmed.toLowerCase();

  // 2) Canonical member name (case-insensitive).
  for (const name of Object.keys(MEMBERS) as MemberName[]) {
    if (name.toLowerCase() === norm) return MEMBERS[name];
  }

  // 3) Alias table.
  const aliased = (MEMBER_ALIASES as Record<string, MemberName>)[norm];
  if (aliased) return MEMBERS[aliased];

  return null;
}
