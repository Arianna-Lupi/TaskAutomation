import { SLACK_TO_MEMBER } from "../config/members.js";
import { staticMembersConfig, type MembersConfig } from "../config/provider.js";

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
  /**
   * Resolved member config (the live provider data from plan 02). When absent it
   * defaults to the static maps via staticMembersConfig(), so existing callers
   * and tests see identical behavior to v1.0.
   */
  config?: MembersConfig;
};

/**
 * Resolve each raw assignee token to a ClickUp member id. Resolution order per
 * token: the Slack→member override map, then the config's canonical names
 * (case-insensitive), then the config's alias overlay. Resolved ids are deduped
 * and order-stable; unmatched tokens are dropped and surfaced in `unresolved`
 * (never mapped to an invented id — Pitfall 4). Pure/sync: no I/O.
 */
export function resolveAssignees(
  rawNames: string[],
  opts: ResolveAssigneesOpts = {},
): ResolveAssigneesResult {
  const slackToMember = opts.slackToMember ?? SLACK_TO_MEMBER;
  const config = opts.config ?? staticMembersConfig();
  const ids: number[] = [];
  const seen = new Set<number>();
  const unresolved: string[] = [];

  for (const raw of rawNames) {
    const id = resolveOne(raw, slackToMember, config);
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
  config: MembersConfig,
): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // 1) Slack user-id override (exact, case-sensitive — Slack ids are opaque).
  // Normalize a Slack mention first: "<@U123>" or "<@U123|name>" → "U123" so an
  // @-mention in the message resolves via the map; a bare "U123" is used as-is.
  // Guard with Object.hasOwn so inherited Object.prototype keys (e.g.
  // "constructor", "toString", "hasOwnProperty") can never resolve to a
  // prototype member and invent an id (Pitfall 4 / prototype pollution).
  const mention = trimmed.match(/^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/);
  const slackKey = mention ? mention[1]! : trimmed;
  const slackHit = slackToMember[slackKey];
  if (Object.hasOwn(slackToMember, slackKey) && slackHit !== undefined) {
    return slackHit;
  }

  const norm = trimmed.toLowerCase();

  // 2) Canonical member name (config.byName keyed by lowercased name). Own-key
  // guarded so an inherited prototype key can never resolve to an id.
  if (Object.hasOwn(config.byName, norm)) {
    const id = config.byName[norm];
    if (id !== undefined) return id;
  }

  // 3) Alias overlay — own-key guarded for the same reason as the Slack map.
  if (Object.hasOwn(config.aliases, norm)) {
    const id = config.aliases[norm];
    if (id !== undefined) return id;
  }

  return null;
}
