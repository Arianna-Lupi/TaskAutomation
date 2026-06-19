---
phase: 05-hardening
plan: 01
subsystem: resilience
tags: [retry, backoff, error-reporting, clickup, slack]
requires: [src/clickup/types.ts, src/clickup/client.ts, src/slack/process.ts, src/slack/interactions.ts]
provides: [createRetryingFetch, ClickUpRetryError, reportErrorToThread, createFailureMessage, PARSE_ERROR_MESSAGE, GENERIC_ERROR_MESSAGE]
affects: [src/clickup/client.ts, src/slack/app.ts, src/slack/process.ts, src/slack/interactions.ts]
tech-stack:
  added: []
  patterns: [injectable-sleep-backoff, best-effort-thread-notice, typed-exhaustion-error]
key-files:
  created: [src/clickup/retry.ts, src/clickup/retry.test.ts, src/slack/report.ts, src/slack/report.test.ts]
  modified: [src/clickup/client.ts, src/clickup/client.test.ts, src/slack/app.ts, src/slack/process.ts, src/slack/process.test.ts, src/slack/interactions.ts, src/slack/interactions.test.ts]
decisions:
  - "Retry wrapping lives INSIDE createClickUpClient (not app.ts) so it is unit-testable at the client level with an injected sleep/random"
  - "Spanish error constants are verbatim per CONTEXT > HARD-01; createFailureMessage interpolates the ClickUp status from ClickUpRetryError.status"
  - "Error reporting is strictly best-effort — reportErrorToThread swallows postMessage rejections so it never throws into the ACK/waitUntil boundary"
metrics:
  completed: 2026-06-18
requirements: [HARD-01, HARD-02]
---

# Phase 5 Plan 01: Resilience Guards (retry + in-thread error reporting) Summary

ClickUp 429/5xx retry with injectable-sleep backoff (`createRetryingFetch` + typed `ClickUpRetryError`) plus best-effort in-thread Spanish error reporting (`reportErrorToThread`) wired into the parse, generic, and create-failure paths.

## What Was Built

- **`src/clickup/retry.ts`** — `createRetryingFetch(fetch, { sleep, maxAttempts=3, baseDelayMs=1000, random })` wraps a `FetchLike`: status 429 or ≥500 is retryable, honoring `Retry-After` (seconds→ms) when present else `base*2^n + random()*base` jitter; exhaustion throws `ClickUpRetryError` carrying the final status; network rejects retry to the cap then rethrow. Sleep/random injected for deterministic, instant tests.
- **`src/clickup/client.ts`** — `createClickUpClient` now routes every `createTask`/`getTask` call through `createRetryingFetch` internally (HARD-02 wiring). Accepts an optional `retry?: Partial<RetryingFetchOpts>`; defaults to a real `setTimeout` sleep in prod. Exhaustion propagates `ClickUpRetryError` to `handleConfirm`.
- **`src/slack/report.ts`** — `reportErrorToThread` (best-effort, structurally typed for both Slack client shapes) + `PARSE_ERROR_MESSAGE`, `GENERIC_ERROR_MESSAGE`, `createFailureMessage(status)`.
- **Wiring** — `process.ts` posts `PARSE_ERROR_MESSAGE` on a parse failure (dedup key kept) and `GENERIC_ERROR_MESSAGE` in the outer catch; `interactions.ts` posts `createFailureMessage(status)` on create failure (pending restored for retry); `app.ts` passes raw `globalThis.fetch` (the client owns retry).

## Deviations from Plan

**1. [Rule 3 - Blocking] Retry wrapping moved from app.ts into the ClickUp client.**
- **Found during:** HARD-02 wiring review — the plan's Task 3 wrapped fetch in `app.ts`, but that left `createRetryingFetch` untested at the client boundary and not exercised by `client.test.ts`.
- **Fix:** `createClickUpClient` wraps its injected fetch internally with an injectable `retry` config; `app.ts` no longer double-wraps. This makes the 429/5xx behavior deterministically testable through the public client API.
- **Files modified:** src/clickup/client.ts, src/clickup/client.test.ts, src/slack/app.ts
- **Commits:** ef1a2b9 (retry core), 5298c74 (client wiring)

## Tests

- `retry.test.ts` — 429→Retry-After, exp backoff+jitter, 5xx + network retry, 400 not retried, exhaustion throws typed error.
- `client.test.ts` — +10 retry tests (429→200, 5xx→200, 429×max→ClickUpRetryError, Retry-After via injected sleep, getTask retry, 400 not retried); original 8 still green.
- `report.test.ts`, `process.test.ts`, `interactions.test.ts` — Spanish messages posted, never throws.

Final suite at plan close: **227 passing / 1 skipped**, `tsc --noEmit` clean.

## Deferred / Live Items

- Live 429/5xx backoff timing against the real ClickUp API is human-deferred (offline tests use injected sleep with zero real time).

## Self-Check: PASSED
- Files exist: src/clickup/retry.ts, src/slack/report.ts, src/clickup/client.ts (verified on disk).
- Commits exist: ef1a2b9, 151ee09, 9e43bda, 5298c74 (in git log).
