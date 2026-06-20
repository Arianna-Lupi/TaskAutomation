---
phase: 08-security-hardening
plan: 02
subsystem: input-safety
tags: [security, mrkdwn, input-validation, audit-closure]
requires: [src/clickup/webhook.ts]
provides: [src/util/slackMrkdwn.ts, "escaped preview", "taskId validation"]
affects: [src/slack/blocks.ts, src/clickup/client.ts, .planning/phases/07-security-audit/SECURITY.md]
tech-stack:
  added: []
  patterns: ["shared mrkdwn escape", "trust-boundary id validation"]
key-files:
  created: [src/util/slackMrkdwn.ts]
  modified: [src/clickup/webhook.ts, src/slack/blocks.ts, src/slack/blocks.test.ts, src/clickup/client.ts, src/clickup/client.test.ts, .planning/phases/07-security-audit/SECURITY.md]
decisions:
  - "escapeSlackText moved to shared util; webhook.ts re-exports it (no slack→clickup coupling)"
  - "taskId validated ^[A-Za-z0-9]+$ before fetch (defense-in-depth)"
  - "Webhook replay residual documented, not patched (no signed timestamp to bind)"
metrics:
  duration: ~10m
  completed: 2026-06-19
requirements: [SEC-05, SEC-06, SEC-07]
---

# Phase 8 Plan 02: Input-Safety + Audit Closure Summary

Closed the remaining input-safety findings (preview mrkdwn escape, taskId path validation), documented the webhook replay residual, and updated SECURITY.md to an accurate closed-status record.

## What Was Built

- **src/util/slackMrkdwn.ts** — `escapeSlackText` moved here verbatim from `clickup/webhook.ts`. `webhook.ts` now imports and re-exports it, so the existing export surface and its tests stay unchanged and the outbound slack layer can use it without a slack→clickup import.
- **src/slack/blocks.ts** — `buildPreviewBlocks` now escapes every untrusted interpolated field: `title`, `description`, each `links` entry, the resolved cliente name, and the resolved/unresolved assignee names. The static Spanish labels, ⚠️ markers, formatted dates, and `_(sin descripción)_` / `_(sin links)_` placeholders are left intact. A crafted-input test proves `<!channel>`, `<@U123>`, `&`, and `<...>` links render escaped.
- **src/clickup/client.ts** — `getTask` validates `taskId` against `^[A-Za-z0-9]+$` before the fetch; a malformed id throws `ClickUp getTask: invalid taskId format` and never reaches the URL path. Tests use a fetch spy to prove it is never called for `../../team/...`, empty, spaced, or slashed ids, and that the error carries no token.
- **src/clickup/webhook.ts** — added a FIND-04 comment at the dedup step explaining the accepted replay bound (no signed timestamp; 24h `whk:` dedup + HMAC gate are the bound). No fake timestamp check was invented.
- **SECURITY.md** — appended a "Phase 8 Closure Status" section: FIND-01/02/03/07/11 marked FIXED with locations, FIND-04/05/06/08/09/10 ACCEPTED with rationale, plus SEC-06 no-leak re-confirmation and SEC-07 dependency posture.

## Findings Closed

- **FIND-07 (Low)** — outbound preview mrkdwn injection: fixed (shared escape applied).
- **FIND-11 (Low)** — unvalidated taskId path segment: fixed (regex guard before fetch).
- **FIND-04 (Medium)** — webhook replay: accepted, documented in-code.

## Tests

- Offline only. Full suite: **311 passed, 2 skipped** (was 291 → +20 across both plans; this plan added the blocks crafted-input case and the getTask validation cases). `tsc --noEmit` clean.

## Deviations from Plan

None - plan executed exactly as written.

## Live Re-verify (human-deferred)

None required for this plan — all changes are pure/offline-verifiable. The ops-endpoint live checks are tracked in 08-01-SUMMARY.

## Commits

- e6a1945 feat(08-02): escape outbound preview mrkdwn via shared escapeSlackText
- ed33a06 feat(08-02): validate taskId in getTask + document webhook replay residual
- 325ae5d docs(08-02): close the audit — SECURITY.md Phase 8 status + dep posture

## Self-Check: PASSED

- src/util/slackMrkdwn.ts created and committed; escapeSlackText re-exported from webhook.ts.
- buildPreviewBlocks escapes untrusted fields; getTask validates taskId; FIND-04 documented.
- All three commit hashes present in git log.
