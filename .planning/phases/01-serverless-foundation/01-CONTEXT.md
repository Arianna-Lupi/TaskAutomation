# Phase 1: Serverless Foundation - Context

**Gathered:** 2026-06-18
**Status:** Ready for planning
**Mode:** Auto-generated (autonomous smart-discuss)

<domain>
## Phase Boundary

A deployed Slack events endpoint that safely receives messages from the dedicated channel — verifying Slack's HMAC over the raw body, acknowledging within 3 seconds, deduplicating retries, ignoring its own/bot messages, and persisting state in Upstash Redis.

In scope: project scaffolding (Node/TS, Vercel), the Slack events ingress function, raw-body signature verification, 3s ACK + background processing via `@vercel/slack-bolt` / `waitUntil`, event dedup, channel/message filtering, Redis client wiring, and an in-thread receipt acknowledging a captured message.

Out of scope (later phases): LLM parsing, ClickUp calls, preview/confirmation UI, reverse webhook.
</domain>

<decisions>
## Implementation Decisions

### Stack (from research, locked)
- Node 20 + TypeScript, deployed on Vercel serverless with **Fluid Compute** enabled.
- `@slack/bolt@^4` + `@vercel/slack-bolt@^1.5` for the Slack events endpoint (handles signature verification + ack-then-`waitUntil`).
- `@vercel/functions` for `waitUntil` in non-Bolt paths.
- `@upstash/redis` (REST client — serverless-safe) for state. Provision Upstash via Vercel Marketplace. **Do NOT use Vercel KV (sunset).**
- `zod` for env validation.

### Configuration (env vars)
- `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` — Slack app.
- `SLACK_TASK_CHANNEL_ID` — the single dedicated channel the bot listens to. Messages from any other channel are ignored.
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.
- `TEAM_TIMEZONE` (default `America/Caracas`) — seeded now for later phases.
- Validate all env at startup with a `zod` schema; fail fast with a clear error if missing.

### Ingestion behavior (Claude's discretion, grounded in PITFALLS)
- Endpoint: `/api/slack/events` (Bolt-handled). ACK within 3s, do work in `waitUntil`.
- **Dedup:** key on Slack `event_id` in Redis with `SET key 1 NX EX 600` (10-min TTL). If the key already exists → drop (it's a retry). This prevents duplicate processing from Slack's 3-retry behaviour.
- **Filter:** process only messages where channel == `SLACK_TASK_CHANNEL_ID`, `subtype` is undefined (plain user message), `bot_id` is absent, and the message is a root message (no `thread_ts`, or `thread_ts == ts`). Ignore the bot's own user id. This kills echo loops.
- **Receipt:** on a valid captured message, post a short ack in the thread (e.g. "👀 Recibido — procesando...") so Phase 1 is observably working end-to-end without any ClickUp logic yet. Later phases replace/extend this with the parsed preview.

### Project structure
- `api/` for Vercel function handlers (thin ingress).
- `src/` for framework-free domain/util code (`src/config/env.ts`, `src/store/redis.ts`, `src/slack/`).
- `vercel.json` enabling Fluid Compute; `.env.example` documenting all vars; `.gitignore` for node_modules/.env.
- `tsconfig.json` strict mode.

### Deferred to later phases
- Actual LLM parse, ClickUp create, preview Block Kit, reverse webhook. Phase 1 only needs to prove safe capture + receipt.

### Claude's Discretion
Remaining implementation choices (file naming, exact Bolt wiring, Redis key prefixes, logging) are at Claude's discretion using the research SUMMARY.md/STACK.md/PITFALLS.md and good serverless conventions.
</decisions>

<code_context>
## Existing Code Insights

Greenfield — no code yet. This phase establishes the repo skeleton. Real ClickUp IDs and the 9-member / 7-client maps live in PROJECT.md and will become config-as-code in Phase 2; Phase 1 does not need them.
</code_context>

<specifics>
## Specific Ideas

- The dedicated Slack channel, app, and Upstash instance are external setup the user must provision; the code reads their values from env. Provide `.env.example` and a short README note on required env + enabling Fluid Compute.
- Verification of "ACK <3s in production" requires a live deploy + Slack app; if not deployable in this environment, verify via unit/integration tests of the signature, dedup, and filter logic, and mark live-deploy checks as human_needed.
</specifics>

<deferred>
## Deferred Ideas

None beyond the later-phase scope above.
</deferred>
