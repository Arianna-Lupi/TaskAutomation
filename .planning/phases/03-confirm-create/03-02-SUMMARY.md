---
phase: 03-confirm-create
plan: 02
subsystem: store + slack-ui
tags: [redis, idempotency, block-kit, preview, spanish]
requires: [resolve/types.ts, config/clients.ts, config/members.ts, luxon]
provides:
  - src/store/redis.ts (putPending/getPending/claimPending/deletePending/mapTaskToThread/getThreadForTask)
  - src/slack/blocks.ts (buildPreviewBlocks/buildConfirmedBlocks/buildCanceledBlocks + action_id constants)
affects: [src/slack/process.ts, src/slack/interactions.ts, src/slack/modal.ts]
tech-stack:
  added: []
  patterns: [GETDEL atomic claim for idempotency, inverted config maps for display]
key-files:
  created: [src/slack/blocks.ts, src/slack/blocks.test.ts]
  modified: [src/store/redis.ts, src/store/redis.test.ts, src/slack/process.test.ts]
decisions:
  - "claimPending uses Redis GETDEL so double-confirm returns the pending exactly once then null"
  - "preview display values derived from inverted CLIENTS/MEMBERS maps, never raw LLM text"
  - "blocks typed loosely as Record<string,unknown>[] to avoid Slack type churn"
metrics:
  duration: ~12m
  completed: 2026-06-18
requirements: [CONFIRM-01, CONFIRM-03, CREATE-04]
---

# Phase 3 Plan 02: Pending store + Spanish preview builder Summary

Two offline foundations for the confirm flow: Redis helpers (pending store with a
GETDEL exactly-once claim + task↔thread map) and the Spanish Block Kit preview
builder that renders resolved values and ⚠️-flags anything the resolver left null.

## What was built

- **src/store/redis.ts** — broadened `RedisLike` with `get`/`getdel` and relaxed
  `set` opts to `{nx?,ex?}`. Added `PendingTask`/`TaskThreadRef` types, TTL
  constants, and `putPending`/`getPending`/`claimPending`/`deletePending`/
  `mapTaskToThread`/`getThreadForTask`. `coerceJson` tolerates both string and
  already-parsed values (@upstash/redis auto-deserializes).
- **src/slack/blocks.ts** — `buildPreviewBlocks` (summary + 3 buttons),
  `buildConfirmedBlocks`, `buildCanceledBlocks`; inverted CLIENTS/MEMBERS lookups;
  luxon Spanish date formatting; exported `confirm_task`/`edit_task`/`cancel_task`.

## Tests

- `src/store/redis.test.ts` — 19 tests (added in-memory `memRedis` fake; round
  trips; **claimPending exactly-once**; deletePending; task2thread; TTL/JSON shape).
- `src/slack/blocks.test.ts` — 5 tests (resolved names + dates with no ⚠️; null
  fields flagged; 3 buttons with correct ids/styles/value; terminal blocks
  button-free).

All pass; `npm run typecheck` clean. No new dependencies.

## Deviations from Plan

Added `get`/`getdel` stubs to the existing `process.test.ts` fake redis so it
still satisfies the broadened `RedisLike` (`[Rule 3 - Blocking]`; process.ts
itself is rewritten in plan 03-03).

## Self-Check: PASSED

- src/slack/blocks.ts and helpers exist; commits b735638, d30d74e present.
