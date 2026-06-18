# Project Research Summary

**Project:** Slack ↔ ClickUp NL-to-task automation bot
**Domain:** Webhook-driven serverless integration bot (Slack + Anthropic LLM + ClickUp) on Vercel
**Researched:** 2026-06-18
**Confidence:** HIGH

## Executive Summary

This is a **webhook-driven, stateless serverless bot** that turns free-form Spanish Slack messages into correctly-structured ClickUp tasks (right client, assignee, dates, links) behind a mandatory human-confirmation gate, plus a reverse path that notifies Slack when a ClickUp task's status or assignee changes. The expert-standard way to build this in 2025/2026 is the **`@vercel/slack-bolt` adapter on Vercel Fluid Compute**: it solves Slack's hard 3-second ACK deadline by acknowledging immediately and continuing the slow work (LLM parse, ClickUp create) in the background via `waitUntil()` — no queue, no second service. NL extraction uses the official `@anthropic-ai/sdk` with **forced tool use** (a single typed `create_task` tool) so the model returns guaranteed-shaped JSON, never prose. ClickUp is hit with plain `fetch` against REST v2, and both inbound webhooks (Slack signing-secret HMAC, ClickUp `X-Signature` HMAC-SHA256) are verified over the **raw request body**.

The recommended approach is a clean separation between three thin ingress functions (`/api/slack/events`, `/api/slack/interactions`, `/api/clickup/webhook`) and a framework-free domain layer (LLM parser → deterministic resolver → ClickUp/Slack clients). The single most important architectural rule is **resolve-then-confirm**: the LLM emits human strings, a deterministic resolver maps them to real ClickUp IDs (7 Cliente option UUIDs, 9 member IDs) against config-as-code *before* the preview, and the human confirms the already-resolved, ClickUp-ready payload. That payload is parked in **Upstash Redis** (Vercel KV is sunset) keyed by a short `pendingId` that rides in the Slack button value — the same store also handles event dedup and the task↔thread mapping, both required regardless.

The dominant risks are well-understood and converge on the same disciplines. The worst failure mode is **duplicate ClickUp tasks** from Slack's retry-on-slow-ack behaviour — prevented only by ack-first + idempotency keyed on `message_ts`/`event_id`. Close behind: signature checks silently broken by Vercel body-parsing (read raw body first), **echo/feedback loops** where the bot re-ingests its own posts (filter `bot_id`/own user, parse only root human messages), **LLM hallucinating** an invalid client/assignee (hard server-side validation against the real lists), **timezone off-by-one dates** (resolve relative Spanish dates in a pinned team TZ, send epoch *milliseconds*), and **ClickUp dropdowns set by option UUID, not label**.

## Key Findings

### Recommended Stack

The keystone is the official Vercel Bolt adapter, which removes the need for any external queue at this scale. NL parsing uses forced tool use rather than free-text JSON; ClickUp is plain `fetch`; secrets live in Vercel env vars. See `STACK.md` for full version compatibility.

**Core technologies:**
- `@slack/bolt@4.7.3` + `@vercel/slack-bolt@1.5.0`: Slack framework + Vercel adapter — official 3-second-ack solution via Fluid Compute `waitUntil`; handles Slack signature verification internally.
- `@anthropic-ai/sdk@0.105.0` (model `claude-sonnet-4-5`, fallback `claude-haiku-4-5`): NL → structured task via forced single-tool use.
- ClickUp REST API v2 via `fetch` + Node `crypto`: create tasks/custom fields and verify webhook HMAC — no mature Node SDK worth adopting.
- `@vercel/functions@3.7.1` + `zod@4.4.3`: `waitUntil` primitive for the non-Bolt ClickUp→Slack path; Zod schema doubles as tool input schema and runtime guard.
- Upstash Redis (via Vercel Marketplace): pending-task store, event dedup, task↔thread map — Vercel KV is sunset.

### Expected Features

