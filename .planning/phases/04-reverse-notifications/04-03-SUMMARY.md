---
phase: 04-reverse-notifications
plan: 03
subsystem: clickup-webhook-ingress
tags: [flow-b, vercel-function, ingress, ops]
requires:
  - "src/clickup/signature.ts verifyClickUpSignature + getClickUpSignatureHeader (04-01)"
  - "src/clickup/webhook.ts parseWebhookPayload + processClickUpWebhook (04-02)"
  - "src/config/env.ts loadEnv (CLICKUP_WEBHOOK_SECRET, CLICKUP_TEAM_ID)"
provides:
  - "api/clickup/webhook.ts POST handler (raw-body verify -> 401/200 -> waitUntil)"
  - "scripts/register-clickup-webhook.mjs one-time registration helper"
  - "README + .env.example ops documentation"
affects: []
tech-stack:
  added: []
  patterns: ["plain Vercel function (non-Bolt)", "ACK-fast + waitUntil background"]
key-files:
  created:
    - api/clickup/webhook.ts
    - scripts/register-clickup-webhook.mjs
  modified:
    - README.md
    - .env.example
decisions:
  - "WebClient from @slack/web-api (resolves transitively via @slack/bolt; no new package.json entry) used as the SlackPosterLike"
  - "Unusable/unparseable body still returns 200 (ACK; nothing to do) — only signature failure is 401"
  - "Live webhook registration human-deferred (needs deployed URL + token); core proven offline"
metrics:
  duration: ~8m
  completed: 2026-06-18
---

# Phase 4 Plan 03: Flow B HTTP Ingress + Registration Summary

A plain Vercel serverless function at `/api/clickup/webhook` (NOT Bolt) that reads the raw body first, verifies ClickUp's `X-Signature` (401 on missing/mismatch), ACKs 200 fast, and runs the offline-proven `processClickUpWebhook` in `waitUntil`. Plus a dependency-free one-time registration helper and README/`.env.example` ops docs.

## What Was Built

- **`api/clickup/webhook.ts`** — `POST` (and `default`) handler: `req.text()` first → `getClickUpSignatureHeader` → `verifyClickUpSignature(raw, sig, env.CLICKUP_WEBHOOK_SECRET)` (401 on fail) → `parseWebhookPayload` (null → 200) → `waitUntil(processClickUpWebhook(deps, payload))` → 200. Env loaded once per warm instance; deps (Redis, `WebClient` poster, `getTaskName` via `getTask`) built lazily. Secret + tokens never logged.
- **`scripts/register-clickup-webhook.mjs`** — runnable Node ESM, fetch-only: `POST /team/{CLICKUP_TEAM_ID|90131720021}/webhook` with `{ endpoint, events: ["taskStatusUpdated","taskAssigneeUpdated"] }` and the raw `Authorization` token; prints `webhook.id` + `webhook.secret`; non-2xx prints status+body and exits non-zero; token never echoed.
- **README** — "ClickUp webhook registration (one-time, after deploy)" section + the four `CLICKUP_*` env vars; **`.env.example`** — `CLICKUP_WEBHOOK_SECRET` + `CLICKUP_TEAM_ID`.

## Deviations from Plan

**1. [Rule 2 - Config correctness] Added the new vars to `.env.example`**
- The plan listed README + script; `.env.example` already documented the other `CLICKUP_*` vars, so the two new ones were added for a consistent fail-fast setup contract. No code change.

## Verification

- `npx tsc --noEmit` — clean (exit 0).
- `npm test` — 182 passed, 1 skipped (live parse), 0 failed.
- `node --check scripts/register-clickup-webhook.mjs` — OK; script targets both events + team `90131720021`; README references `register-clickup-webhook`.

## Deferred (live, human-deferred)

- Run `scripts/register-clickup-webhook.mjs` after deploy with the live token + public URL; store the returned secret as `CLICKUP_WEBHOOK_SECRET`; trigger a real status/assignee change to confirm the notification lands in the originating thread. (Consistent with prior phases' "offline-verified; live pending" posture — no live ClickUp/Slack/Redis available here.)

## Requirements

- NOTIFY-01 (signature gate at the deployed endpoint) + NOTIFY-02 (registration half) — wired and offline-verified; live registration deferred.

## Self-Check: PASSED
