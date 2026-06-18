---
phase: 01-serverless-foundation
plan: 01
subsystem: scaffold
tags: [typescript, esm, vercel, vitest, tooling]
requires: []
provides: ["buildable strict-mode ESM TS project", "locked dependency set", "wired Vitest runner", "env contract"]
affects: ["all later Phase 1 plans build on this scaffold"]
tech-stack:
  added: ["@slack/bolt@4.7.3", "@vercel/slack-bolt@1.5.0", "@vercel/functions@3.7.1", "@upstash/redis@1.38.0", "zod@4.4.3", "typescript@5.9.3", "vitest@2.1.9", "@types/node@20.19.43", "vercel CLI"]
  patterns: ["api/ thin handlers + src/ framework-free domain", "tests colocated as *.test.ts"]
key-files:
  created: ["package.json", "package-lock.json", "tsconfig.json", "vercel.json", ".gitignore", ".env.example", "README.md", "vitest.config.ts"]
  modified: []
decisions: ["Node 20 target (CONTEXT override of research's Node 22)", "maxDuration 60 for Fluid Compute waitUntil", "Vercel KV / openai / @anthropic-ai/sdk deliberately NOT installed"]
metrics:
  duration: "~10 min"
  completed: "2026-06-18"
---

# Phase 1 Plan 01: Scaffold Summary

Greenfield strict-mode ESM TypeScript project with the locked Slack→ClickUp dependency set, Vercel Fluid-Compute function config, secret hygiene, a documented env contract, and a wired Vitest runner.

## What was built

- **package.json** — ESM (`"type": "module"`), `engines.node >=20 <21`, scripts `build`/`typecheck` (`tsc --noEmit`), `test` (`vitest run`), `test:watch`. Locked runtime deps: `@slack/bolt`, `@vercel/slack-bolt`, `@vercel/functions`, `@upstash/redis`, `zod`. Dev deps: `typescript`, `@types/node@^20`, `vitest`, `vercel`.
- **tsconfig.json** — `strict: true`, `noUncheckedIndexedAccess: true`, `target ES2022`, `module/moduleResolution NodeNext`, `esModuleInterop`, `skipLibCheck`, `resolveJsonModule`, `types: ["node"]`; includes `src`, `api`, `**/*.test.ts`.
- **vercel.json** — `functions["api/**/*.ts"]` → `runtime nodejs20.x`, `maxDuration 60` for background `waitUntil`. Fluid Compute itself is a dashboard toggle (user_setup), not set here.
- **.gitignore** — `node_modules`, `.env*`, `.vercel`, `dist`, `coverage`.
- **.env.example** — documents all six vars (`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_TASK_CHANNEL_ID`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `TEAM_TIMEZONE=America/Caracas`) with placeholders + one-line comments.
- **README.md** — one-liner, stack, layout, Environment table, and Vercel setup (enable Fluid Compute, provision Upstash via Marketplace).
- **vitest.config.ts** — node environment, includes `**/*.test.ts`.

## Verification

- `npm install` succeeded — 397 packages, lockfile generated. (EBADENGINE warning only: local Node is v24 vs the Vercel-target Node 20 declaration — harmless for build/test.)
- Installed exact versions match STACK.md (`@slack/bolt@4.7.3`, `@vercel/slack-bolt@1.5.0`, `@vercel/functions@3.7.1`, `@upstash/redis@1.38.0`, `zod@4.4.3`).
- Forbidden deps absent: no `@vercel/kv`, `openai`, or `@anthropic-ai/sdk`.
- `strict: true` present; `.env` is git-ignored (`git check-ignore .env` → matched).
- `npx tsc --noEmit` passes once source files land (plan 02). On the empty scaffold it emits only TS18003 "No inputs found" — the documented "no source yet" state; full strict typecheck passes green after plans 02–03.

## Deviations from Plan

None functionally. The standalone `tsc` on the empty scaffold reports TS18003 (no input files) — expected per the plan's "tsc passes (no source yet)" note; it resolves to a clean pass as soon as `src/` exists (verified at end of plan 03).

## Self-Check: PASSED

All 8 scaffold files exist; commit `c40682d` present.