`FEATURES.md` scopes a deliberately narrow internal-team product (3–4 active users, one dedicated channel). v1 is the full create path; reverse sync is v1.x; broad "ClickUp parity" features are anti-features.

**Must have (table stakes):**
- Single-channel message capture (root human messages only).
- Claude NL parse → {title, description, cliente, assignees, start/due, links}.
- Block Kit threaded preview with Confirm / Edit / Cancel — the mandatory human gate.
- Cliente resolution to dropdown option UUID + assignee resolution (static map + name fuzzy match).
- Confirm → create task in the Task-Seo Team list with all fields; post task link back to thread.
- Edit via prefilled modal (selects for Cliente/assignee); failure feedback + duplicate-create guard.

**Should have (competitive):**
- Reverse notification: `taskStatusUpdated` + `taskAssigneeUpdated` → Slack (P2, needs deployed endpoint).
- Threaded reverse notifications (persist task↔thread); event filtering for meaningful transitions.
- Per-field confidence flagging on uncertain parses.

**Defer (v2+):**
- RIPAI meeting-summary → ClickUp pipeline; 1-click high-confidence confirm; reaction-based confirm.
- Explicitly NOT building: two-way edit sync, multi-channel/DM/slash commands, per-user OAuth, auto-create without confirmation, config UI, analytics, reminders/SLA.

### Architecture Approach

A stateless, webhook-driven design: three thin ingress functions each verify signature, dedup, ACK within 3s, then defer heavy work to `waitUntil`; a framework-free domain layer (`src/`) holds the testable parse→resolve→create pipeline; tiny slow-changing data (9 members, 7 clients, IDs) lives as committed config-as-code, not a DB. See `ARCHITECTURE.md`.

**Major components:**
1. Ingress functions (`/api/slack/events`, `/api/slack/interactions`, `/api/clickup/webhook`) — verify, dedup, ACK fast, delegate.
2. LLM Parser (Anthropic tool use) — free text → `ParsedTask`; schema is single source of truth.
3. Resolver/Mapper — pure functions mapping client/assignee strings → real ClickUp IDs and normalizing dates to epoch ms; no I/O.
4. ClickUp + Slack clients — `fetch` wrapper for create/read; Bolt/Web API for thread posts and `chat.update`.
5. Upstash Redis store — pending task (TTL), event dedup, task↔thread map.

### Critical Pitfalls

1. **Slack 3s timeout → retries → duplicate tasks** — ack 200 first, do LLM/ClickUp work in `waitUntil`; idempotency keyed on `message_ts`/`event_id`.
2. **Signature verification broken by body parsing** — read raw body before JSON-parse for both Slack and ClickUp; timing-safe compare; reject >5min-old timestamps.
3. **Echo/feedback loops** — filter `bot_id`/own user ID and non-root messages.
4. **LLM hallucinates invalid client/assignee** — validate server-side against the 7 clients / 9 members; unmatched → null and surface in preview.
5. **Timezone/date + dropdown-by-name** — resolve relative Spanish dates in a pinned team TZ and send epoch *milliseconds*; set Cliente via option *UUID* (cached name→UUID map), not label.

## Implications for Roadmap

Flow A (create path) is a shippable slice before Flow B (reverse sync).

### Phase 1: Serverless Foundation — ACK, signatures, store
**Rationale:** The hardest serverless constraints (3s ACK, raw-body signature, statelessness) underpin everything; getting them wrong causes the worst failure (duplicate tasks).
**Delivers:** Slack events endpoint verifying signing-secret HMAC over raw body, dedups on `event_id`, ACKs <3s, echoes receipt in-thread; Upstash Redis provisioned; secrets in Vercel env.
**Avoids:** Pitfalls 1, 2, 3, 9 (secrets).

### Phase 2: LLM Parser + Resolver (offline-testable)
**Rationale:** Highest-risk logic, independent of Slack — build/unit-test in isolation against real example messages.
**Delivers:** `llm/parse.ts` forced tool-use → `ParsedTask`; `resolve/` mapping client→option UUID, names→member IDs, dates→epoch ms in team TZ.
**Avoids:** Pitfalls 4, 5.

