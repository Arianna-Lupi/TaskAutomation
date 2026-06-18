---
phase: 01-serverless-foundation
plan: 02
subsystem: config + store
tags: [zod, env-validation, upstash-redis, idempotency, tdd]
requires: ["01-01 scaffold"]
provides: ["loadEnv fail-fast typed env", "createRedis Upstash factory", "markEventOnce dedup helper (SET NX EX)"]
affects: ["01-03 Slack ingress consumes both", "later phases reuse env + Redis"]
tech-stack:
  added: []
  patterns: ["dependency-injected RedisLike for offline unit tests", "no process.env read at module top level (injectable source)"]
key-files:
  created: ["src/config/env.ts", "src/config/env.test.ts", "src/store/redis.ts", "src/store/redis.test.ts"]
  modified: []
decisions: ["TEAM_TIMEZONE is the only var with a default (America/Caracas)", "dedup key namespace evt:<eventId>", "default TTL 600s (10 min) covering Slack retry window"]
metrics:
  duration: "~8 min"
  completed: "2026-06-18"
  tests: "13 (6 env + 7 redis)"
---

# Phase 1 Plan 02: Env Validation + Redis Dedup Summary

Two stateless-serverless primitives, built TDD (RED→GREEN): zod fail-fast env validation, and an Upstash Redis dedup helper keyed on Slack `event_id` via `SET ... NX EX` — the real guard against Slack's retry-on-slow-ACK duplicate processing (Pitfall 1).

## What was built

- **src/config/env.ts** — `EnvSchema` (zod): `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_TASK_CHANNEL_ID` non-empty; `UPSTASH_REDIS_REST_URL` url-validated; `UPSTASH_REDIS_REST_TOKEN` non-empty; `TEAM_TIMEZONE` defaults to `America/Caracas`. `loadEnv(source = process.env)` returns a typed `Env` or throws an Error naming every offending key. Empty strings treated as missing (`.trim().min(1)`). No `process.env` read at import — source is injectable.
- **src/store/redis.ts** — `createRedis(env?)` lazily builds an `@upstash/redis` REST client; throws naming missing `UPSTASH_REDIS_REST_URL`/`TOKEN`. `markEventOnce(redis, eventId, ttl = 600)` calls `set(`evt:${eventId}`, 1, { nx: true, ex: ttl })` → `true` first time, `false` on retry. `RedisLike` is dependency-injected so the helper is unit-testable without live Upstash.

## Verification

- `npx vitest run src/config/env.test.ts src/store/redis.test.ts` → **13/13 green**.
- RED confirmed for both tasks before implementation (module-not-found / no tests), GREEN after.
- markEventOnce demonstrably returns `true` then `false` for the same `event_id` (idempotency test with a fake NX store).

## TDD Gate Compliance

Both tasks followed RED→GREEN with separate `test(...)` then `feat(...)` commits:
- env: `test` → `feat` (6793311 chain)
- redis: `test` → `feat` (94c859c)

## Deviations from Plan

None during this plan. (Note: `RedisLike.set` return type was later widened from `Promise<string|null>` to `Promise<unknown>` in plan 03 for strict-mode structural compatibility with the real `@upstash/redis` client — documented there.)

## Self-Check: PASSED

All 4 files exist; commits present in git log.
