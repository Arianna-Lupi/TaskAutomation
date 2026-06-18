# Roadmap: Slack → ClickUp Task Bot

## Overview

This bot turns free-form Spanish Slack messages in one dedicated channel into correctly-structured ClickUp tasks (cliente, asignados, fechas, links) behind a mandatory human-confirmation gate, then notifies the same Slack thread when a task's status or assignee changes. The build follows the dependency chain the work imposes: first the serverless foundation (3s ACK, raw-body signatures, idempotency store) that everything rides on, then the highest-risk and Slack-independent NL parser + deterministic resolver, then the confirm-and-create slice that makes **Flow A** (Slack → ClickUp) a complete shippable product validating Core Value, then the independent reverse-sync **Flow B** (ClickUp → Slack notifications), and finally hardening for production resilience.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Serverless Foundation** - Slack ingress that verifies signatures, ACKs <3s, dedups, and parks state in Redis
- [ ] **Phase 2: NL Parser + Resolver** - Claude turns free text into a ClickUp-ready payload with real client/member IDs and epoch-ms dates
- [ ] **Phase 3: Confirm + Create (Flow A complete)** - Threaded preview with Confirm/Edit/Cancel that creates the task and posts its link back
- [ ] **Phase 4: Reverse Notifications (Flow B)** - ClickUp webhook posts status/assignee changes back to the originating thread
- [ ] **Phase 5: Hardening** - Error reporting in-thread, rate-limit/redelivery handling, and a per-channel kill switch

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
**Plans**: TBD

### Phase 2: NL Parser + Resolver
**Goal**: An offline-testable pipeline that takes a raw message string and returns a ClickUp-ready payload — Claude (forced tool use) extracts the structured fields, and a deterministic resolver maps cliente to its dropdown option UUID, assignees to ClickUp member IDs, and relative Spanish dates to epoch milliseconds in the team timezone, leaving anything unmatched as null.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: PARSE-01, PARSE-02, PARSE-03, PARSE-04
**Success Criteria** (what must be TRUE):
  1. A free-form message yields a structured object with title, description, cliente, asignados, start date, due date, and links
  2. The cliente string resolves to one of the 7 real dropdown option UUIDs, or null when there is no valid match
  3. Assignee names (from the Slack→ClickUp map or loose text mentions) resolve to real member IDs, or null when unmatched
  4. Relative Spanish dates like "viernes" or "mañana" resolve to correct epoch-millisecond timestamps in the team timezone
**Plans**: TBD

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
**Plans**: TBD

### Phase 4: Reverse Notifications (Flow B)
**Goal**: An independent ClickUp → Slack path: a webhook endpoint verifies ClickUp's X-Signature over the raw body, listens for status and assignee changes, and posts the relevant ones into the originating thread using the stored task↔thread map.
**Mode:** mvp
**Depends on**: Phase 3
**Requirements**: NOTIFY-01, NOTIFY-02, NOTIFY-03
**Success Criteria** (what must be TRUE):
  1. The ClickUp webhook endpoint accepts requests with a valid X-Signature and rejects invalid ones
  2. The bot is registered for and receives taskStatusUpdated and taskAssigneeUpdated events
  3. A relevant status or assignee change posts a notification into the correct Slack thread via the task↔thread map, filtering out noise
**Plans**: TBD

### Phase 5: Hardening
**Goal**: Production resilience for the whole bot: parse/create failures surface clearly in-thread instead of failing silently, rate limits and webhook redeliveries are handled gracefully, and the bot can be disabled per channel without a redeploy.
**Mode:** mvp
**Depends on**: Phase 4
**Requirements**: HARD-01, HARD-02, HARD-03
**Success Criteria** (what must be TRUE):
  1. A parse or creation error posts a clear message in the thread (no silent failure)
  2. ClickUp 429 responses are retried with backoff and duplicate webhook redeliveries are ignored
  3. Flipping the kill switch for the channel stops the bot from acting without any redeploy
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Serverless Foundation | 0/TBD | Not started | - |
| 2. NL Parser + Resolver | 0/TBD | Not started | - |
| 3. Confirm + Create (Flow A) | 0/TBD | Not started | - |
| 4. Reverse Notifications (Flow B) | 0/TBD | Not started | - |
| 5. Hardening | 0/TBD | Not started | - |
