---
phase: 06-dynamic-config-from-clickup
reviewed: 2026-06-19T00:00:00Z
depth: deep
files_reviewed: 10
files_reviewed_list:
  - src/clickup/client.ts
  - src/clickup/types.ts
  - src/config/provider.ts
  - src/store/redis.ts
  - src/slack/slackEmail.ts
  - api/admin/refresh-config.ts
  - src/resolve/cliente.ts
  - src/resolve/assignees.ts
  - src/slack/app.ts
  - src/slack/process.ts
findings:
  critical: 0
  warning: 2
  info: 3
  total: 5
status: issues_found
---

# Phase 6: Code Review Report

**Reviewed:** 2026-06-19
**Depth:** deep
**Files Reviewed:** 10
**Status:** issues_found

## Summary

Phase 6 (Dynamic Config) is solid on its core contract. The degradation path (DYN-05) holds: `resolveTiered` wraps every tier and never throws; `processMessageEvent` additionally try/catches the live-config and slack-map merges; `resolveSlackMentionsToMembers` swallows per-id Slack/Redis failures. The ClickUp fetch paths shape-guard every nested access, coerce missing emails to null, and never log the token or any email. Prototype-pollution is correctly guarded with `Object.hasOwn` in both resolvers. The refresh gate is timing-safe and the signing secret is validated non-empty in `env.ts`, so the empty-buffer `timingSafeEqual` bypass is not reachable.

Two real defects: (1) a structurally-valid-but-empty ClickUp response poisons the non-expiring last-good cache and serves empty config for the full TTL, defeating DYN-05 for that window; (2) the admin secret travels in the URL query string. Neither blocks ship, but both should be fixed.

## Narrative Findings (AI reviewer)

## Warnings

### WR-01: Empty-but-successful ClickUp fetch poisons last-good and caches empty config

**File:** `src/config/provider.ts:170-180`, `src/store/redis.ts:308-318`
**Issue:** `resolveTiered` Tier 2 writes whatever `fetchLive()` returns into BOTH `cfg:<name>` (10min TTL) and `cfg:<name>:lastgood` (no TTL), unconditionally. `getClienteOptions()` returns `[]` (not an error) when the field exists but its `options` array is empty, and `getMembers()` returns `[]` when every row is filtered out — both produce a built config with empty `byName`/`byEmail`. That empty object is truthy, so it (a) is served, (b) is cached for 10 minutes, and (c) **overwrites the good last-good copy indefinitely**. The static fallback is never reached because the fetch "succeeded", so cliente/member resolution degrades to alias-only (or nothing) until the next genuinely-good fetch — exactly the outage DYN-05 promises to survive.
**Fix:** Treat an empty live result as a non-success: in the live builders or in `resolveTiered`, skip the cache/last-good write and fall through to last-good/static when `Object.keys(byName).length === 0`. e.g.
```ts
const live = await fetchLive();
if (isEmptyConfig(live)) throw new Error(`${name}: live fetch returned empty — treating as failure`);
```
so last-good is preserved and static fallback engages.

### WR-02: Admin/diag secret transmitted in URL query string

**File:** `api/admin/refresh-config.ts:27-31` (and `api/slack/diag.ts`)
**Issue:** Authentication uses `?secret=<SLACK_SIGNING_SECRET>` in the query string. Query strings are routinely captured in Vercel/proxy access logs, browser history, and Referer headers, so the credential leaks out-of-band even though it is never `console.log`-ed. It also conflates a Slack *signature-verification* secret with a bearer credential for an unrelated endpoint, widening blast radius if either leaks.
**Fix:** Move the secret to an `Authorization` header (or a dedicated `X-Admin-Token`) read via `req.headers.get(...)`, keep the timing-safe compare, and use a purpose-specific secret rather than `SLACK_SIGNING_SECRET`. The code comment already defers full hardening to Phase 8 — at minimum get it out of the query string.

## Info

### IN-01: State-mutating action exposed over GET

**File:** `api/admin/refresh-config.ts:27`
**Issue:** Clearing the cache is a side-effecting operation served as `GET`, which is supposed to be safe/idempotent; it is triggerable by any context that can issue a same-origin GET (prefetch, `<img>`, link). Impact is low (only drops the hot TTL keys, forcing a re-fetch; last-good is untouched), but it violates HTTP method semantics.
**Fix:** Require `POST` (return 405 otherwise) in addition to the secret gate.

### IN-02: Refresh endpoint reimplements `clearConfigCache` via a raw `keys("cfg:*")` scan

**File:** `api/admin/refresh-config.ts:39-44`
**Issue:** The endpoint hand-rolls a `redis.keys("cfg:*")` + `:lastgood` filter instead of calling the existing `clearConfigCache` helper in `src/store/redis.ts:345`. The two can drift (the helper only clears explicitly-named hot keys; the endpoint blindly clears every non-lastgood `cfg:*`, including `cfg:slackmap:*`). The broader scan is arguably intended (it also flushes the slack-map cache), but the divergence is undocumented and a future `cfg:` namespace addition would be silently swept.
**Fix:** Either route through a shared helper that enumerates the known names, or add a comment stating the scan is deliberately broader than `clearConfigCache` and why.

### IN-03: Refresh response echoes internal cache key names

**File:** `api/admin/refresh-config.ts:46`
**Issue:** The 200 body returns `{ cleared: [...] }` listing internal Redis key names (`cfg:clientes`, `cfg:members`, `cfg:slackmap:<id>`). Not sensitive, but it discloses internal namespacing and per-user slack-map key ids to any caller that passes the gate.
**Fix:** Return a count (`{ cleared: toClear.length }`) rather than the full key list.

---

_Reviewed: 2026-06-19_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
