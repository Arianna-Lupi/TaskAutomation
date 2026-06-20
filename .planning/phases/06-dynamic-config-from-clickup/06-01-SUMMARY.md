---
phase: 06-dynamic-config-from-clickup
plan: 01
subsystem: clickup-client + redis-store
tags: [dynamic-config, clickup, redis, cache]
requires: []
provides:
  - "ClickUpClient.getClienteOptions() — live Cliente dropdown options (name + UUID)"
  - "ClickUpClient.getMembers() — live workspace members (id, name, email)"
  - "Redis config-cache helpers: writeConfigCache / readConfigCache / readConfigLastGood / clearConfigCache"
affects: [src/clickup/client.ts, src/clickup/types.ts, src/store/redis.ts]
tech-stack:
  added: []
  patterns: [injected-retry-fetch, shape-guarded-wire-parsing, ttl-plus-lastgood-cache]
key-files:
  created: []
  modified:
    - src/clickup/types.ts
    - src/clickup/client.ts
    - src/clickup/client.test.ts
    - src/store/redis.ts
    - src/store/redis.test.ts
    - src/slack/interactions.test.ts
decisions:
  - "teamId added as an OPTIONAL dep on createClickUpClient so createTask/getTask + existing tests stay green; getMembers throws clearly if absent"
  - "Cache keys: cfg:<name> (600s TTL) + cfg:<name>:lastgood (no TTL); clearConfigCache touches only the TTL key"
metrics:
  duration: "~15m"
  completed: 2026-06-19
---

# Phase 6 Plan 01: Live ClickUp reads + Redis config cache Summary

Added the live-read + resilient-cache foundation for dynamic config: two new ClickUp client methods (`getClienteOptions`, `getMembers`) routed through the existing retry fetch, plus four Redis config-cache helpers implementing the TTL-key + non-expiring last-good pattern that DYN-05 relies on.

## What was built

- **src/clickup/types.ts** — `ClienteOption`, `ClickUpMember`, and loose wire-shape types (`ClickUpFieldsResponse`, `ClickUpMembersResponse`) following the defensive optional-everything pattern.
- **src/clickup/client.ts** — `getClienteOptions()` GETs `/list/{id}/field`, locates `CLIENTE_FIELD_ID`, extracts `type_config.options[]`, shape-guards every option. `getMembers()` GETs `/team/{teamId}/member`, extracts id/name/email (missing email → null). Both reuse the injected retry fetch and the raw `Authorization` header; non-2xx throws status + body, never the token. Added an optional `teamId` dep.
- **src/store/redis.ts** — `writeConfigCache` (TTL key + no-TTL last-good), `readConfigCache`, `readConfigLastGood`, `clearConfigCache` (clears only the TTL key). Exported `CONFIG_CACHE_TTL_SECONDS = 600` and `CONFIG_PREFIX = "cfg:"`.

## Tests

- client.test.ts: +11 tests (extract options, ignore unrelated fields, retry wiring, token-safe errors, malformed-payload errors, member email coercion). 30 pass.
- redis.test.ts: +9 tests (TTL vs no-TTL writes, round-trip, miss→null, last-good survives clear, empty-list no-op). 40 pass.
- Deviation: updated 3 ClickUpClient mocks in interactions.test.ts (additive interface) — Rule 3 blocking fix.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] interactions.test.ts mocks missing new client methods**
- **Found during:** Task 1 typecheck
- **Issue:** Adding `getClienteOptions`/`getMembers` to `ClickUpClient` broke 3 inline mocks in interactions.test.ts (TS2739).
- **Fix:** Added `getClienteOptions: vi.fn(async () => [])` + `getMembers: vi.fn(async () => [])` to the `fakeClickup` helper and the two inline mocks.
- **Commit:** bddf626

## Self-Check: PASSED
- src/clickup/client.ts, src/store/redis.ts modified and present.
- Commits bddf626, 3e86978 exist on phase-06-dynamic-config.
