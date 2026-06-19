---
phase: 03-confirm-create
verified: 2026-06-18T00:00:00Z
status: human_needed
score: 5/5 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Post a free-form Spanish task message in the dedicated Slack channel"
    expected: "Bot replies in-thread with a Block Kit preview showing resolved Cliente/Asignados/Inicio/Entrega and ⚠️ on any unresolved field, with Confirmar/Editar/Cancelar buttons"
    why_human: "Requires a deployed app + live Slack signature/interactivity; cannot exercise Bolt receiver end-to-end offline"
  - test: "Click Confirmar on a live preview (and double-click to test idempotency)"
    expected: "Exactly one task appears in the Task-Seo Team list (901327239630) with title, description, numeric assignees, epoch-ms dates, Cliente option UUID and Link/Loom; message updates to ✅ with the task link; link posted back in thread; second click creates nothing"
    why_human: "Requires real ClickUp API token + live task creation and a second redelivery to observe exactly-once in production"
  - test: "Click Editar, change Cliente/Asignados/Fechas in the modal, submit"
    expected: "Modal opens within ~3s prefilled with 7 Cliente + 9 Asignados options and date pickers; on submit the threaded preview re-renders with corrected values still showing the three buttons"
    why_human: "trigger_id 3s window and views.open/view_submission round-trip need a live Slack client"
  - test: "Click Cancelar"
    expected: "Message updates to ❌ Cancelado with no buttons; the pending is discarded (a later Confirmar is a no-op)"
    why_human: "Live chat.update render + button removal verification"
---

# Phase 3: Confirm + Create (Flow A complete) Verification Report

**Phase Goal:** The complete, shippable Slack → ClickUp slice — bot posts a Block Kit preview of resolved values in the thread, a human Confirms/Edits/Cancels, and on confirm the task is created in the Task-Seo Team list with all fields set and its link posted back.
**Verified:** 2026-06-18
**Status:** human_needed (all offline wiring + logic VERIFIED; live Slack/ClickUp deferred to human UAT)
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Threaded preview shows resolved cliente/asignados/fechas and flags unresolved fields | ✓ VERIFIED | `blocks.ts` `buildPreviewBlocks` renders Título/Descripción/Cliente/Asignados/Inicio/Entrega/Links from inverted CLIENTS/MEMBERS maps; null fields → "⚠️ sin resolver"; unresolvedAssignees → "⚠️ <name>". `blocks.test.ts:49-64` asserts ≥3 "sin resolver" + "⚠️ Vero R." `process.ts` posts these blocks in `threadTs = thread_ts ?? ts`. |
| 2 | Working Confirmar/Editar/Cancelar; Editar opens modal with selects for cliente/asignados/fechas | ✓ VERIFIED | Three buttons with action_ids confirm_task/edit_task/cancel_task carrying pendingId (`blocks.ts:92-115`). `modal.ts` `buildEditModal` builds static_select (7 Cliente), multi_static_select (9 Asignados), datepickers; `modal.test.ts:58-61` asserts exactly 7/9 options. `app.ts` registers all three actions + `app.view("edit_modal_submit")`. |
| 3 | Pending survives cold start (Redis by pendingId); Cancel discards + disables buttons | ✓ VERIFIED | `redis.ts` `putPending` writes `pending:<id>` JSON with 1h EX (out-of-memory, survives cold start). `handleCancel` calls `deletePending` + `chat.update(buildCanceledBlocks())` (no buttons). `interactions.test.ts` covers cancel; `redis.test.ts` round-trips. |
| 4 | Confirm creates task in Task-Seo list with all fields | ✓ VERIFIED | `client.ts` POSTs `/list/{listId}/task`, raw `Authorization: token`, epoch-ms `start_date`/`due_date` + `*_date_time=false`, numeric `assignees`, `custom_fields` {CLIENTE_FIELD_ID 05ebdc8a…: UUID} + {LINK_LOOM_FIELD_ID 5a03e7cb…: link}. List default 901327239630 in `env.ts:27`. `client.test.ts:38-75` asserts epoch-ms, custom_fields by UUID, omission when null, no token leak. `handleConfirm` maps resolved→CreateTaskParams with link=`links[0]`. |
| 5 | Created task link posted back to thread + task↔thread mapping stored | ✓ VERIFIED | `handleConfirm` calls `mapTaskToThread(redis, result.id, {channel, thread_ts})` then `chat.postMessage` with the url into the thread. `interactions.test.ts:125-139` asserts task2thread map written and link posted with correct thread_ts. `redis.ts` `getThreadForTask` ready for Phase 4. |

**Score:** 5/5 truths verified (offline)

### Idempotency (explicit instruction check)

