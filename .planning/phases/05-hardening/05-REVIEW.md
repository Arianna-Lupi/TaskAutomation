---
phase: 05-hardening
reviewed: 2026-06-18T00:00:00Z
depth: deep
files_reviewed: 8
files_reviewed_list:
  - src/clickup/retry.ts
  - src/clickup/client.ts
  - src/slack/report.ts
  - src/slack/process.ts
  - src/slack/interactions.ts
  - src/store/redis.ts
  - scripts/killswitch.mjs
  - README.md
findings:
  critical: 0
  warning: 2
  info: 4
  total: 6
status: issues_found
---

# Phase 5: Code Review Report

**Reviewed:** 2026-06-18
**Depth:** deep
**Files Reviewed:** 8
**Status:** issues_found

## Summary

Phase 5 hardening (retry wrapper, kill switch, in-thread error reporting,
ops script) is solid. Backoff/jitter math is correct and bounded (no infinite
loop), the retryable set is right (429 / >=500 only, 4xx pass through),
Retry-After is parsed as seconds→ms with NaN/negative guards, the kill switch
is default-off and genuinely fail-open (Redis outage → process, never block),
error reporting never rethrows into ack/waitUntil and never interpolates
secrets/internal error text into user messages, and the ops script validates
args and never logs the token. No BLOCKERs.

Two WARNINGs concern duplicate-task risk from retrying a non-idempotent POST and
an unbounded Retry-After sleep. The rest are low-impact robustness/type notes.

## Warnings

### WR-01: Retrying createTask (non-idempotent POST) can double-create tasks

**File:** `src/clickup/retry.ts:86-92`, `src/clickup/client.ts:103-110`, `src/slack/interactions.ts:118-147`
**Issue:** `createRetryingFetch` retries on 429/5xx and on network rejection. It
wraps every call including `POST /list/{id}/task`, which is not idempotent and
ClickUp v2 has no idempotency-key support. If ClickUp creates the task but the
response is a 5xx (or the connection drops after the server committed), the
wrapper transparently re-POSTs and creates a **duplicate task**. The Phase 3
`claimPending` GETDEL guard only prevents double-*confirm* (two button clicks);
it does not protect against a retry inside a single `createTask` invocation —
the pending is already consumed before the POST runs. This is the highest-risk
item; probability is low but the failure mode is silent duplicate work items.
**Fix:** Either (a) do not route the non-idempotent createTask through the
retrying fetch — give createTask a 429-only retry (rate limit is safe to retry;
5xx/network are not), or (b) gate 5xx/network retries on idempotent methods only:
```ts
const method = (init?.method ?? "GET").toUpperCase();
const idempotent = method === "GET" || method === "PUT" || method === "DELETE";
const retryable = res.status === 429 || (idempotent && res.status >= 500);
// and: only retry network rejections when idempotent
```
At minimum, document the at-least-once semantics so duplicates are an accepted,
known trade-off rather than a surprise.

### WR-02: Unbounded Retry-After can block the worker up to its platform timeout

**File:** `src/clickup/retry.ts:36-38, 91-92`
**Issue:** `retryAfterMs` returns `seconds * 1000` with no upper clamp, and that
value is passed straight to `sleep`. A large (or hostile) `Retry-After` header
(e.g. `3600`) makes the function sleep for an hour inside the Slack
ack/waitUntil window, where it will be killed by the platform timeout — turning
a transient 429 into a dropped interaction. Exponential backoff is bounded by
`maxAttempts`, but Retry-After is not.
**Fix:** Clamp the honored delay, e.g.:
```ts
const RETRY_AFTER_CAP_MS = 30_000;
return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
```

## Info

### IN-01: Retry-After only parses integer seconds; HTTP-date and X-RateLimit-Reset ignored

**File:** `src/clickup/retry.ts:36`
**Issue:** `Number.parseInt(raw, 10)` handles the `delta-seconds` form only. The
HTTP-date form of `Retry-After` and ClickUp's `X-RateLimit-Reset` (epoch seconds)
both fail the parse and silently fall back to exponential backoff. Behavior is
safe (backoff still applies) but the server's explicit hint is discarded.
**Fix:** Optionally also read `X-RateLimit-Reset` and compute `reset - now`; low
priority since backoff is a correct fallback.

### IN-02: Global kill switch is skipped when the message channel is falsy

**File:** `src/slack/process.ts:88-92`
**Issue:** `isKillSwitchActive` is only called when `switchChannel` is truthy, so
a message without a `channel` bypasses even the global `killswitch:all`. In
practice Slack message events always carry a channel and such a message is
non-processable anyway, so impact is nil — but the global override is documented
as "disables EVERY channel," which this edge contradicts.
**Fix:** Check the global key unconditionally, or pass `"all"` when channel is
absent: `await isKillSwitchActive(deps.redis, switchChannel ?? "all")`.

### IN-03: retry.ts reads `res.headers` via unchecked cast that the FetchLike type does not declare

**File:** `src/clickup/retry.ts:31-34`, `src/clickup/types.ts:20-25`, `src/slack/app.ts:104-106`
**Issue:** The `FetchLike` response type has no `headers` field, yet `retryAfterMs`
casts the response to reach `.headers.get(...)`. This works only because prod
injects native `globalThis.fetch` (cast with `as unknown`), whose `Response` does
expose `headers`. If a future injected adapter normalizes responses to the
declared `FetchLike` shape, Retry-After honoring silently dies (always `null`)
with no compile-time signal.
**Fix:** Add the optional surface to the `FetchLike` response type:
`headers?: { get(name: string): string | null }`, and drop the `as` cast.

### IN-04: killswitch.mjs does not validate the channelId shape

**File:** `scripts/killswitch.mjs:40-65`
**Issue:** `channelId` is used verbatim in the Redis key. It is `encodeURIComponent`-d
into the path so there is no injection (path-safe), but a typo'd or empty-ish id
silently sets a key that no channel will ever match, giving a false sense the bot
is disabled. No security issue; the token is never logged and Upstash REST usage
(path-style `SET/key/1`, `DEL/key`, `Authorization: Bearer`) is correct.
**Fix:** Optionally validate against the Slack channel id pattern (e.g. `/^C[A-Z0-9]+$/`
or the literal `all`) and warn on mismatch.

---

_Reviewed: 2026-06-18_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
