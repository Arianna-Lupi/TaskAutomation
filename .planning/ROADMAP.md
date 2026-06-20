# Roadmap: Slack → ClickUp Task Bot

## Overview

This bot turns free-form Spanish Slack messages in one dedicated channel into correctly-structured ClickUp tasks (cliente, asignados, fechas, links) behind a mandatory human-confirmation gate, then notifies the same Slack thread when a task's status or assignee changes. The build follows the dependency chain the work imposes: first the serverless foundation (3s ACK, raw-body signatures, idempotency store) that everything rides on, then the highest-risk and Slack-independent NL parser + deterministic resolver, then the confirm-and-create slice that makes **Flow A** (Slack → ClickUp) a complete shippable product validating Core Value, then the independent reverse-sync **Flow B** (ClickUp → Slack notifications), and finally hardening for production resilience. **Milestone v1.1** then removes the hardcoded config — reading the Cliente dropdown, ClickUp members, and the Slack→ClickUp map live from ClickUp with Redis caching and resilient fallback (Phase 6) — and audits the whole app against the OWASP Top 10, producing SECURITY.md (Phase 7) before implementing the prioritized fixes (Phase 8).

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Serverless Foundation** - Slack ingress that verifies signatures, ACKs <3s, dedups, and parks state in Redis *(offline-verified; live deploy pending)*
- [x] **Phase 2: NL Parser + Resolver** - OpenAI turns free text into a ClickUp-ready payload with real client/member IDs and epoch-ms dates
- [x] **Phase 3: Confirm + Create (Flow A complete)** - Threaded preview with Confirm/Edit/Cancel that creates the task and posts its link back *(offline-verified; live Slack/ClickUp pending)*
- [x] **Phase 4: Reverse Notifications (Flow B)** - ClickUp webhook posts status/assignee changes back to the originating thread *(offline-verified; live registration pending)*
- [x] **Phase 5: Hardening** - Error reporting in-thread, rate-limit/redelivery handling, and a per-channel kill switch

_Milestone v1.1 — Dynamic Config + Security Hardening:_
- [ ] **Phase 6: Dynamic Config from ClickUp** - Live Cliente options, members, and email-resolved Slack→ClickUp map, Redis-cached with TTL and resilient fallback (no redeploy to add a client/member)
- [ ] **Phase 7: Security Audit** - OWASP Top 10 (2021) + cybersecurity review of the whole app, severity-classified, written up as SECURITY.md with a prioritized remediation plan
- [ ] **Phase 8: Security Hardening** - Implement the audit fixes: gate/remove /api/slack/diag, fix critical/high findings, scrub secrets from logs/responses, patch vulnerable deps

## Phase Details

### Phase 1: Serverless Foundation
**Goal**: A deployed Slack events endpoint that safely receives messages from the dedicated channel — verifying Slack's HMAC over the raw body, acknowledging within 3 seconds, deduplicating retries, ignoring its own/bot messages, and persisting state in Upstash Redis.
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: INGEST-01, INGEST-02, INGEST-03, INGEST-04
**Success Criteria** (what must be TRUE):
  1. A human message posted in the dedicated channel is received and the bot posts a receipt in that message's thread
  2. Requests with an invalid or stale Slack signature are rejected; valid ones are accepted
  3. Slack's retry of the same event does not produce a second reaction (idempotent on event_id/message_ts)
  4. The bot ignores its own posts and other bots' messages and non-root messages (no echo loop)
  5. State written to Upstash Redis survives a cold start and is readable on the next invocation
**Plans**: 3 plans
  - [ ] 01-01-PLAN.md — Repo scaffold, locked deps, strict TS config, Vitest, env contract (+ dependency-provenance gate)
  - [ ] 01-02-PLAN.md — Env validation (zod fail-fast) + Upstash Redis dedup helper (SET NX EX on event_id)
  - [ ] 01-03-PLAN.md — Slack events ingress slice: signature + ACK<3s/waitUntil + dedup + filter + in-thread receipt (+ live deploy checkpoint)

### Phase 2: NL Parser + Resolver
**Goal**: An offline-testable pipeline that takes a raw message string and returns a ClickUp-ready payload — OpenAI (structured outputs, json_schema strict) extracts the structured fields, and a deterministic resolver maps cliente to its dropdown option UUID, assignees to ClickUp member IDs, and relative Spanish dates to epoch milliseconds in the team timezone, leaving anything unmatched as null.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: PARSE-01, PARSE-02, PARSE-03, PARSE-04
**Success Criteria** (what must be TRUE):
  1. A free-form message yields a structured object with title, description, cliente, asignados, start date, due date, and links
  2. The cliente string resolves to one of the 7 real dropdown option UUIDs, or null when there is no valid match
  3. Assignee names (from the Slack→ClickUp map or loose text mentions) resolve to real member IDs, or null when unmatched
  4. Relative Spanish dates like "viernes" or "mañana" resolve to correct epoch-millisecond timestamps in the team timezone
