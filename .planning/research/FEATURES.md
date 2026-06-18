# Feature Research

**Domain:** Slack → ClickUp AI task bot (NL capture, human-confirmed creation, bidirectional status sync) for a small internal team (3–4 active users)
**Researched:** 2026-06-18
**Confidence:** HIGH (Slack/ClickUp API capabilities verified against official docs; feature categorization is opinionated for the internal-team use case)

## Feature Landscape

### Table Stakes (Users Expect These)

Missing any of these = the bot fails its Core Value ("free-form Slack message → correct, complete ClickUp task without forms").

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Channel message capture (single dedicated channel) | The whole premise — bot must hear messages | LOW | Subscribe to `message.channels` via Events API. Scope to one channel ID; ignore bot/own messages and thread replies (only parse top-level messages). |
| LLM parse free-form text → structured fields (title, description, cliente, assignees, start/due, links) | This is the magic; without it, it's just a form | MEDIUM | Single Claude call with tool-use / JSON schema output. Inject the 7 Cliente options + 9 member names into the prompt so the model maps to real values, not hallucinated ones. Extract links from message; parse relative dates ("mañana", "viernes") against current date + timezone. |
| Human confirmation preview before creation | Explicit project constraint; prevents garbage tasks from bad parse | MEDIUM | Post preview as a **threaded reply** to the original message. See Confirmation UX comparison below — recommend Block Kit buttons. |
| Confirm action → create task in ClickUp | Core write path | MEDIUM | `POST /list/{list_id}/task` with name, description, assignees[], start_date, due_date (epoch ms), and custom_fields for Cliente dropdown + Link/Loom. Must set custom field value by **option UUID**, not label. |
| Cliente resolution to dropdown custom field | Real list uses a Cliente dropdown; free text won't match | MEDIUM | Fuzzy-map parsed client name → one of 7 known option UUIDs. If no confident match, surface as editable/blank in preview rather than guessing. |
| Assignee resolution (Slack user + names in text → ClickUp member IDs) | Tasks without owners defeat the visibility goal | MEDIUM | Two sources: (a) static Slack-user→ClickUp-member map for the 3–4 channel members; (b) names mentioned in text ("para Verónica") → fuzzy match against the 9 members. ClickUp assignees set by numeric user IDs. |
| Post created-task link back to thread | Closes the loop; user gets confirmation + clickable task | LOW | Reply in same thread with the task URL after creation succeeds. |
| Reverse notification: ClickUp status/assignee change → Slack | Explicit v1 requirement; channel must show task state, not just creation | MEDIUM-HIGH | Register ClickUp webhook for `taskStatusUpdated` + `taskAssigneeUpdated`. **Depends on a deployed public HTTPS endpoint** (Vercel function). Map ClickUp task → original Slack thread to reply in-thread (requires storing taskID↔channel/thread_ts). |
| Error/failure feedback in thread | Silent failures erode trust fast in a 3-person channel | LOW | If parse fails, ClickUp API errors, or confirmation times out — say so in the thread. |
| Edit before create | Parse is never perfect; users must fix cliente/assignee/date | MEDIUM | Minimum viable: a Slack modal (`views.open`) with the parsed fields pre-filled, opened from an "Edit" button. Even small teams hit mis-parses constantly. |

### Differentiators (Competitive Advantage)

