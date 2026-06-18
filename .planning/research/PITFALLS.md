# Pitfalls Research

**Domain:** Slack → ClickUp AI task bot on Vercel serverless (Node/TS, Bolt + Anthropic + ClickUp API)
**Researched:** 2026-06-18
**Confidence:** HIGH (Slack/ClickUp behaviors verified against official docs; serverless patterns are well-established)

## Critical Pitfalls

### Pitfall 1: Slack 3-second timeout → retries → duplicate ClickUp tasks

**What goes wrong:**
Slack's Events API requires an HTTP 2xx response within **3 seconds**. Calling Claude (parsing) and/or the ClickUp API inline before responding easily exceeds this on a cold-started Vercel function. Slack treats the slow response as a failure and **retries up to 3 times** (X-Slack-Retry-Num 1, 2, 3, with X-Slack-Retry-Reason `http_timeout`). If your handler creates the task before acking, each retry creates a **duplicate ClickUp task** — the bot's single worst failure mode.

**Why it happens:**
The naive flow is "receive event → parse with LLM → create task → respond 200." LLM calls take 1-5s, cold starts add 1-3s, ClickUp API adds latency. The team will not notice in warm-path testing; duplicates appear under real load / cold starts.

**How to avoid:**
- **Ack first, work later.** Respond 200 to Slack immediately (within the function's first lines), then do LLM/ClickUp work asynchronously. On Vercel, decouple via a queue/background invocation (e.g. Vercel Queue, a second internal function call, Upstash QStash, or `waitUntil`). With Bolt, use the `ack()`-then-process pattern; for raw events, return 200 synchronously and trigger async processing.
- **Idempotency keys on every side effect.** De-duplicate on Slack's `event_id` (stable across retries) — persist processed `event_id`s (Upstash Redis / KV with TTL) and short-circuit if already seen. Additionally short-circuit when `X-Slack-Retry-Num` is present **and** the original is already in-flight/done.
- **Idempotent task creation.** Before creating, check whether a task already exists for this Slack `message_ts` (store the mapping `message_ts → task_id`). This is the real guard — even if dedupe fails, you never create twice.

**Warning signs:**
Duplicate tasks in ClickUp; logs showing the same `event_id` processed more than once; X-Slack-Retry-Reason `http_timeout` in logs; function durations >2.5s.

**Phase to address:**
Phase: Slack ingestion / webhook foundation (must exist before any task creation). Idempotency store is a hard dependency of the "create task" phase.

---

### Pitfall 2: Slack signature verification broken by body parsing on Vercel (raw body)

**What goes wrong:**
Slack signs requests with HMAC-SHA256 over the **raw request body** (`v0:{timestamp}:{raw_body}`), checked against `X-Slack-Signature`. Vercel/Next.js (and Express `body-parser`) parse and re-serialize JSON by default, so by the time you compute the HMAC the bytes differ from what Slack signed → **every signature check fails** (or, worse, devs disable verification to "make it work").

**Why it happens:**
Serverless frameworks auto-parse JSON bodies. The raw bytes are gone before the handler runs. Re-stringifying `req.body` does not reproduce the original whitespace/ordering.

**How to avoid:**
- Disable automatic body parsing for the Slack route and read the **raw body** (Next.js App Router: `await req.text()`; Pages API: `export const config = { api: { bodyParser: false } }` and read the stream; or set Bolt's receiver to handle it).
- Compute HMAC over the exact raw string, then `JSON.parse` it yourself afterward.
- Use timing-safe comparison (`crypto.timingSafeEqual`).
- Reject requests where `X-Slack-Request-Timestamp` is older than ~5 minutes (replay protection).
- Prefer `@slack/bolt` with a Vercel-compatible receiver that handles raw body correctly rather than hand-rolling.

**Warning signs:**
All Slack requests rejected as invalid signature; "it works only when I skip verification"; signature passes locally (raw) but fails on Vercel (parsed).

**Phase to address:**
Phase: Slack ingestion / webhook foundation. Same applies to the ClickUp webhook route (see Pitfall 7).

---

### Pitfall 3: Echo / feedback loops (bot reacts to its own or ClickUp→Slack messages)

**What goes wrong:**
The bot posts a preview, a created-task link, and status notifications into the same channel/thread. If the event handler doesn't filter, the bot **re-ingests its own messages** (or the ClickUp→Slack status notifications it posts), re-parses them with Claude, and creates more tasks — an infinite loop and runaway LLM/API spend.

**Why it happens:**
`message` events fire for all messages including the bot's own. The bidirectional design (Pitfall: ClickUp→Slack notifications post into the same channel) makes the bot's outputs look like new inputs.

**How to avoid:**
- Ignore events where `bot_id` is set, `subtype` is `bot_message`, or `user` equals the bot's own user ID.
- Ignore message `subtype`s like `message_changed` / `message_deleted` unless explicitly handled.
- Post status notifications and previews using a **distinct identity** or, better, only ingest **top-level human messages** (not thread replies) for task creation — confirmations happen via interactive buttons/replies that are explicitly scoped, not via free-text re-parsing.
- Keep the create-from-message trigger separate from the confirm/notify channels logically (e.g. only parse `event.thread_ts == null` root messages from real users).

**Warning signs:**
Tasks created from the bot's own preview text; rapidly multiplying tasks; LLM token spend spikes; status notifications spawning tasks.

**Phase to address:**
Phase: Slack ingestion / event filtering — before LLM parsing is wired up. Re-verify in the bidirectional notifications phase.

---

### Pitfall 4: LLM hallucinates client/assignee not in the allowed list

**What goes wrong:**
Claude returns a `cliente` or assignee that **doesn't exist** in ClickUp — a misspelling ("Children Chick"), a plausible-but-wrong client, or a person not on the team. Sending that to ClickUp either errors (unknown option id) or, worse, silently drops the field, producing tasks with missing/incorrect client and owner — defeating the core value (correct client + assignee).

**Why it happens:**
LLMs generate fluent text, not constrained enums. Free-text messages contain nicknames, partial names ("para Vero"), or ambiguous references. Without a hard validation layer, hallucinations flow straight into the API call.

**How to avoid:**
- **Never trust the LLM's value directly.** Validate every `cliente` against the 7 real dropdown options (Felipe Vergara, Children Chic, Ultra1plus, FHCA, Delta/Nicmafia, Apturio, Interno) and every assignee against the 9 real ClickUp member IDs.
- Use **constrained generation**: pass the exact allowed lists into the prompt and request a strict JSON schema (tool/structured output) where `cliente` is an enum. Still validate server-side after — the model can ignore the enum.
- Resolve names via a deterministic map first (Slack user → ClickUp member ID from the fixed map in PROJECT.md), then fuzzy-match leftover free-text names against the member list; if no confident match, **leave unassigned and surface it in the preview** rather than guessing.
- Map dropdown **name → option UUID** in code (see Pitfall 6). If the LLM's client isn't an exact key, mark it `null` and force the human to pick in the confirmation step.
- The mandatory human preview is the safety net — but the preview must show *resolved* values (real option + real member), not the raw LLM string, so the human is confirming what will actually be sent.

**Warning signs:**
ClickUp 400 "invalid option" errors; tasks with empty Cliente; assignee silently missing; preview shows a name that isn't one of the 7/9.

**Phase to address:**
Phase: LLM parsing + validation/resolution layer (the resolver is as important as the parser). Verified in the preview/confirmation phase.

---

### Pitfall 5: Date parsing ambiguity & timezone errors (relative Spanish dates, unix ms)

**What goes wrong:**
ClickUp native `start_date`/`due_date` expect **Unix time in milliseconds**. Messages use relative Spanish dates ("para el viernes", "mañana", "fin de mes"). Two failure modes: (a) computing "viernes" relative to the **server's UTC clock** instead of the team's timezone produces off-by-one-day errors (a task due Friday lands Thursday night / Saturday); (b) sending seconds instead of milliseconds, or an ISO string, makes ClickUp reject or misplace the date (year 1970).

**Why it happens:**
Vercel functions run in **UTC**. "Tomorrow" computed at 23:00 local is already "two days out" in UTC. LLMs also happily emit ISO strings or second-precision timestamps. ClickUp's `due_date_time` boolean further changes whether time-of-day is honored.

**How to avoid:**
- Pin a **single team timezone** (from PROJECT.md context) and do all relative-date resolution in that zone (use `luxon`/`date-fns-tz`), then convert to epoch **ms**.
- Don't let the LLM compute the absolute date. Have it extract the *phrase* ("viernes") + intent; resolve to a concrete date deterministically in code against `now` in the team TZ. LLMs are unreliable at date arithmetic.
- Always send **milliseconds** (multiply by 1000 if you have seconds); set `due_date_time`/`start_date_time` consistently with whether a time was specified.
- Show the resolved absolute date (e.g. "vie 20 jun 2026") in the preview so the human catches off-by-one before creation.

**Warning signs:**
Tasks due one day early/late; dates in 1970; weekend due dates from "viernes"; dates shifting depending on what time of day the message was sent.

**Phase to address:**
Phase: LLM parsing + date resolution. Verified in preview phase (human sees absolute date).

---

### Pitfall 6: ClickUp custom-field set by option name instead of option id

**What goes wrong:**
Setting the **Cliente** dropdown requires the option's **UUID**, not its label. Posting `{"value": "FHCA"}` fails or no-ops; you must post the option `id`. Devs discover their client field is always empty because they sent the human-readable name.

**Why it happens:**
The ClickUp UI shows names; the API uses UUIDs per option. This is a well-documented ClickUp gotcha (dropdown/label fields take the option UUID, not value).

**How to avoid:**
- Fetch and **cache the field's option map** (name → option UUID) for field id `05ebdc8a-4736-404d-9132-3ab32875e1f1` at startup/build, and resolve the validated client name to its UUID before the `Set Custom Field Value` call.
- Treat the cached map as source of truth for validation (Pitfall 4) too — one fetch serves both.
- Refresh the cache if a 400 "invalid option" occurs (options may have been added/renamed in ClickUp), and re-validate.
- Same applies to other dropdowns you may set (Task Type, Department): id, not name.

**Warning signs:**
Cliente field blank on created tasks despite "success"; 400 errors referencing the custom field; works for some clients but not others (stale/missing UUID).

**Phase to address:**
Phase: ClickUp task creation / field mapping. Build the option-map fetch early; reuse in validation.

---

### Pitfall 7: ClickUp webhook signature not verified / not handled with raw body + no secret rotation

**What goes wrong:**
The ClickUp→Slack notification path relies on a ClickUp webhook. ClickUp signs payloads with **HMAC-SHA256 over the raw body** in the `X-Signature` header. If unverified, anyone can POST forged status changes into your channel; if verified against a **re-parsed** body (same raw-body trap as Pitfall 2), every legit event is rejected. Hardcoding the single secret with no rotation plan means a leak forces downtime.

**Why it happens:**
Same Vercel body-parsing issue as Slack. Secret rotation is an afterthought; ClickUp's secret is delivered once at webhook creation and easily lost/committed.

**How to avoid:**
- Verify `X-Signature` = HMAC-SHA256(raw_body, webhook_secret) with timing-safe compare, reading the **raw body** before parsing.
- Store the secret in Vercel env vars (never in code/repo).
- Support **dual secrets** during rotation: accept old OR new for an overlap window, then revoke old. Plan this from the start even if rotation is rare.
- Make webhook handling idempotent too — ClickUp can redeliver; dedupe on event id and ignore status changes the bot itself triggered (ties back to echo loops, Pitfall 3).

**Warning signs:**
Forged/spam notifications; all webhook events rejected; secret committed to git; no way to rotate without breaking prod.

**Phase to address:**
Phase: Bidirectional notifications (ClickUp → Slack webhook). Reuse the raw-body utility from Slack phase.

---

### Pitfall 8: Confirmation state lost on cold starts / stateless functions

**What goes wrong:**
The flow is: post preview → wait for human "confirm" → create task. If the parsed task draft is held **in function memory** (a module variable or in-process map), a cold start, a different function instance, or function recycling between the preview and the confirmation click **loses the draft** — confirmation does nothing, or recreates by re-parsing (re-introducing hallucination risk and cost).

**Why it happens:**
Serverless functions are stateless and ephemeral; there is no shared memory across invocations. The preview and the confirm click are two separate HTTP requests that may hit different instances minutes apart.

**How to avoid:**
- Persist the parsed draft in **external storage** (Upstash Redis/KV, Postgres) keyed by Slack `message_ts`/thread, with a TTL, when posting the preview.
- Better: embed the draft (or its storage key) in the interactive component's `value`/`block_id` / `private_metadata` of the Slack message, so the confirmation callback carries everything needed.
- On confirm, load the draft by key and create the task — **do not re-run the LLM**. Mark the draft consumed to prevent double-confirm (ties to idempotency, Pitfall 1).

**Warning signs:**
"Confirm" button does nothing after a delay; tasks created with different data than the preview showed; confirmations work immediately but fail after a few minutes (instance recycled).

**Phase to address:**
Phase: Preview/confirmation flow. Depends on the same persistence layer as the idempotency store.

---

### Pitfall 9: Secrets in serverless env & rate-limit / cost blind spots

**What goes wrong:**
Anthropic, Slack, and ClickUp tokens leak via committed `.env`, client-side bundles, or logs. Separately: ClickUp API rate limits (~100 req/min/token on lower tiers), Slack Web API tiers, and Anthropic rate/cost limits get hit when echo loops (Pitfall 3) or retries (Pitfall 1) amplify calls — causing 429s and runaway spend.

**Why it happens:**
Serverless makes env management implicit; devs paste keys into code for speed. Rate limits feel distant in a 3-person channel — until a loop multiplies calls.

**How to avoid:**
- All secrets in Vercel env vars, scoped per environment; never in repo or client bundle; never log full tokens.
- Use the official Anthropic SDK for parsing only on root human messages; cap retries; set a per-message LLM budget.
- Handle ClickUp/Slack 429 with `Retry-After` backoff; the idempotency + ack-first design naturally limits call volume.
- Add a simple kill switch / per-channel rate cap to bound spend if a loop slips through.

**Warning signs:**
429 responses; unexpected Anthropic billing; tokens visible in logs or git history; bursts of API calls from a single message.

**Phase to address:**
Phase: Foundation (env/secrets) + revisited in each integration phase (rate-limit handling per API).

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Process LLM/ClickUp inline before acking Slack | Simpler single-function flow | Duplicate tasks under cold starts/retries | Never (breaks core value) |
| In-memory draft/dedupe store | No external dependency to set up | Lost confirmations & duplicates on cold starts | Only throwaway local demo |
| Skip signature verification "to unblock" | Fast local testing | Open endpoint; forged tasks/notifications | Never in any deployed env |
| LLM emits absolute dates directly | One fewer code step | Timezone off-by-one, 1970 dates | Never (LLM date math unreliable) |
| Set dropdown by name | Reads naturally | Empty Cliente field silently | Never (API needs UUID) |
| Single hardcoded webhook secret, no rotation path | Ships faster | Downtime on any leak | MVP only if rotation code stubbed in |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Slack Events API | Working before acking → 3s timeout retries | Ack 200 immediately, process async; dedupe on `event_id` |
| Slack signature | HMAC over re-parsed JSON | HMAC over raw body bytes; timing-safe compare; reject old timestamps |
| Slack messages | Re-ingesting bot's own posts | Filter `bot_id`/own user ID; only parse root human messages |
| ClickUp dropdown | Sending option name | Send option **UUID** from cached name→id map |
| ClickUp dates | Seconds or ISO string | Unix **milliseconds**, resolved in team timezone |
| ClickUp webhook | No/forged signature; redelivery | Verify `X-Signature` over raw body; idempotent handling; dual-secret rotation |
| Anthropic | Trusting output enums | Re-validate client/assignee server-side against real lists |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Cold-start latency inside 3s window | http_timeout retries, duplicates | Ack-first + async processing | Immediately under cold starts |
| Echo loop amplifying LLM/API calls | Token spend spike, 429s, multiplying tasks | Self-message filtering + per-channel cap | First time bot output re-ingested |
| No backoff on 429 | Cascading failures during bursts | Respect `Retry-After`, queue work | At ClickUp ~100 req/min |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Unverified Slack/ClickUp webhooks | Forged tasks & notifications, spoofed status | HMAC verification over raw body, timing-safe, replay window |
| Secrets in repo/client/logs | Token theft, full workspace access | Vercel env vars only; never log tokens; scan git history |
| No replay protection | Captured request replayed | Reject `X-Slack-Request-Timestamp` older than 5 min |
| No secret rotation path | Forced downtime on leak | Dual-secret acceptance window |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Preview shows raw LLM strings, not resolved values | Human confirms a client/date that won't actually be set | Preview must show resolved option + real member + absolute date |
| Silent field drop on invalid client/assignee | Task created looking fine but missing client/owner | Block creation; force human pick in preview |
| Off-by-one due dates | Missed deadlines, distrust of bot | Resolve relative dates in team TZ; show absolute date |
| No feedback on failure | User thinks task created when it errored | Post explicit success (with link) or failure in thread |

## "Looks Done But Isn't" Checklist

- [ ] **Task creation:** Often missing idempotency — verify same Slack `message_ts` never creates two tasks (replay the event)
- [ ] **Signature check:** Often missing raw-body handling — verify it passes on deployed Vercel, not just locally
- [ ] **Client mapping:** Often missing UUID resolution — verify Cliente is actually populated on the created task, not blank
- [ ] **Date handling:** Often missing timezone — verify "viernes" sent at 11pm lands on the right day in ms
- [ ] **Echo filter:** Often missing — verify bot's own preview/notification doesn't spawn a task
- [ ] **Confirmation:** Often missing persistence — verify confirm still works after a cold start / minutes later
- [ ] **Validation:** Often missing — verify a hallucinated client name is rejected, not silently dropped
- [ ] **Webhook:** Often missing dedupe — verify a redelivered ClickUp event doesn't double-notify

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Duplicate tasks already created | MEDIUM | Add message_ts→task_id guard; bulk-dedupe existing tasks in ClickUp; backfill idempotency store |
| Signature verification failing in prod | LOW | Switch route to raw-body read; verify with a sample signed payload |
| Echo loop in the wild | LOW | Deploy self-message filter + kill switch; clean up junk tasks |
| Empty Cliente fields | LOW | Build name→UUID map; re-patch affected tasks via API |
| Wrong-day due dates | MEDIUM | Fix TZ resolution; identify affected tasks by creation window; correct dates |
| Lost confirmations | MEDIUM | Move drafts to KV/embed in interaction payload; redeploy |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| 3s timeout → duplicates (idempotency) | Slack ingestion foundation | Replay same event_id → one task |
| Signature / raw body (Slack) | Slack ingestion foundation | Signed payload passes on Vercel |
| Echo / feedback loops | Slack ingestion (event filtering) | Bot's own message ignored |
| LLM hallucinated client/assignee | LLM parsing + validation/resolution | Invalid name rejected, surfaced in preview |
| Date/timezone (unix ms) | LLM parsing + date resolution | Relative date → correct absolute ms in team TZ |
| Dropdown by id not name | ClickUp creation / field mapping | Cliente populated on created task |
| ClickUp webhook signature + rotation | Bidirectional notifications | Forged event rejected; rotation tested |
| Confirmation state on cold start | Preview/confirmation flow | Confirm works after cold start |
| Secrets / rate limits | Foundation + per-integration | No secrets in repo; 429 backoff works |

## Sources

- [Slack Events API — 3s timeout, X-Slack-Retry-Num/Reason, idempotency](https://docs.slack.dev/apis/events-api/) (HIGH)
- [Slack serverless 3-second timeout pattern (ack-first/async)](https://medium.com/@geetansh2k1/scalable-serverless-slack-bot-design-avoid-slacks-3-second-timeout-with-aws-lambda-sqs-7c91367c161d) (MEDIUM)
- [Preventing Slack Event API retry duplicate processing](https://dev.to/takakd/go-prevent-slack-event-api-retry-call-n3d) (MEDIUM)
- [ClickUp Webhook Signature (X-Signature, HMAC-SHA256 raw body)](https://developer.clickup.com/docs/webhooksignature) (HIGH)
- [ClickUp Set Custom Field Value (dropdown by option UUID)](https://developer.clickup.com/reference/setcustomfieldvalue) (HIGH)
- [ClickUp dropdown requires option UUID not value](https://community.make.com/t/modify-a-custom-field-in-clickup-which-uses-uuid-dropdown-label-etc/13351) (MEDIUM)
- [ClickUp secure webhooks / secret rotation guidance](https://consultevo.com/clickup-secure-webhook-signatures/) (MEDIUM)
- [HMAC webhook signature verification best practices](https://hooksense.com/blog/webhook-security-hmac-best-practices) (MEDIUM)
- Slack signature raw-body / Vercel body-parser behavior, serverless statelessness — established platform behavior (HIGH, training + docs)

---
*Pitfalls research for: Slack → ClickUp AI task bot on Vercel serverless*
*Researched: 2026-06-18*