### Phase 3: Preview + Confirmation State
**Rationale:** Needs Phases 1+2 plus the store; closes the human-in-the-loop gate (resolve-then-confirm).
**Delivers:** Block Kit threaded preview (resolved values + unresolved flags), pending task in Redis keyed by `pendingId` in button value, Confirm/Edit/Cancel handlers, edit modal with selects.
**Avoids:** Pitfall 8 (confirmation lost on cold start).

### Phase 4: ClickUp Task Creation (Flow A complete)
**Rationale:** Wire confirm → create; end-to-end shippable v1 slice that validates Core Value.
**Delivers:** `POST /list/{id}/task` with custom fields (Cliente UUID, Link/Loom), assignees, epoch-ms dates; post task link to thread; write task↔thread map; disable buttons.
**Avoids:** Pitfall 6 (dropdown UUID not name); idempotent create.

### Phase 5: Bidirectional Notifications (Flow B)
**Rationale:** Independent of Flow A except the shared task↔thread map; requires deployed public endpoint.
**Delivers:** `/api/clickup/webhook` verifying `X-Signature` HMAC over raw body; register `taskStatusUpdated`/`taskAssigneeUpdated`; threaded status notifications with event filtering.
**Avoids:** Pitfall 7 (webhook signature + secret rotation), echo re-check, redelivery dedup.

### Phase 6: Hardening
**Delivers:** Thread error reporting, unresolved-field UX, dedup edge cases, 429 backoff, per-channel kill switch, config review.

### Research Flags
- **Needs research:** Phase 5 (ClickUp `X-Signature`/rotation), Phase 3 (button-value 2000-char limit / `chat.update`).
- **Standard patterns:** Phase 1 (`@vercel/slack-bolt` + Fluid `waitUntil`), Phase 2 (Anthropic forced tool use), Phase 4 (ClickUp Tasks/Custom Fields API).

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Versions verified live against npm; adapter/Fluid Compute confirmed in official Vercel docs. |
| Features | HIGH | Slack/ClickUp capabilities verified against official docs. |
| Architecture | HIGH | Only the confirmation-state choice is a flagged judgment call (MEDIUM-HIGH). |
| Pitfalls | HIGH | Slack/ClickUp behaviours from official docs; serverless patterns well-established. |

**Overall confidence:** HIGH

### Gaps to Address
- ClickUp `X-Signature` exact format — verify against a live webhook-create response before Phase 5.
- Anthropic `tool_choice` exact syntax — confirm against current SDK at build time.
- Cliente option UUIDs — fetch the 7 name→UUID map once via `GET /list/{id}/field` and verify before hardcoding.
- Cold-start frequency under Fluid Compute — monitor function durations in Phase 1.
- task↔thread persistence wiring — ensure written at create time (Phase 4) so Phase 5 can read it.

## Sources

### Primary (HIGH confidence)
- Vercel — `@vercel/slack-bolt` changelog + Slack ACK/latency academy.
- npm registry (live `npm view`) — exact pinned versions and peer-dependency constraints.
- developer.clickup.com — Tasks, Custom Fields, Webhooks, Webhook Signature.
- api.slack.com / docs.slack.dev — Events API (3s, retry headers), Block Kit limits, interactive messages.
- anthropic-sdk-typescript helpers + Claude Models overview — forced tool use.
- Vercel Redis / Marketplace (Vercel KV sunset → Upstash).
- `.planning/PROJECT.md` — real ClickUp IDs: list `901327239630`, Cliente field `05ebdc8a-4736-404d-9132-3ab32875e1f1` (7 options), 9 members.

### Secondary (MEDIUM confidence)
- ClickUp webhook signature/rotation community guidance — verify against live webhook create response.
- Slack serverless 3s-timeout / retry-dedup community articles.
- Bolt interactive-app tutorials — action/modal handling.

---
*Research completed: 2026-06-18*
*Ready for roadmap: yes*