Higher-value polish that aligns with Core Value but isn't strictly required for v1 validation.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Rich Block Kit preview (fields as labeled sections, not raw JSON) | Scannable preview = faster, more confident confirms | LOW-MEDIUM | Render parsed fields as Block Kit `section`/`fields`. Cheap win; do this in v1. |
| Inline edit via modal with dropdowns for Cliente/assignees | Removes ambiguity — user picks from real options, never typos | MEDIUM | `static_select` populated with the 7 Cliente options and 9 members. Stronger than free-text edit. |
| Confidence flagging on uncertain fields | Bot says "I'm unsure about cliente" → user attention where it matters | MEDIUM | Have Claude return per-field confidence or null; visually mark low-confidence fields in preview. |
| Status-change notifications scoped/filtered (only meaningful transitions) | Avoids notification spam (e.g. only "→ Complete" or assignee added) | MEDIUM | Filter webhook events server-side before posting to Slack. Critical for keeping the channel signal-rich. |
| Threaded reverse notifications (reply on original creation thread) | Keeps full task lifecycle in one Slack thread = the visibility win | MEDIUM | Requires persistent taskID→thread_ts mapping (KV/DB). Without storage, falls back to a fresh channel message. |
| Reaction-based confirm (✅ emoji to confirm instead of button) | Lowest-friction confirm for power users | LOW | `reaction_added` event as alternative to button. Nice-to-have, not instead-of buttons. |
| Idempotency / duplicate-task guard | Prevents double-creation on retries or double-clicks | LOW-MEDIUM | Disable buttons after click; dedupe on message_ts. Slack retries events on slow ack — real risk on serverless. |

### Anti-Features (Commonly Requested, Often Problematic)

Things that look reasonable but add cost/complexity with little payoff for a 3–4 person internal team. Deliberately NOT building these in v1.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Full bidirectional **edit** sync (edit task in Slack ↔ ClickUp after creation) | "Keep both in sync" | Two-way write sync = conflict resolution, loops, huge surface area for 3 people who can just open ClickUp | One-way create + read-only status notifications. Edit happens in ClickUp. |
| Slash commands / multi-channel listening / DMs | "Make it usable everywhere" | Scope explosion; project explicitly scopes to ONE dedicated channel | Single channel listener only (already an Out-of-Scope decision in PROJECT.md). |
| NL → task in **any** Slack channel | "More convenient" | Noise, accidental tasks, permission complexity | Dedicated channel is the contract. |
| Per-user OAuth / multi-workspace install | "Do it properly for scale" | Single internal team, single ClickUp workspace — OAuth flow is wasted effort | One bot token + one ClickUp API token in env vars. |
| Auto-create without confirmation ("trust the AI") | "Save the extra click" | Directly violates the human-confirmation constraint; garbage tasks | Confirmation is mandatory. Maybe add a per-message "high confidence → 1-click" later. |
| Comments/subtasks/checklists sync, attachments, custom statuses editor | "Full ClickUp parity" | Reinventing ClickUp inside Slack | Link to the task; let people use ClickUp for ClickUp things. |
| Analytics dashboard / task reporting in Slack | "Visibility!" | Premature; ClickUp already has views/dashboards | Use ClickUp dashboards; revisit only if a real need emerges. |
| Reminders / SLA escalation / recurring tasks | "Don't let tasks rot" | Scheduling infra + state machine for a tiny team | ClickUp native reminders/automations if needed. |
| Voice/audio message transcription, multi-language detection | "Cool AI feature" | Edge case; team writes text in Spanish — handle that in the prompt, don't build pipelines | Prompt Claude in/for Spanish; text-only input. |
| Self-service config UI (channel picker, field mapping admin) | "Make it configurable" | Config UI for a 3-person bot = over-engineering | Hardcode IDs in env/config (workspace, list, field, option UUIDs, member map). |

## Feature Dependencies

```
[Channel message capture]
    └──requires──> [Slack Events API + bot in channel]

[LLM parse → structured fields]
    └──requires──> [Channel message capture]
    └──requires──> [Known Cliente options + member list injected into prompt]

[Confirmation preview (Block Kit)]
    └──requires──> [LLM parse]

[Edit via modal]
    └──enhances──> [Confirmation preview]
    └──requires──> [Cliente options + members available as select choices]

[Confirm → create task]
    └──requires──> [Confirmation preview]
    └──requires──> [Cliente resolution] + [Assignee resolution]

[Post task link to thread]
    └──requires──> [Confirm → create task]

[Reverse status/assignee notification]
    └──requires──> [Deployed public HTTPS webhook endpoint (Vercel)]
    └──requires──> [ClickUp webhook registration]
    └──enhances (threaded)──> [taskID ↔ thread_ts persistent storage]

[Idempotency guard] ──enhances──> [Confirm → create task]
[Reaction confirm] ──conflicts/overlaps──> [Button confirm]  (pick buttons as primary)
```