**Plans**: 3 plans
  - [x] 02-01-PLAN.md — Env schema (OPENAI_API_KEY/MODEL) + openai/luxon deps + config-as-code maps (clients.ts, members.ts with aliases)
  - [x] 02-02-PLAN.md — Deterministic resolver (pure, fully unit-tested): cliente→UUID, assignees→member ids, Spanish dates→epoch ms in team TZ
  - [x] 02-03-PLAN.md — OpenAI structured-outputs parser (injectable client, offline tests) + parseAndResolve glue + gated live smoke test

### Phase 3: Confirm + Create (Flow A complete)
**Goal**: The complete, shippable Slack → ClickUp slice: the bot posts a Block Kit preview of the resolved values in the thread, a human Confirms/Edits/Cancels, and on confirm the task is created in the Task-Seo Team list with all fields set and its link posted back — validating Core Value end to end.
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: CONFIRM-01, CONFIRM-02, CONFIRM-03, CONFIRM-04, CONFIRM-05, CREATE-01, CREATE-02, CREATE-03, CREATE-04
**Success Criteria** (what must be TRUE):
  1. The bot posts a threaded preview showing resolved cliente/asignados/fechas and clearly flags any unresolved fields
  2. The preview has working Confirm / Edit / Cancel buttons; Edit opens a modal with selects to correct cliente/asignados/fechas
  3. The pending task survives a cold start (persisted in Redis by pendingId) and Cancel discards it and disables the buttons
  4. Confirming creates a task in the Task-Seo Team list with title, description, assignees, epoch-ms dates, Cliente option UUID, and Link/Loom when present
  5. The created task's link is posted back to the original thread and the task↔thread mapping is stored for reverse notifications
**Plans**: 4 plans
  - [ ] 03-01-PLAN.md — Env + injectable ClickUp REST client (createTask: dates ms, assignees, custom_fields by UUID, Link/Loom), unit-tested
  - [ ] 03-02-PLAN.md — Redis pending + task↔thread helpers (GETDEL idempotent claim) + Spanish Block Kit preview builder
  - [ ] 03-03-PLAN.md — Flow A core: parse→preview replaces placeholder + Confirmar (idempotent create+link+map) + Cancelar + /api/slack/interactions
  - [ ] 03-04-PLAN.md — Editar modal: open prefilled selects/date pickers + submit re-renders corrected preview

### Phase 4: Reverse Notifications (Flow B)
**Goal**: An independent ClickUp → Slack path: a webhook endpoint verifies ClickUp's X-Signature over the raw body, listens for status and assignee changes, and posts the relevant ones into the originating thread using the stored task↔thread map.
**Mode:** mvp
**Depends on**: Phase 3
**Requirements**: NOTIFY-01, NOTIFY-02, NOTIFY-03
**Success Criteria** (what must be TRUE):
  1. The ClickUp webhook endpoint accepts requests with a valid X-Signature and rejects invalid ones
  2. The bot is registered for and receives taskStatusUpdated and taskAssigneeUpdated events
  3. A relevant status or assignee change posts a notification into the correct Slack thread via the task↔thread map, filtering out noise
**Plans**: 3 plans
  - [x] 04-01-PLAN.md — Env (CLICKUP_WEBHOOK_SECRET/TEAM_ID) + raw-body X-Signature verifier (self-signed unit test) + webhook redelivery dedup helper
  - [x] 04-02-PLAN.md — Core Flow B logic (offline e2e): payload parse/filter, task2thread lookup, Spanish status/assignee message build + post, getTask fallback
  - [x] 04-03-PLAN.md — Plain /api/clickup/webhook ingress (raw-body verify→401/200→waitUntil) + one-time registration helper/README

### Phase 5: Hardening
**Goal**: Production resilience for the whole bot: parse/create failures surface clearly in-thread instead of failing silently, rate limits and webhook redeliveries are handled gracefully, and the bot can be disabled per channel without a redeploy.
**Mode:** mvp
**Depends on**: Phase 4
**Requirements**: HARD-01, HARD-02, HARD-03
**Success Criteria** (what must be TRUE):
  1. A parse or creation error posts a clear message in the thread (no silent failure)
  2. ClickUp 429 responses are retried with backoff and duplicate webhook redeliveries are ignored
  3. Flipping the kill switch for the channel stops the bot from acting without any redeploy
**Plans**: 2 plans
  - [x] 05-01-PLAN.md — ClickUp 429/5xx retry+backoff wrapper (injected clock) + reportErrorToThread helper + wire in-thread error reporting (HARD-01, HARD-02)
  - [x] 05-02-PLAN.md — Per-channel kill switch (redis helpers + capture-path guard + ops script + README) + Slack/webhook redelivery-coverage confirmation (HARD-03, HARD-02)

