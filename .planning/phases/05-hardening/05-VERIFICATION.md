---
phase: 05-hardening
verified: 2026-06-18T21:30:00Z
status: human_needed
score: 3/3 success criteria verified (offline)
overrides_applied: 0
human_verification:
  - test: "Trigger a real ClickUp 429 (or 5xx) against the live API via a confirm, and observe the bot retries with Retry-After/backoff then succeeds, and that exhaustion surfaces the Spanish create-failure notice with the status."
    expected: "Bot waits per Retry-After/backoff, retries up to 3 attempts, succeeds when ClickUp recovers; on persistent 429 posts '⚠️ No pude crear la tarea en ClickUp (429). Intenta de nuevo.' in-thread and keeps the pending recoverable."
    why_human: "Real rate-limit timing and Retry-After header behavior cannot be exercised offline; tests use an injected sleep with zero real time."
  - test: "On the deployed bot, run `node scripts/killswitch.mjs <liveChannelId> on` against the production Upstash instance, then post a message in that Slack channel; then run `... off` and post again."
    expected: "With the switch ON the bot does nothing (no preview, no parse). With it OFF the bot resumes posting previews — all without a redeploy."
    why_human: "Requires the live Upstash instance + deployed bot + a real Slack channel; offline tests cover the guard logic with an in-memory RedisLike only."
---

# Phase 5: Hardening Verification Report

**Phase Goal:** Production resilience — surface parse/create failures in-thread (no silent failure), retry ClickUp 429 with backoff, ignore webhook redeliveries, and a per-channel kill switch with no redeploy.
**Verified:** 2026-06-18T21:30:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (Roadmap Success Criteria)

| # | Truth | Status | Evidence |
| - | ----- | ------ | -------- |
| 1 | A parse or creation error posts a clear message in the thread (no silent failure) | ✓ VERIFIED | `process.ts:133` posts `PARSE_ERROR_MESSAGE` on parse-catch (dedup key kept); `process.ts:181` posts `GENERIC_ERROR_MESSAGE` in outer catch; `interactions.ts:140-145` posts `createFailureMessage(status)` on createTask failure with pending restored. All via best-effort `reportErrorToThread` (`report.ts:48-66`, try/catch/log/never-rethrow). Spanish constants verbatim. Tests assert each (`process.test.ts:188,204`; `interactions.test.ts:170-186`). |
| 2 | ClickUp 429 responses retried with backoff AND duplicate webhook redeliveries ignored | ✓ VERIFIED | `createRetryingFetch` (`retry.ts:58-98`): 429/≥500 retryable, honors `Retry-After` sec→ms, else `base*2^n + jitter`, cap 3 attempts, throws typed `ClickUpRetryError(status)` on exhaustion; non-429 4xx pass through. Wired into every createTask/getTask via `client.ts:66`. Redelivery dedup: Slack `markEventOnce` (`process.ts:94`) + ClickUp `markWebhookDeliveryOnce` (`webhook.ts:275`). Tests: `retry.test.ts` (Retry-After=2000ms, backoff [1000,2000], 503 retried, 400 not, exhaustion typed error); `process.test.ts:292` (one preview on redelivery); `webhook.test.ts:223` (posts once across redelivery). |
| 3 | Flipping the kill switch for the channel stops the bot without redeploy | ✓ VERIFIED | `isKillSwitchActive` (`redis.ts:142-159`) checks `killswitch:<channelId>` then `killswitch:all`, fail-open on Redis error (returns false + logs), default off; checked at top of `processMessageEvent` BEFORE `markEventOnce` (`process.ts:88-92`). `setKillSwitch` SET (no NX/TTL) / DEL. `scripts/killswitch.mjs` flips via Upstash REST (validates argv, supports `all`). README "Kill switch (per-channel, no redeploy)" section documents script + raw curl. Tests: `redis.test.ts` (+9), `process.test.ts:241,254,278` (per-channel/global no-op, fail-open still processes). |

