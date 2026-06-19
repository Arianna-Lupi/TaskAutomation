# Phase 5: Hardening - Context

**Gathered:** 2026-06-18
**Status:** Ready for planning
**Mode:** Auto-generated (autonomous smart-discuss)

<domain>
## Phase Boundary

Production resilience for the whole bot: parse/create failures surface clearly in the Slack thread instead of failing silently, ClickUp rate limits (429) are retried with backoff, webhook redeliveries are ignored (mostly done in Phase 4 — verify/extend), and the bot can be disabled per channel without a redeploy.

In scope: in-thread error reporting across the capture→parse→preview→create and webhook paths; a ClickUp `fetch` wrapper with 429 backoff + retry; a per-channel kill switch readable at runtime; and tests for each.

Out of scope: new features, observability dashboards, multi-channel support.
</domain>

<decisions>
## Implementation Decisions

### HARD-01 — In-thread error reporting (no silent failure)
- Wherever the bot does meaningful work and can fail, on error post a clear Spanish message in the originating thread instead of swallowing it silently:
  - Parse failure (OpenAI ParseError / malformed): `⚠️ No pude interpretar el mensaje. Reformúlalo o crea la tarea manualmente.` in the thread.
  - ClickUp create failure (after retries): `⚠️ No pude crear la tarea en ClickUp (<status>). Intenta de nuevo.` in the thread, and do NOT consume the pending silently — keep it recoverable where safe (note: Phase 3 made create the point of no return only on success; a create FAILURE before/at createTask should report + allow retry).
  - Generic unexpected error in the capture path: a short `⚠️ Algo falló procesando tu mensaje.` so the user never sees dead silence.
- Keep these best-effort (never throw into the ACK/waitUntil boundary). Centralize a small `reportErrorToThread(client, channel, threadTs, message)` helper.

### HARD-02 — Rate limits + redelivery
- Wrap the ClickUp `fetch` calls (createTask, getTask, set-field) in a retry helper: on HTTP 429, read `Retry-After` header (seconds) if present else exponential backoff (e.g. 1s, 2s, 4s) with a small max attempts (e.g. 3); on 5xx also retry; on persistent failure throw a typed error the caller reports via HARD-01. Add jitter.
- Webhook redelivery dedup already exists (Phase 4 `markWebhookDeliveryOnce`) — verify it's wired and add any missing coverage; also confirm Slack event dedup (Phase 1) covers Slack retries. No duplicate work, just confirm + fill gaps.

### HARD-03 — Per-channel kill switch (no redeploy)
- A runtime-checked switch that disables the bot for a given channel without redeploying. Implement via Redis: key `killswitch:<channelId>` (or a global `killswitch:all`). At the start of the capture path (and optionally interactions), check the switch; if set, the bot does nothing (optionally a one-time quiet log). 
- Provide a tiny ops mechanism to flip it: a documented Redis command and/or a small script `scripts/killswitch.mjs <channelId> on|off`. No UI.
- Default: off (absent key = enabled). Reading uses the existing Redis client; make it cheap (single GET) and fail-open is acceptable (if Redis is down, don't hard-block message processing — but log).

### Testing
- HARD-01: simulate parse error + ClickUp create error (mocked) → assert the Spanish thread message is posted, no throw.
- HARD-02: mock fetch returning 429 with Retry-After then 200 → assert retried and succeeded; 429×N → typed failure; assert backoff respects Retry-After (use injected sleep/now so tests are fast and deterministic).
- HARD-03: killswitch set for a channel → capture path no-ops (no parse, no preview); absent → normal; Redis-down → fail-open (still processes) with a log. Test the script logic if extracted into a pure function.

### Claude's Discretion
Exact backoff numbers/jitter, whether the kill switch also gates interactions/webhook, helper placement, script ergonomics. Keep changes surgical — this phase hardens existing code, it does not rewrite it.
</decisions>

<code_context>
## Existing Code Insights

Touch points: `src/slack/process.ts` (capture/parse path — add killswitch check + parse-error reporting), `src/slack/interactions.ts` (create-failure reporting — note Phase 3 already best-effort-continues post-create; this adds user-facing messaging on create FAILURE), `src/clickup/client.ts` (wrap fetch with the 429/backoff retry helper), `src/store/redis.ts` (killswitch get/set helpers, reuse), `src/clickup/webhook.ts` (already best-effort; confirm dedup). Reuse the injected Slack client + Redis. Match DI + test style. Inject a `sleep`/clock into the retry helper for deterministic tests.
</code_context>

<specifics>
## Specific Ideas

- The kill switch is the operational safety valve Arianna/Verónica/Juan need if the bot misbehaves in the live channel — make flipping it a one-liner (script or documented Redis SET) and document it in the README.
- Error messages are Spanish and actionable (tell the human what to do: reformulate, retry, or create manually).
- Keep it surgical: wrap and guard existing code, do not refactor working Flow A/B logic.
</specifics>

<deferred>
## Deferred Ideas

- Structured logging / metrics / alerting and an admin UI are out of v1 scope.
</deferred>
