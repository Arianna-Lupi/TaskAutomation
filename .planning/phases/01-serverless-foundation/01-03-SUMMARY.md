---
phase: 01-serverless-foundation
plan: 03
subsystem: slack-ingress
tags: [slack, bolt, vercel-adapter, signature-verify, waitUntil, dedup, echo-filter, tdd]
requires: ["01-02 loadEnv + markEventOnce", "01-01 scaffold"]
provides: ["isProcessableMessage filter", "processMessageEvent dedup+filter+receipt", "createSlackApp Bolt factory", "api/slack/events.ts endpoint"]
affects: ["Phase 2 parser hooks into the captured-message path", "completes all INGEST requirements"]
tech-stack:
  added: []
  patterns: ["@vercel/slack-bolt VercelReceiver: raw-body HMAC verify + ACK-then-waitUntil", "authorize + deferInitialization for offline-testable Bolt init", "pure predicate filter for echo-loop matrix", "signed-Request integration tests with node:crypto"]
key-files:
  created: ["src/slack/filter.ts", "src/slack/filter.test.ts", "src/slack/process.ts", "src/slack/process.test.ts", "src/slack/app.ts", "api/slack/events.ts", "src/slack/events.integration.test.ts"]
  modified: ["src/store/redis.ts (RedisLike.set return widened to unknown)"]
decisions: ["use authorize() + deferInitialization:true instead of token so the adapter's app.init() is network-free and offline-testable", "receipt text '👀 Recibido — procesando…' (Phase 1 placeholder)", "bot user id resolved lazily + cached per warm instance for the echo filter", "verify the valid-signature path via the url_verification challenge to keep tests offline"]
metrics:
  duration: "~18 min"
  completed: "2026-06-18"
  tests: "18 new (9 filter + 5 process + 4 integration); 31 total across the phase"
---

# Phase 1 Plan 03: Slack Events Ingress Summary

The Walking Skeleton's user-visible slice: a Slack Events endpoint that verifies Slack's HMAC over the raw body, ACKs within 3s and runs work in the background via the adapter's `waitUntil`, deduplicates retries on `event_id`, ignores its own/bot/non-root/other-channel messages, and posts an in-thread receipt on a captured human message. Closes INGEST-01..04.

## What was built

- **src/slack/filter.ts** — `isProcessableMessage(msg, { taskChannelId, botUserId? })`: pure predicate, no I/O. Accepts only root (`thread_ts` absent or `=== ts`), plain (`subtype` undefined), human (`bot_id` absent, `user !== botUserId`) messages in the designated channel. The echo-loop guard (Pitfall 3, INGEST-04).
- **src/slack/process.ts** — `processMessageEvent({ redis, client, env, botUserId }, { eventId, message })`: dedup via `markEventOnce` (return early on retry) → `isProcessableMessage` filter → `client.chat.postMessage` with `thread_ts = message.thread_ts ?? message.ts` and `RECEIPT_TEXT`. All wrapped so a downstream failure logs (without secrets) but never throws into the ACK path.
- **src/slack/app.ts** — `createSlackApp(env)` builds a Bolt `App` on a `VercelReceiver` (signing secret from env). Uses `authorize: () => ({ botToken })` + `deferInitialization: true` so `createHandler`'s `app.init()` is network-free. Registers `app.message` delegating to `processMessageEvent`; bot user id resolved lazily/cached via `client.auth.test()`. Signature verification + ACK-then-`waitUntil` are handled by the adapter — no hand-rolled HMAC (INGEST-01/02).
- **api/slack/events.ts** — thin endpoint: constructs the app once at module scope from `loadEnv()`, exports the adapter handler as both `default` and `POST`.

## Verification (offline)

- `npx vitest run` → **31/31 green** (5 files). New: filter 9, process 5, integration 4.
- `npx tsc --noEmit` → **clean** (strict + noUncheckedIndexedAccess).
- Integration tests build real signed `Request`s with `node:crypto`:
  - valid signature + `url_verification` → **200** and echoes the `challenge`.
  - invalid signature → **rejected (>=400)**.
  - wrong signing secret → **rejected**.
  - timestamp 6 min old → **rejected** (5-min replay window, via Bolt's `verifySlackRequest`).
- process tests prove: one receipt per valid message; duplicate `event_id` → exactly one receipt; filtered/own messages → no `postMessage`; `postMessage` rejection never throws.

## TDD Gate Compliance

Both tasks RED→GREEN with separate `test(...)` then `feat(...)` commits (808915c filter; 1d08a88 ingress).

## Deviations from Plan

**[Rule 3 — Blocking] Bolt init wiring for the Vercel adapter.** The plan assumed a straightforward token-based Bolt App. `createHandler(app, receiver)` always calls `app.init()`, which throws (`AppInitializationError` / `assertNever`) for a plain `{ token }` app and would call `auth.test` (network) under `tokenVerification`. Fixed by constructing the App with `authorize: () => ({ botToken })` + `deferInitialization: true` — network-free, offline-testable init that still authorizes the Web client per event. Discovered via the integration test (challenge returned 500 until fixed). Commit 1d08a88.

**[Rule 3 — Blocking] `RedisLike.set` return type.** Strict `tsc` rejected assigning the real `@upstash/redis` `Redis` (whose `set` returns `Promise<unknown>`) to `RedisLike` (`Promise<string|null>`). Widened `RedisLike.set` to `Promise<unknown>`; `markEventOnce` only distinguishes `null` vs non-null, so behavior is unchanged. Commit 1d08a88.

## Deferred Human-Verification (live deploy — expected-pending, not failures)

No live Slack app / Vercel deploy / Upstash instance exists in this environment; Task 3's checkpoint is deferred per orchestrator authority. Pending live checks:

1. Deploy to Vercel (`vercel deploy --prod`); set Slack Event Subscriptions Request URL to `<deploy-url>/api/slack/events`; confirm the URL-verification handshake turns green; subscribe to `message.channels`.
2. Enable **Fluid Compute** (Vercel → Settings → Functions) — required for `waitUntil`.
3. Set env vars (`SLACK_*`, `UPSTASH_*`, `TEAM_TIMEZONE`) and provision Upstash Redis via the Vercel Marketplace.
4. Post a root human message in `SLACK_TASK_CHANNEL_ID` → expect a single "👀 Recibido — procesando…" in-thread reply within ~3s; confirm no `X-Slack-Retry-Num http_timeout` retries in logs.
5. Confirm filters live: thread replies / other channels get no receipt; the bot does not react to its own receipt (echo loop); duplicate `event_id` short-circuits (single receipt).

## Self-Check: PASSED

All 7 created files + the modified `src/store/redis.ts` exist; commits 808915c and 1d08a88 present.