GETDEL-based `claimPending` (`redis.ts:162-167`) is the exactly-once guard. `handleConfirm` returns early on null claim. `interactions.test.ts:143-147` double-confirms the same pendingId and asserts `createTask` `toHaveBeenCalledTimes(1)`. VERIFIED — implemented AND tested.

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `src/clickup/client.ts` | Injectable REST client, createTask | ✓ VERIFIED | 96 lines, fetch-injected, all fields, error path |
| `src/clickup/types.ts` | CreateTaskParams + LINK_LOOM_FIELD_ID | ✓ VERIFIED | Constants + FetchLike present |
| `src/store/redis.ts` | pending/claim/map helpers | ✓ VERIFIED | put/get/claim(getdel)/delete/mapTaskToThread/getThreadForTask |
| `src/slack/blocks.ts` | preview/confirmed/canceled builders | ✓ VERIFIED | 129 lines, ⚠️ flags, 3 buttons, terminal button-free states |
| `src/slack/modal.ts` | buildEditModal + parseEditSubmission | ✓ VERIFIED | 7/9 selects, datepickers, private_metadata, patch parse |
| `src/slack/interactions.ts` | handleConfirm/Cancel/EditOpen/EditSubmit | ✓ VERIFIED | 188 lines, all injected, idempotent confirm |
| `src/slack/process.ts` | parse→putPending→preview (placeholder removed) | ✓ VERIFIED | Phase-1 placeholder receipt path replaced |
| `src/slack/app.ts` | Bolt action/view registration | ✓ VERIFIED | confirm/cancel/edit actions + view, ack-first |
| `api/slack/interactions.ts` | Vercel POST endpoint | ✓ VERIFIED | Mirrors events.ts; POST + default handler |

### Key Link Verification

| From | To | Via | Status |
| --- | --- | --- | --- |
| interactions.ts | claimPending | idempotent confirm | ✓ WIRED |
| process.ts | parseAndResolve + buildPreviewBlocks + putPending | preview pipeline | ✓ WIRED |
| app.ts | app.action confirm/cancel/edit + app.view | Bolt lifecycle | ✓ WIRED |
| client.ts | CLIENTE_FIELD_ID (config) | custom_fields | ✓ WIRED |
| blocks.ts/modal.ts | CLIENTS/MEMBERS | display + select options | ✓ WIRED |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Full test suite | `npm test` | 129 passed, 1 skipped (live) | ✓ PASS |
| Typecheck | `npx tsc --noEmit` | exit 0, clean | ✓ PASS |

The 1 skipped test is `src/llm/parse.live.test.ts` (gated live smoke) — expected. ERROR lines in output are deliberate negative-path signature tests that passed.

### Requirements Coverage

| Requirement | Status | Evidence |
| --- | --- | --- |
| CONFIRM-01 | ✓ SATISFIED | preview with resolved values + ⚠️ flags |
| CONFIRM-02 | ✓ SATISFIED | 3 Block Kit buttons |
| CONFIRM-03 | ✓ SATISFIED | Redis pending, 1h TTL, pendingId in button value |
| CONFIRM-04 | ✓ SATISFIED | Edit modal selects/pickers + re-render |
| CONFIRM-05 | ✓ SATISFIED | cancel/confirm update to button-free terminal blocks |
| CREATE-01 | ✓ SATISFIED | task in list 901327239630, epoch-ms dates |
| CREATE-02 | ✓ SATISFIED | Cliente UUID + Link/Loom custom_fields |
| CREATE-03 | ✓ SATISFIED | link posted back in thread |
| CREATE-04 | ✓ SATISFIED | task2thread map written |

### Anti-Patterns Found

None blocking. No TODO/FIXME/XXX/PLACEHOLDER debt markers in phase files. Empty-array/null usages are legitimate (`links[0] ?? null`, optional field omission, in-memory test fakes). `RECEIPT_TEXT` retained intentionally as accessibility fallback text accompanying preview blocks (documented).

### Human Verification Required

The phase goal is fully achieved in code and proven offline (5/5 truths, 129 tests, clean typecheck). Per the phase contract and ROADMAP note "*(offline-verified; live Slack/ClickUp pending)*", the live round-trips require a deployed app + real tokens and must be confirmed by a human:

1. **Live preview** — post a Spanish message → expect threaded preview with resolved values + ⚠️ flags.
2. **Live confirm + idempotency** — Confirmar (and double-click) → exactly one ClickUp task with all fields, ✅ link in thread.
3. **Live edit modal** — Editar → modal (7 Cliente / 9 Asignados / date pickers) opens <3s → submit re-renders corrected preview.
4. **Live cancel** — Cancelar → ❌ message, buttons removed, pending discarded.

### Gaps Summary

No gaps. All offline-verifiable wiring, logic, and tests pass. Status is `human_needed` solely because live Slack interactivity and real ClickUp task creation cannot be exercised without a deployed app — these are inherent UAT items, not implementation gaps.

---

_Verified: 2026-06-18_
_Verifier: Claude (gsd-verifier)_
