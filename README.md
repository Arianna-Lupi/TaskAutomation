# Slack → ClickUp Task Bot

Turn a free-form Slack message into a correct, complete ClickUp task (client + assignee + dates) without filling forms by hand. Deployed as a Vercel serverless function (Node 20, TypeScript, ESM) with **Fluid Compute** enabled so Slack's 3-second ACK is met while real work runs in the background via `waitUntil`.

**Phase 1 (this milestone) — Serverless Foundation:** a deployed Slack Events endpoint that verifies Slack's HMAC over the raw body, ACKs within 3s, deduplicates retries on `event_id` (Upstash Redis), ignores bot/own/non-root/other-channel messages, and posts an in-thread receipt on a captured human message. No LLM or ClickUp logic yet.

## Stack

- `@slack/bolt@^4` + `@vercel/slack-bolt@^1.5` — Slack framework + official Vercel adapter (ACK-then-`waitUntil`, raw-body signature verification).
- `@vercel/functions` — `waitUntil` primitive for background work after the fast ACK.
- `@upstash/redis` — serverless-safe REST client for event dedup and later-phase state. **Vercel KV is sunset — not used.**
- `zod` — fail-fast env validation (and runtime guard in later phases).
- `typescript`, `vitest` — strict TS + fast TS-native test runner.

## Layout

- `api/` — thin Vercel function handlers (Slack Events ingress).
- `src/config/` — `env.ts` (zod-validated, fail-fast env contract).
- `src/store/` — `redis.ts` (Upstash client + `markEventOnce` dedup helper).
- `src/slack/` — `filter.ts`, `process.ts`, `app.ts` (framework-free domain + Bolt wiring).
- Tests are colocated as `*.test.ts` and run by Vitest; integration tests build signed requests and inject fakes — no live services needed.

## Environment

Copy `.env.example` to `.env.local` and fill in real values. All vars are validated at startup; a missing/empty required var fails fast with a clear error.

| Variable | Where it comes from |
|----------|---------------------|
| `SLACK_BOT_TOKEN` | Slack API → Your App → OAuth & Permissions (Bot User OAuth token `xoxb-...`). |
| `SLACK_SIGNING_SECRET` | Slack API → Your App → Basic Information → App Credentials. |
| `SLACK_TASK_CHANNEL_ID` | The dedicated channel ID (`C...`) the bot listens to. |
| `UPSTASH_REDIS_REST_URL` | Vercel Marketplace → Upstash Redis integration (or Upstash console → REST API). |
| `UPSTASH_REDIS_REST_TOKEN` | Same source as the URL. |
| `TEAM_TIMEZONE` | Team timezone for later-phase date resolution (default `America/Caracas`). |
| `CLICKUP_API_TOKEN` | ClickUp → Settings → Apps → API Token (raw personal/OAuth token, not `Bearer`-prefixed). |
| `CLICKUP_LIST_ID` | Destination list (Task-Seo Team); defaults to `901327239630`. |
| `CLICKUP_WEBHOOK_SECRET` | Returned by the one-time webhook registration (see below). Verifies ClickUp's `X-Signature` over the raw body. |
| `CLICKUP_TEAM_ID` | Workspace/team id used by the registration script; defaults to `90131720021`. |

## Vercel setup

1. **Enable Fluid Compute** — Vercel Project → Settings → Functions → Fluid Compute. Required for `waitUntil` background work after the ACK.
2. **Provision Upstash Redis** — Vercel Marketplace → Upstash Redis integration; copy `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` into the project env vars.
3. Set the Slack env vars (`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_TASK_CHANNEL_ID`, `TEAM_TIMEZONE`) in Project → Settings → Environment Variables.
4. Deploy, then set the Slack app's Event Subscriptions Request URL to `<deploy-url>/api/slack/events` and subscribe to `message.channels`.

## ClickUp webhook registration (one-time, after deploy)

Flow B (reverse notifications) needs a ClickUp webhook pointing at the deployed
`/api/clickup/webhook` endpoint. This is run **once by a human after deploy** — it
needs the live public URL and the ClickUp API token, so it is live-deferred (the core
logic is fully verified offline).

The webhook is registered for the two events `taskStatusUpdated` and
`taskAssigneeUpdated` against team `90131720021`. ClickUp returns a signing **secret**
on creation; store it as `CLICKUP_WEBHOOK_SECRET` so the `X-Signature` verifier
(`src/clickup/signature.ts`) can authenticate each delivery over the raw body.

