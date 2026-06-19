---
phase: 03-confirm-create
plan: 01
subsystem: clickup
tags: [clickup, rest-client, env, create-task]
requires: [config/clients.ts, config/env.ts]
provides:
  - src/clickup/client.ts (createClickUpClient.createTask)
  - src/clickup/types.ts (CreateTaskParams, ClickUpTaskResult, FetchLike, LINK_LOOM_FIELD_ID)
  - env: CLICKUP_API_TOKEN, CLICKUP_LIST_ID
affects: [src/slack/app.ts (Phase 3-03 wires the client)]
tech-stack:
  added: []
  patterns: [dependency-injection (FetchLike), config-as-code field ids]
key-files:
  created: [src/clickup/types.ts, src/clickup/client.ts, src/clickup/client.test.ts]
  modified: [src/config/env.ts, src/config/env.test.ts, src/slack/events.integration.test.ts, .env.example]
decisions:
  - "custom_fields set inline on create (no separate /task/{id}/field call) — verified supported"
  - "Authorization uses the raw token (ClickUp personal/OAuth tokens are NOT Bearer-prefixed)"
  - "dates sent as epoch-ms with *_date_time=false for day-granularity"
metrics:
  duration: ~10m
  completed: 2026-06-18
requirements: [CREATE-01, CREATE-02]
---

# Phase 3 Plan 01: ClickUp env + injectable REST client Summary

Injectable ClickUp REST v2 client (`createTask`) that POSTs to the Task-Seo Team
list with epoch-ms dates, numeric assignee ids, and the Cliente/Link-Loom custom
fields set inline by UUID — plus the `CLICKUP_API_TOKEN`/`CLICKUP_LIST_ID` env
contract. Fully offline-tested with a mocked fetch.

## What was built

- **src/config/env.ts** — added `CLICKUP_API_TOKEN` (required nonEmpty) and
  `CLICKUP_LIST_ID` (default `901327239630`). Other keys unchanged.
- **src/clickup/types.ts** — `FetchLike`, `CreateTaskParams`, `ClickUpTaskResult`,
  `LINK_LOOM_FIELD_ID` constant.
- **src/clickup/client.ts** — `createClickUpClient({token, listId, fetch})` →
  `createTask`. Conditional body construction (omits null fields), inline
  `custom_fields`, raw-token Authorization header, status+body errors that never
  leak the token, `{id,url}` return.

## Tests

- `src/config/env.test.ts` — 11 tests (added required-token throw + list-id default).
- `src/clickup/client.test.ts` — 8 tests (url/auth, epoch-ms dates, assignees,
  custom_fields present/absent, return, error without token leak).

All pass; `npm run typecheck` clean. No new dependencies.

## Deviations from Plan

Also updated `src/slack/events.integration.test.ts` (typed `Env` fixture needed
the two new keys to keep compiling) and `.env.example` (documented the new vars).
Tracked as `[Rule 3 - Blocking]` — the typed fixture would not compile otherwise.

## Self-Check: PASSED

- src/clickup/client.ts, src/clickup/types.ts, src/clickup/client.test.ts exist.
- Commits 800f390 (env), e431d6c (client) present.