### Dependency Notes

- **Reverse notification requires a public deployed endpoint:** ClickUp webhooks POST to a URL. This cannot be tested purely locally without a tunnel (smee.io/ngrok) and is unavailable until the Vercel function is deployed. This makes reverse-sync a **later phase** than the create path, which can be prototyped against MCP/manual triggers first.
- **Threaded reverse notifications require persistence:** To reply on the original creation thread, you must store `taskID → {channel, thread_ts}` at creation time. Without a store (Vercel KV / Upstash / simple DB), reverse notifications can only post as new channel messages. Decide storage early if threaded lifecycle is wanted.
- **LLM parse depends on real option/member data in the prompt:** Cliente dropdown (7 UUIDs) and the 9 members must be supplied so the model maps to valid values; otherwise resolution always runs as a fuzzy post-step and mis-maps more.
- **Slack 3-second ack vs. LLM latency:** Slack requires an event/interaction ack within ~3s; a Claude parse call takes longer. The bot must **ack immediately, then post the preview asynchronously** (deferred work). On Vercel this means the function must respond fast and do the LLM call in a way that finishes before the function is killed — a real architectural constraint that shapes the capture→preview feature.

## MVP Definition

### Launch With (v1)

The end-to-end create path, fully usable, single channel. This validates Core Value.

- [ ] Single-channel message capture — without it there is no bot
- [ ] Claude parse → {title, description, cliente, assignees, start/due, links} — the magic
- [ ] Block Kit threaded preview with Confirm / Edit / Cancel buttons — mandatory human gate
- [ ] Cliente resolution → dropdown option UUID — real field requirement
- [ ] Assignee resolution (static map + name-in-text fuzzy match) — ownership/visibility
- [ ] Confirm → create task in Task-Seo Team list with all fields — the write
- [ ] Post created-task link back to thread — closes the loop
- [ ] Edit via prefilled modal (Cliente + assignee as selects, dates/text editable) — parses are imperfect
- [ ] Failure feedback in thread + duplicate-create guard — trust/safety

### Add After Validation (v1.x)

Add once the create path is trusted and in daily use.

- [ ] Reverse notification: `taskStatusUpdated` + `taskAssigneeUpdated` → Slack — trigger: create path is stable AND endpoint deployed
- [ ] Threaded reverse notifications (persist taskID↔thread_ts) — trigger: reverse sync exists and threading is wanted
- [ ] Event filtering (only meaningful transitions) — trigger: notification volume becomes noisy
- [ ] Per-field confidence flagging — trigger: recurring mis-parses on specific fields

### Future Consideration (v2+)

- [ ] RIPAI meeting-summary → ClickUp (already deferred in PROJECT.md) — defer: separate input source, different pipeline
- [ ] 1-click confirm on high-confidence parses — defer: needs confidence scoring track record first
- [ ] Reaction-based confirm — defer: buttons cover the need

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Channel capture | HIGH | LOW | P1 |
| Claude NL parse → structured | HIGH | MEDIUM | P1 |
| Block Kit confirm/edit/cancel preview | HIGH | MEDIUM | P1 |
| Cliente → dropdown UUID resolution | HIGH | MEDIUM | P1 |
| Assignee resolution (map + text) | HIGH | MEDIUM | P1 |
| Create task with all fields | HIGH | MEDIUM | P1 |
| Task link back to thread | MEDIUM | LOW | P1 |
| Edit modal with selects | HIGH | MEDIUM | P1 |
| Duplicate-create guard | MEDIUM | LOW | P1 |
| Reverse status/assignee notification | HIGH | HIGH | P2 |
| Threaded reverse (persistence) | MEDIUM | MEDIUM | P2 |
| Event filtering | MEDIUM | MEDIUM | P2 |
| Per-field confidence flags | MEDIUM | MEDIUM | P3 |
| Reaction confirm | LOW | LOW | P3 |