```bash
# Prereqs: CLICKUP_API_TOKEN set; the app deployed (you have its public URL).
CLICKUP_API_TOKEN=pk_xxx \
  node scripts/register-clickup-webhook.mjs https://<deploy-url>/api/clickup/webhook

# CLICKUP_TEAM_ID defaults to 90131720021; override it if your workspace differs:
# CLICKUP_API_TOKEN=pk_xxx CLICKUP_TEAM_ID=12345 \
#   node scripts/register-clickup-webhook.mjs https://<deploy-url>/api/clickup/webhook
```

The script prints the new webhook `id` and `secret`. Copy the **secret** into Vercel
(Project → Settings → Environment Variables → `CLICKUP_WEBHOOK_SECRET`) and redeploy.
After that, a real status or assignee change on a bot-created task posts a Spanish
notification into the originating Slack thread.

## Kill switch (per-channel, no redeploy)

Operational safety valve (HARD-03) for when the bot misbehaves in the live
channel. The bot checks a Redis key at the very top of its capture path, so
flipping it takes effect on the next message with **no redeploy**:

- `killswitch:<channelId>` — disables the bot for that one channel.
- `killswitch:all` — global override; disables the bot for **every** channel.
- **Absent key = enabled** (default off). An active switch makes a captured
  message a no-op (no parse, no preview, no spend).
- The check **fails open**: if Redis is unreachable the bot keeps processing and
  logs — availability over a fail-closed outage.

Flip it with the bundled script (uses the same `UPSTASH_REDIS_REST_URL` /
`UPSTASH_REDIS_REST_TOKEN` env vars; dependency-free, global `fetch` only):

```bash
node scripts/killswitch.mjs C0123ABC on    # disable the bot in channel C0123ABC
node scripts/killswitch.mjs C0123ABC off   # re-enable it
node scripts/killswitch.mjs all on         # disable EVERY channel (global)
node scripts/killswitch.mjs all off        # clear the global override
```

Equivalent raw Upstash REST command (what the script does under the hood):

```bash
# ON  — disable:
curl -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  "$UPSTASH_REDIS_REST_URL/SET/killswitch:C0123ABC/1"
# OFF — re-enable:
curl -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  "$UPSTASH_REDIS_REST_URL/DEL/killswitch:C0123ABC"
```

## Dynamic config (v1.1)

The Cliente options and team members are read live from ClickUp and cached in
Redis instead of being hardcoded. Add a client or a teammate in ClickUp and it
shows up in the bot with no redeploy.

How it stays fresh:

- The cache has a ~10 minute TTL. After a client or member is added or renamed in
  ClickUp, the change appears automatically once the cache expires.
- Need it sooner? Hit the manual refresh endpoint, which clears the hot cache so
  the next message re-reads ClickUp:

  ```
  curl -X POST -H "Authorization: Bearer $OPS_API_TOKEN" \
    https://<DEPLOY_URL>/api/admin/refresh-config
  ```

  The ops endpoints are gated by an optional `OPS_API_TOKEN` env var (set it to a
  random 32+ char value, e.g. `openssl rand -hex 24`). When it is unset, both
  `/api/admin/refresh-config` and `/api/slack/diag` return 404, so there is no
  ops surface until you turn it on. When it is set, every call must carry
  `Authorization: Bearer $OPS_API_TOKEN` (timing-safe compare). The Slack signing
  secret is no longer reused for this. The refresh is POST-only and returns a
  `clearedCount`, not the key names. The non-expiring "last good" copies stay in
  place as the fallback, so a refresh never leaves the bot without config.

  The diag endpoint follows the same gate:

  ```
  # Health report (counts/booleans only):
  curl -H "Authorization: Bearer $OPS_API_TOKEN" https://<DEPLOY_URL>/api/slack/diag

  # Make the bot join the configured task channel (POST only):
  curl -X POST -H "Authorization: Bearer $OPS_API_TOKEN" https://<DEPLOY_URL>/api/slack/diag
  ```

  The POST self-join only ever joins the configured `SLACK_TASK_CHANNEL_ID`; it
  cannot be pointed at an arbitrary channel.

If ClickUp or Redis is unavailable, the bot falls back to the last good cache and
then to the static maps in the repo, so parsing never breaks.

### Assignee resolution by email (one-time Slack setup)

To map an @-mentioned teammate to the right ClickUp assignee by email, the bot
needs to read Slack user emails. Add the `users:read.email` bot scope and
reinstall the app:

1. Slack API dashboard → your app → OAuth & Permissions → Scopes → Bot Token
   Scopes → add `users:read.email`.
2. Reinstall the app to the workspace so the new scope takes effect.

Without that scope the bot still works: it falls back to name/alias resolution
and the static Slack→member map, so nothing breaks if you skip this step.

## Develop

```bash
npm install
npm test          # vitest run
npm run typecheck # tsc --noEmit (strict)
```
