---
phase: 05-hardening
plan: 02
subsystem: ops-safety
tags: [kill-switch, redis, dedup, ops, redelivery]
requires: [src/store/redis.ts, src/slack/process.ts]
provides: [isKillSwitchActive, setKillSwitch, KILLSWITCH_GLOBAL_KEY, scripts/killswitch.mjs]
affects: [src/store/redis.ts, src/slack/process.ts, README.md]
tech-stack:
  added: []
  patterns: [fail-open-guard, namespaced-redis-key, dependency-free-ops-cli]
key-files:
  created: [scripts/killswitch.mjs]
  modified: [src/store/redis.ts, src/store/redis.test.ts, src/slack/process.ts, src/slack/process.test.ts, README.md]
decisions:
  - "Kill-switch guard sits at the VERY top of processMessageEvent (before markEventOnce) so an active switch consumes nothing — no dedup key, no parse spend, no preview"
  - "isKillSwitchActive FAILS OPEN: a Redis outage logs and returns false (bot stays enabled) — availability over fail-closed, per CONTEXT > HARD-03"
  - "Ops CLI talks to the Upstash REST API directly via global fetch (no @upstash/redis import) — zero new deps and runs without a build step"
metrics:
  completed: 2026-06-18
requirements: [HARD-03, HARD-02]
---

# Phase 5 Plan 02: Kill Switch + Redelivery Coverage Summary

Per-channel (and global) Redis-backed kill switch checked at the top of the capture path with fail-open semantics, an ops CLI + README to flip it without redeploy, and an explicit Slack-redelivery regression that locks in HARD-02's dedup half.

## What Was Built

- **`src/store/redis.ts`** — `isKillSwitchActive(redis, channelId)` checks `killswitch:<channelId>` then global `killswitch:all`; absent = enabled (default off); FAIL-OPEN on a throwing get (logs, returns false). `setKillSwitch(redis, channelId, on)` SETs (no NX/TTL) or DELs the key. Distinct `killswitch:` namespace.
- **`src/slack/process.ts`** — guard at the very top of `processMessageEvent` (before `markEventOnce`): an active switch logs and returns immediately, consuming nothing. Missing channel falls through; inactive path unchanged.
- **`scripts/killswitch.mjs <channelId> on|off`** — dependency-free Upstash REST CLI (`SET`/`DEL killswitch:<id>`), supports `all` for the global switch, validates argv and prints usage on bad input.
- **`README.md`** — "Kill switch (per-channel, no redeploy)" section: concept (absent = enabled, fail-open), script invocation, and the equivalent raw Upstash `curl` command.

## HARD-02 Redelivery Coverage (confirmed)

- **Slack side (event_id):** new explicit regression in `process.test.ts` — a redelivered `event_id` posts exactly one preview via `markEventOnce` (Phase 1).
- **ClickUp side (delivery key):** `markWebhookDeliveryOnce` redelivery dedup is already proven in `webhook.test.ts` (Phase 4) — confirmed as existing coverage; no gap, no duplicate work added.

## Deviations from Plan

None — plan executed as written. (The `killswitch.mjs` script uses the Upstash REST API directly via global `fetch` rather than importing `@upstash/redis`; the plan explicitly permitted either, and the REST approach keeps the script build-free and dependency-free.)

## Tests

- `redis.test.ts` — +9 kill-switch tests (per-channel active, global active, default off, fail-open on throwing get, namespace isolation, set/clear round-trip).
- `process.test.ts` — +5 (per-channel no-op, global `killswitch:all`, default processes, fail-open still processes, explicit Slack redelivery → one preview).
- `node --check scripts/killswitch.mjs` passes; bad args print usage.

Final suite at plan close: **227 passing / 1 skipped**, `tsc --noEmit` clean.

## Deferred / Live Items

- Live verification that flipping the switch on the production Upstash instance halts the deployed bot is human-deferred (offline tests cover the logic with an in-memory RedisLike).

## Self-Check: PASSED
- Files exist: scripts/killswitch.mjs, src/store/redis.ts, src/slack/process.ts (verified on disk).
- Commits exist: 00b53b3, ef8bd74, 9364d0e (in git log).
