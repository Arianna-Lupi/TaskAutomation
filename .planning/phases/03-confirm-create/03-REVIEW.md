---
phase: 03-confirm-create
reviewed: 2026-06-18T00:00:00Z
depth: deep
files_reviewed: 10
files_reviewed_list:
  - src/clickup/client.ts
  - src/clickup/types.ts
  - src/slack/blocks.ts
  - src/slack/process.ts
  - src/slack/interactions.ts
  - src/slack/modal.ts
  - src/slack/app.ts
  - src/store/redis.ts
  - api/slack/interactions.ts
  - src/config/env.ts
findings:
  critical: 1
  warning: 5
  info: 2
  total: 8
status: issues_found
---

# Phase 3: Code Review Report

**Reviewed:** 2026-06-18
**Depth:** deep
**Files Reviewed:** 10
**Status:** issues_found

## Summary

Flow A (preview → confirm/edit/cancel → create) is well-structured: ack-first
handlers, GETDEL-based claim, injected deps, no token logging, dropdown/member
values sourced from fixed config (not free text), and dates emitted as epoch-ms.
The signature-verification and 3s-ack concerns from the focus list are correctly
handled by the `@vercel/slack-bolt` adapter.

However, the central idempotency guarantee ("exactly one ClickUp task") is
**broken once any post-create side effect fails**: the confirm handler re-arms
the pending on *any* exception inside its try block, including failures that
occur *after* the task was already created — enabling a duplicate task on the
next click. That is a BLOCKER. Several UX/robustness gaps (silent no-ops on
expired pending, empty-title edits, unvalidated private_metadata) follow.

## Critical Issues

### CR-01: Confirm re-arms pending after a *successful* create → duplicate ClickUp task

**File:** `src/slack/interactions.ts:80-115`
**Issue:** `handleConfirm` claims the pending (GETDEL), then inside one `try`
runs `createTask` **and** `mapTaskToThread` **and** `chat.update` **and**
`chat.postMessage`. The `catch` re-puts the pending on *any* failure. If
`createTask` succeeds but a later step throws (e.g. `mapTaskToThread` or the
`chat.update` that removes the buttons), the pending is restored while the
buttons are still visible. A second click re-claims the pending and calls
`createTask` again → **two ClickUp tasks for one message**. The claim-before-
create ordering only guarantees exactly-once when the *create itself* is the
failing step; it does not protect the post-create tail. The created
`result.id`/`result.url` are also lost on that path.
**Fix:** Scope the re-arm to the create call only; never re-create once a task
exists. e.g.
```ts
const pending = await claimPending(deps.redis, ref.pendingId);
if (!pending) return;

let result: ClickUpTaskResult;
try {
  result = await deps.clickup.createTask({ /* ... */ });
} catch (err) {
  console.error("[slack] createTask failed (pending restored):", err);
  await putPending(deps.redis, ref.pendingId, pending); // safe: nothing created
  return;
}
// Task now exists — best-effort finalize; do NOT re-arm pending on these.
try {
  await mapTaskToThread(deps.redis, result.id, {
    channel: pending.channel, thread_ts: pending.threadTs,
  });
  await deps.slack.chat.update({ /* confirmed */ });
  await deps.slack.chat.postMessage({ /* link */ });
} catch (err) {
  console.error("[slack] post-create finalize failed (task already created):", err);
}
```

## Warnings

### WR-01: Expired/missing pending on Confirm is a silent no-op (no user feedback)

**File:** `src/slack/interactions.ts:76-77`
**Issue:** When the pending has expired (1h TTL) or was already claimed,
`handleConfirm` returns silently. The preview message still shows the buttons,
so the user clicks Confirmar and nothing happens — no error, no thread reply.
The focus list explicitly calls for a user-facing message here.
**Fix:** On `!pending`, update the message (or post in-thread) with a "este
preview expiró — reenviá el mensaje" notice and strip the buttons.

### WR-02: Expired pending on Edit open/submit also silently no-ops

**File:** `src/slack/interactions.ts:144-145, 170-171`
**Issue:** `handleEditOpen` and `handleEditSubmit` both `return` on missing
pending with no feedback. On open, the user clicks Editar and no modal appears;
on submit, the modal closes and the preview is unchanged. Confusing.
**Fix:** Post a brief in-thread "el preview expiró" notice, or open a modal
showing the expiry message instead of silently dropping.

### WR-03: Edit submit accepts whitespace-only / empty title

**File:** `src/slack/modal.ts:199, 207`
**Issue:** `titleRaw.trim()` is written straight into `patch.title` with no
guard. A required `plain_text_input` only blocks an empty string, not
whitespace-only input, so the merged `ResolvedTask` can carry `title: ""`, which
then flows into `createTask({ name: "" })`. ClickUp will reject (or create a
blank-named task) at confirm time with only a generic logged error.
**Fix:** Validate in `parseEditSubmission`/`handleEditSubmit`; if the trimmed
title is empty, return a Slack `response_action: "errors"` keyed on
`TITLE_BLOCK` so the modal shows the validation inline instead of saving.

### WR-04: `private_metadata` is JSON.parsed and cast without validation

**File:** `src/slack/modal.ts:197`
**Issue:** `JSON.parse(view.private_metadata ?? "{}") as EditModalMeta` trusts
the round-tripped string blindly. A malformed value throws inside the
post-ack `waitUntil` (unhandled rejection); an empty `{}` yields
`channel`/`messageTs` = `undefined`, so the later `chat.update` fails silently
and the edit is lost with no user feedback.
**Fix:** Wrap in try/catch and validate the parsed shape (e.g. a small zod
schema requiring `pendingId`, `channel`, `messageTs` as non-empty strings);
bail with a logged error + in-thread notice if invalid.

### WR-05: Redis round-trip inside the 3s trigger_id window on Edit open

**File:** `src/slack/interactions.ts:144-155`
**Issue:** After `ack()`, `handleEditOpen` does an Upstash REST `getPending`
call *before* `views.open`. Slack's `trigger_id` is valid for only ~3s from the
click. A slow Redis round trip (cold start / network) can push `views.open`
past the window → `expired_trigger_id` and no modal, with no fallback.
**Fix:** Acceptable for v1 but worth hardening — open the modal with a loading
view immediately after ack and `views.update` once the pending loads, or at
least catch the `views.open` failure and post an in-thread "no se pudo abrir el
editor, reintentá" notice.

## Info

### IN-01: Duplicate handler construction in the route module

**File:** `api/slack/interactions.ts:10-11`
**Issue:** `createSlackApp` already builds and returns a `handler` via
`createHandler`, but this module discards it (destructures only `app`,
`receiver`) and calls `createHandler(app, receiver)` again. Harmless but
wasteful and confusing about which handler is authoritative.
**Fix:** Return and reuse the handler from `createSlackApp`, or stop returning
it there to make the single construction site explicit.

### IN-02: Event dedup TTL (10 min) may be shorter than Slack's retry horizon

**File:** `src/store/redis.ts:59`
**Issue:** `DEFAULT_EVENT_TTL_SECONDS = 600`. Slack can retry an event delivery
over a window longer than 10 minutes; a late retry after key expiry would be
re-processed. The deterministic re-parse guard limits blast radius (no double
preview unless the prior attempt also failed), but the comment's "covers Slack's
retry window" is optimistic.
**Fix:** Bump toward Slack's documented retry horizon (or document the chosen
trade-off explicitly).

---

_Reviewed: 2026-06-18_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