### Phase 6: Dynamic Config from ClickUp
**Goal**: Replace the hardcoded `src/config/clients.ts` and `members.ts` maps with live ClickUp data — read the Cliente dropdown options and workspace members on demand, cache them in Redis with a ~10-minute TTL, resolve the Slack→ClickUp assignee map by email instead of hardcoded Slack IDs, fall back to the last-good cache or the static maps when ClickUp/Redis is down, and expose a manual cache-refresh path so a newly added client or member can be picked up without a redeploy.
**Mode:** mvp
**Depends on**: Phase 5
**Requirements**: DYN-01, DYN-02, DYN-03, DYN-04, DYN-05, DYN-06
**Success Criteria** (what must be TRUE):
  1. Adding or renaming a Cliente option in ClickUp shows up in a new task preview without a redeploy (after the cache TTL expires or a manual refresh), and the resolver maps it to the correct option UUID
  2. A newly added ClickUp workspace member can be resolved as an assignee without any code change, using live member data
  3. A Slack user is matched to their ClickUp member by email (Slack `users.info` email ↔ ClickUp member email) with no hardcoded Slack IDs
  4. When ClickUp or Redis is unreachable, the bot serves the last-good cached config (or the static maps) and the parse/preview/create flow still completes instead of breaking
  5. Hitting the manual refresh/invalidate path clears the cached clients/members so the next parse reads fresh ClickUp data immediately
**Plans**: 3 plans
  - [ ] 06-01-PLAN.md — Live ClickUp reads (getClienteOptions/getMembers via existing retry fetch) + Redis config-cache helpers (TTL + non-expiring last-good)
  - [ ] 06-02-PLAN.md — Config provider (fetch→cache→last-good→static fallback, curated-alias overlay) + resolver provider-injection (backward-compatible static defaults)
  - [ ] 06-03-PLAN.md — Email-based Slack→member resolution + secret-gated cache-refresh endpoint + wire provider into the live capture path

### Phase 7: Security Audit
**Goal**: A complete, written security review of the live bot: audit every OWASP Top 10 (2021) category against the app, run a focused cybersecurity analysis of signature verification (Slack signing + ClickUp X-Signature), secrets handling, input validation, SSRF/injection risk in the ClickUp fetch path, the `/api/slack/diag` exposure, and vulnerable dependencies, and capture all findings severity-classified in `SECURITY.md` with a prioritized remediation plan. No fixes here — this phase produces the report that Phase 8 executes against.
**Mode:** mvp
**Depends on**: Phase 6
**Requirements**: SEC-01, SEC-02, SEC-03
**Success Criteria** (what must be TRUE):
  1. `SECURITY.md` exists and walks every OWASP Top 10 (2021) category, with each finding tagged critical/high/medium/low
  2. The report explicitly assesses Slack + ClickUp signature verification, secrets handling/non-exposure, input validation, SSRF/injection in the ClickUp fetch, and the `/api/slack/diag` endpoint exposure
  3. A dependency vulnerability scan is recorded, listing affected packages and their severities
  4. `SECURITY.md` ends with a prioritized remediation plan that maps each open finding to a concrete fix and owner-phase (Phase 8)
**Plans**: TBD

### Phase 8: Security Hardening
**Goal**: Execute the remediation plan from `SECURITY.md`: gate or remove `/api/slack/diag` so it is not exposed in production, fix every critical and high finding (input validation, headers, access control, error handling), guarantee no secret or token is ever logged or leaked in responses or error bodies, and review/update dependencies with known critical or high vulnerabilities — a surgical hardening pass, not a rewrite.
**Mode:** mvp
**Depends on**: Phase 7
**Requirements**: SEC-04, SEC-05, SEC-06, SEC-07
**Success Criteria** (what must be TRUE):
  1. `/api/slack/diag` is no longer reachable unauthenticated in production — it is env-gated, strongly gated/rate-limited, or returns 404 in prod
  2. Every critical and high finding from `SECURITY.md` is fixed and re-verified, and `SECURITY.md` reflects the closed status
  3. No secret or token appears in application logs, HTTP responses, or error bodies (verified against the audit's secrets-exposure checks)
  4. Known critical/high dependency vulnerabilities are patched (or explicitly documented as accepted), and the dependency scan re-runs clean
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Serverless Foundation | 3/3 | Complete (offline; live deploy pending) | 2026-06-18 |
| 2. NL Parser + Resolver | 3/3 | Complete (offline; live OpenAI accuracy pending) | 2026-06-18 |
| 3. Confirm + Create (Flow A) | 4/4 | Complete (offline; live Slack/ClickUp pending) | 2026-06-18 |
| 4. Reverse Notifications (Flow B) | 3/3 | Complete (offline; live registration pending) | 2026-06-18 |
| 5. Hardening | 2/2 | Complete (offline; live 429/5xx backoff timing pending) | 2026-06-18 |
| 6. Dynamic Config from ClickUp | 0/3 | Planned | - |
| 7. Security Audit | 0/? | Not started | - |
| 8. Security Hardening | 0/? | Not started | - |
</content>