**Score:** 3/3 success criteria verified offline.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `src/clickup/retry.ts` | createRetryingFetch + ClickUpRetryError | ✓ VERIFIED | 98 lines; both exports present, substantive, imported by client.ts |
| `src/slack/report.ts` | reportErrorToThread + 3 Spanish constants + createFailureMessage | ✓ VERIFIED | Verbatim constants; best-effort helper; imported by process.ts + interactions.ts |
| `src/clickup/client.ts` | Routes createTask/getTask through createRetryingFetch | ✓ VERIFIED | `client.ts:66` wraps injected fetch; both methods use wrapped fetch |
| `src/slack/process.ts` | Kill-switch guard + parse/generic in-thread reporting | ✓ VERIFIED | Guard `process.ts:88`; PARSE+GENERIC reporting wired |
| `src/slack/interactions.ts` | Create-failure in-thread reporting in handleConfirm | ✓ VERIFIED | `interactions.ts:139-146`, status from ClickUpRetryError, pending restored |
| `src/store/redis.ts` | isKillSwitchActive/setKillSwitch (fail-open) + dedup helpers | ✓ VERIFIED | Both exports; fail-open try/catch; markEventOnce/markWebhookDeliveryOnce intact |
| `scripts/killswitch.mjs` | Ops CLI flip on\|off, supports all | ✓ VERIFIED | Validates argv, Upstash REST, usage on bad args |
| `README.md` | Kill-switch ops docs | ✓ VERIFIED | Section at line 74 with script + raw command |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| client.ts | retry.ts | createRetryingFetch wraps injected fetch | ✓ WIRED | `client.ts:2,66` — every createTask/getTask routed through wrapper |
| app.ts | retry (via client) | client owns retry; app passes raw globalThis.fetch | ✓ WIRED (intentional deviation) | Plan 05-01 key_link said wrap in app.ts; SUMMARY documents move into client.ts for client-boundary testability. Phase instructions explicitly require "ClickUp client routes createTask/getTask through createRetryingFetch" — intent achieved, better tested. |
| interactions.ts | report.ts | createTask catch posts createFailureMessage | ✓ WIRED | `interactions.ts:22,140` |
| process.ts | redis.ts | isKillSwitchActive before markEventOnce | ✓ WIRED | `process.ts:6,89` |
| process.ts | report.ts | parse/generic catch posts Spanish message | ✓ WIRED | `process.ts:13-16,133,181` |
| webhook.ts | redis.ts | markWebhookDeliveryOnce dedup | ✓ WIRED | `webhook.ts:4,275` |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Full test suite | `npm test` | 227 passed / 1 skipped (22 files passed, 1 skipped) | ✓ PASS |
| Typecheck | `npx tsc --noEmit` | exit 0, no errors | ✓ PASS |
| Script syntax + usage | `node scripts/killswitch.mjs` | prints usage, exits non-zero | ✓ PASS |

The 1 skipped test is `src/llm/parse.live.test.ts` (live OpenAI) — expected per instructions. The stderr `ReceiverAuthenticityError` lines are deliberate negative-path assertions in passing tests, not failures.

### Requirements Coverage

| Requirement | Source Plan | Status | Evidence |
| ----------- | ----------- | ------ | -------- |
| HARD-01 (no silent failure) | 05-01 | ✓ SATISFIED | reportErrorToThread wired into parse/generic/create paths, Spanish verbatim, best-effort |
| HARD-02 (rate limits + redelivery) | 05-01, 05-02 | ✓ SATISFIED | createRetryingFetch in client + Slack/ClickUp dedup confirmed by tests |
| HARD-03 (kill switch, no redeploy) | 05-02 | ✓ SATISFIED | isKillSwitchActive guard + script + README; fail-open; default off |

### Anti-Patterns Found

None. No unreferenced TBD/FIXME/XXX debt markers in the modified files. Error-reporting "swallows" are intentional best-effort by design (never throw into ACK/waitUntil boundary), documented and tested. No hardcoded-empty data feeding user output.

### Human Verification Required

1. **Live ClickUp 429 retry timing** — offline tests prove the logic with an injected zero-time sleep; real Retry-After/backoff timing against the live API is inherently live-only. See frontmatter.
2. **Live kill-switch flip on production** — flipping `killswitch:<channel>` via the script on the live Upstash instance and confirming the deployed bot halts/resumes with no redeploy. See frontmatter.

### Gaps Summary

No code-level gaps. All three roadmap success criteria are achieved and proven by passing offline tests (227/1-skip), with a clean typecheck. The only outstanding items are two live confirmations (real 429 timing, production kill-switch flip) that cannot be exercised offline — these are inherent to a final hardening phase and were explicitly designated human/deferred in the phase instructions. One documented, intentional deviation (retry wrapping lives in client.ts rather than app.ts) satisfies the goal and improves test coverage.

---

_Verified: 2026-06-18T21:30:00Z_
_Verifier: Claude (gsd-verifier)_
