---
phase: 03-confirm-create
plan: 04
subsystem: slack-flow
tags: [edit-modal, views, bolt, confirm-04]
requires: [03-02, 03-03, config/clients.ts, config/members.ts]
provides:
  - src/slack/modal.ts (buildEditModal/parseEditSubmission)
  - src/slack/interactions.ts (handleEditOpen/handleEditSubmit)
  - src/slack/app.ts (edit_task action + edit_modal_submit view)
affects: []
tech-stack:
  added: []
  patterns: [private_metadata carries ids across open->submit, config-only option values]
key-files:
  created: [src/slack/modal.ts, src/slack/modal.test.ts]
  modified: [src/slack/interactions.ts, src/slack/interactions.test.ts, src/slack/app.ts]
decisions:
  - "parseEditSubmission takes a {timezone} option for epoch-ms date math"
  - "unresolvedAssignees always cleared to [] on submit (human explicitly chose)"
  - "edit handlers no-op when the pending expired (1h TTL window)"
metrics:
  duration: ~12m
  completed: 2026-06-18
requirements: [CONFIRM-04]
---

# Phase 3 Plan 04: Editar modal Summary

CONFIRM-04: Editar opens a prefilled Slack modal (Título/Descripción inputs,
Cliente static_select, Asignados multi_static_select, Inicio/Entrega date
pickers); submitting corrects the pending in Redis and re-renders the threaded
preview so the human can then Confirm the fixed task.

## What was built

- **src/slack/modal.ts** — `buildEditModal` (prefilled view, `callback_id`
  `edit_modal_submit`, `private_metadata` = {pendingId, channel, messageTs}, 7
  Cliente + 9 Asignados options, date pickers from epoch-ms in TZ) and
  `parseEditSubmission` (→ {meta, patch}: cliente UUID, numeric assignee ids,
  epoch-ms midnight-in-TZ dates, blank desc→null, cleared date→null,
  unresolvedAssignees→[]). Stable block/action id constants exported.
- **src/slack/interactions.ts** — `handleEditOpen` (getPending → views.open) and
  `handleEditSubmit` (parse → merge patch over resolved → putPending →
  chat.update re-rendered preview). Added `views.open` to the slack type.
- **src/slack/app.ts** — `app.action("edit_task")` (ack → open modal with
  body.trigger_id) and `app.view("edit_modal_submit")` (ack → submit handler).

## Tests

- `src/slack/modal.test.ts` — 7 tests (callback_id + private_metadata; 7/9
  option counts; prefill; null-field omission; meta + patch extraction; blank/
  cleared → null).
- `src/slack/interactions.test.ts` — now 9 tests (added: edit open carries ids;
  open no-op on expiry; submit merges patch + re-renders preview; submit no-op on
  expiry).

Full `npm test` → 129 passed, 1 skipped (live OpenAI); `npx tsc --noEmit` clean.

## Deviations from Plan

`parseEditSubmission` takes a second `{timezone}` argument (the plan's interface
sketch showed `parseEditSubmission(view)` but the documented behavior requires the
team TZ for epoch-ms date math). `[Rule 3 - Blocking]` — timezone is required for
correct date conversion; supplied from the injected deps.

## Live / human-deferred

Real modal interaction requires a deployed app + tokens — offline only here.

## Self-Check: PASSED

- src/slack/modal.ts exists; commits 9905c7e, e2b625e, 368a72b present.