## Confirmation UX: Thread Text vs. Block Kit Buttons

This is the central UX decision; comparing the two viable approaches.

| Criterion | Plain threaded text preview | Block Kit interactive buttons (recommended) |
|-----------|-----------------------------|---------------------------------------------|
| Confirm mechanism | User replies "ok" / reacts → bot parses reply | Click **Confirm** button (`block_actions` payload) |
| Edit mechanism | User retypes the whole message | Click **Edit** → modal (`views.open`) with prefilled, validated fields |
| Field validation | None — free text | Dropdowns enforce valid Cliente/assignee values |
| Implementation cost | LOWER (no interactivity endpoint) | MEDIUM (needs interactivity request URL + action handlers) |
| Mis-confirm risk | Higher (ambiguous "ok", parsing replies) | Lower (explicit button, can disable after click) |
| State after action | Message stays; clutter | `chat.update` collapses preview to "✅ Created: <link>" — clean |
| Idempotency | Hard (replies can repeat) | Easy (disable/replace buttons on click) |
| Fit for this team | Workable but sloppy | Best — clean, validated, low mis-fire |

**Recommendation: Block Kit buttons (Confirm / Edit / Cancel) with `chat.update` to collapse the preview after action, and a modal for Edit.** The extra cost (an interactivity endpoint + action handlers, which Slack Bolt handles natively) buys validated dropdowns for Cliente/assignees — directly attacking the hardest parse-error sources — and clean idempotent UX. Plain-text confirm is acceptable only as a throwaway prototype.

Implementation notes (verified): Bolt handles `block_actions` and `view_submission` events; default `ack` replies are ephemeral; use `chat.update` with the stored `message_ts` to mutate the preview into the final state; `replace_original`/`delete_original` available via `response_url`. Slack requires acking interactions within ~3s — open the modal / kick off work immediately, finish async.

## Competitor / Reference Feature Analysis

| Feature | Zapier/Make (ClickUp+Slack) | Native ClickUp Slack integration | Our Approach |
|---------|------------------------------|----------------------------------|--------------|
| NL → structured task | No (field-by-field mapping, no AI parse) | No (manual `/clickup new`, modal form) | Claude parses free-form text — the differentiator |
| Human confirm before create | No (auto-runs) | Form is the confirm | Threaded Block Kit preview + edit |
| Cliente dropdown resolution | Manual field mapping per zap | Manual selection in modal | AI maps + user verifies in modal select |
| Status change → Slack | Yes (templated, noisy) | Yes (per-task subscribe) | Webhook → filtered, threaded message |
| Cost/maintenance | Per-task pricing, brittle | Free but rigid forms | Self-hosted, tailored to team |

**Why build vs. buy:** Off-the-shelf tools do not do free-form NL → correctly-resolved Cliente/assignee/dates with a confirm gate. That AI parse + human-confirm loop is the entire reason to build this rather than use the native ClickUp Slack app or a Zap.

## Sources

- ClickUp Webhooks (events incl. `taskStatusUpdated`, `taskAssigneeUpdated`; create-webhook API; payloads): https://developer.clickup.com/docs/webhooks and https://developer.clickup.com/docs/webhooktaskpayloads — HIGH
- Slack Block Kit / interactive messages / ephemeral & message update: https://api.slack.com/block-kit , https://api.slack.com/interactive-messages — HIGH
- Slack Bolt basics (action handling, ack, modals): https://slack.dev/ and https://knock.app/blog/creating-interactive-slack-apps-with-bolt-and-nodejs — MEDIUM
- Project context: `.planning/PROJECT.md` (real Cliente options, members, list IDs, constraints) — HIGH
- Webhook local testing via smee.io: referenced in ClickUp docs — MEDIUM

---
*Feature research for: Slack → ClickUp AI task bot (internal team)*
*Researched: 2026-06-18*
