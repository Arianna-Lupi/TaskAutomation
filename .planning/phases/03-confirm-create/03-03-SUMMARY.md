---
phase: 03-confirm-create
plan: 03
subsystem: slack-flow
tags: [flow-a, confirm, create, interactions, bolt, idempotency]
requires: [03-01, 03-02, parseAndResolve, app.ts]
provides:
  - src/slack/process.ts (parse->resolve->putPending->preview)
  - src/slack/interactions.ts (handleConfirm/handleCancel)
  - api/slack/interactions.ts (Vercel endpoint)
  - src/slack/app.ts (confirm_task/cancel_task actions wired)
affects: [src/slack/modal.ts (Phase 3-04 extends interactions + app)]
tech-stack:
  added: []
  patterns: [ack-first then waitUntil, GETDEL idempotent confirm, lazy per-warm clients]
key-files:
  created: [src/slack/interactions.ts, src/slack/interactions.test.ts, api/slack/interactions.ts]
  modified: [src/slack/filter.ts, src/slack/process.ts, src/slack/process.test.ts, src/slack/app.ts]
decisions:
  - "parse/resolve failure leaves the dedup key set (no re-parse spend); side-effect failures clear it"
  - "confirm/cancel share /api/slack/events app routing via a second endpoint pointing at the same Bolt app"
  - "RECEIPT_TEXT repurposed as the postMessage fallback text accompanying preview blocks"
metrics:
  duration: ~18m
  completed: 2026-06-18
requirements: [CONFIRM-01, CONFIRM-02, CONFIRM-03, CONFIRM-05, CREATE-01, CREATE-02, CREATE-03, CREATE-04]
---

# Phase 3 Plan 03: Flow A core (parse→preview→confirm→create) Summary

The shippable vertical slice: a Spanish message becomes a threaded Block Kit
preview, and Confirmar creates exactly one ClickUp task (idempotent on
double-click), posts its link back, and stores the task↔thread map; Cancelar
discards and disables the buttons. Fully offline-tested.

## What was built

- **src/slack/filter.ts** — `IncomingMessage` gains optional `text`.
- **src/slack/process.ts** — rewritten pipeline: dedup → filter →
  `parseAndResolve(text, now)` → `putPending` → `chat.postMessage` with
  `buildPreviewBlocks`. Parse-failure keeps the dedup key; side-effect failures
  release it. ProcessDeps extended with `parseDeps`, `genPendingId`, `now`,
  `env.TEAM_TIMEZONE`. `SlackClientLike.postMessage` accepts `blocks`.
- **src/slack/interactions.ts** — `handleConfirm` (claimPending guard →
  createTask → mapTaskToThread → chat.update confirmed → postMessage link;
  restore pending on create failure) and `handleCancel`.
- **src/slack/app.ts** — lazy ClickUp client + OpenAI parse deps; `app.action`
  for `confirm_task`/`cancel_task` (ack-first); `genPendingId = crypto.randomUUID`.
- **api/slack/interactions.ts** — Vercel POST endpoint over the same Bolt app.

## Tests

- `src/slack/process.test.ts` — 8 tests (preview replaces placeholder; dedup;
  filter; empty text; **parse-fail keeps dedup key**; transient-fail clears key;
  no throw into ack).
- `src/slack/interactions.test.ts` — 5 tests (create once with epoch-ms dates +
  assignee ids + cliente UUID + first link; task↔thread map + confirmed update +
  in-thread link; **exactly-once double-confirm**; create-fail restores pending;
  cancel deletes + updates).

Full `npx vitest run src/slack` → 31 passed; `npx tsc --noEmit` clean.

## Deviations from Plan

None of substance. `RECEIPT_TEXT` was kept (repurposed as the blocks fallback
text) rather than deleted, per the plan's "you may keep the export" allowance.

## Live / human-deferred

Real Slack interactivity and real ClickUp task creation require a deployed app +
tokens — not exercised here (offline only).

## Self-Check: PASSED

- interactions.ts, api/slack/interactions.ts exist; commits ee886aa, 9d2d72c,
  1acb512 present.
