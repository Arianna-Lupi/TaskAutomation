# Stack Research

**Domain:** Slack ↔ ClickUp NL-to-task bot on Vercel serverless (Node/TypeScript)
**Researched:** 2026-06-18
**Confidence:** HIGH (versions verified against npm registry + official docs)

## Executive Recommendation

Use **Slack Bolt for JS (v4) deployed through the official `@vercel/slack-bolt` adapter**. This is the single most important decision: the adapter exists specifically to solve Slack's 3-second ack requirement on serverless by leveraging Vercel **Fluid Compute** + `waitUntil`. It acknowledges Slack within the deadline and keeps your handler running in the background — no external queue, no AWS SQS, no second service to maintain. This is the 2025/2026 standard path and directly matches the project's "Vercel serverless, no server to maintain" constraint.

For NL parsing, use the **official `@anthropic-ai/sdk` with forced tool use** (a single tool whose Zod input schema = your task shape) — not free-text JSON parsing. For ClickUp, use **plain `fetch` against the REST v2 API** (no SDK worth adopting) plus **HMAC-SHA256 webhook signature verification** on the inbound ClickUp → Slack path.

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `@slack/bolt` | `4.7.3` | Slack event/interaction framework | Mature standard for Slack bots; v4 has the Web-API `Request`-object receiver the Vercel adapter needs; handles Slack signature verification internally (you only supply `SLACK_SIGNING_SECRET`). |
| `@vercel/slack-bolt` | `1.5.0` | Vercel adapter for Bolt | **The 3-second-ack solution.** Official Vercel package. Wraps Bolt to ack within Slack's deadline, then continues handler work in background via Fluid Compute `waitUntil`. Framework-agnostic (works with bare Vercel Functions, Hono, Next.js). Peer-requires `@slack/bolt ^4.4.0`. |
| `@anthropic-ai/sdk` | `0.105.0` | Claude NL → structured task | Official SDK, actively shipped (published days ago). Use **forced tool use** for reliable structured extraction of title/description/cliente/assignees/dates/links. Far more robust than asking for raw JSON. |
| ClickUp REST API v2 | n/a (HTTP) | Create tasks, set custom fields, read members/options | No mature, maintained official Node SDK — use `fetch`. v2 is the current stable, fully documented surface (`/list/{id}/task`, `/task/{id}`, custom fields, webhooks). |
| `@vercel/functions` | `3.7.1` | `waitUntil` primitive | Provides `waitUntil()` for any background work the adapter doesn't already cover (e.g. ClickUp webhook → Slack post path, which is NOT a Bolt handler). |
| `zod` | `4.4.3` | Schema for Claude tool input + runtime validation | Peer dep of the Anthropic SDK's `betaZodTool` helper; doubles as runtime guard before you trust LLM output and before hitting ClickUp. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@slack/web-api` | bundled w/ Bolt `4.x` | Posting thread replies, preview Block Kit messages, fetching user info | Already a transitive dep of Bolt — import via `app.client`, don't install separately. |
| `typescript` | `^5.6` | Types | Always. |
| `@types/node` | `^22` | Node types on Vercel runtime | Always (Vercel Node 22 runtime). |
| Node built-in `crypto` | n/a | ClickUp `X-Signature` HMAC-SHA256 verify + timing-safe compare | Inbound ClickUp webhook handler. No library needed — `crypto.createHmac` + `crypto.timingSafeEqual`. |

> **Do NOT add a queue (SQS/Redis/Inngest) for v1.** The Bolt-on-Slack path is handled by the adapter; the ClickUp→Slack path is a short HTTP POST. Both fit comfortably inside one Fluid-Compute invocation. Add a durable queue only if you later need retries/guaranteed delivery.

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| Vercel CLI (`vercel`) | Local dev + deploy | `vercel dev` runs functions locally; `vercel env pull` syncs secrets to `.env.local`. |
| ngrok / Vercel preview URL | Expose endpoint to Slack & ClickUp during dev | Slack Events + ClickUp webhooks need a public HTTPS URL; use a preview deployment URL rather than ngrok if possible (stable). |
| ClickUp MCP + Slack MCP | Already in this environment | Use for prototyping/reading real IDs (Cliente options, member IDs) — not for production runtime. |

## Vercel Serverless Constraints — How Each Is Satisfied

| Constraint | Solution | Confidence |
|------------|----------|------------|
| **Slack 3-second ack** | `@vercel/slack-bolt` acks immediately, runs handler in background via `waitUntil`. The preview-in-thread post and the Claude parse happen *after* ack. | HIGH |
| **Function ends after HTTP response (kills async work)** | **Enable Fluid Compute** in project settings. With Fluid + `waitUntil`, the function keeps executing after the response is sent until background promises settle (bounded by `maxDuration`). | HIGH |
| **Cold starts** | Fluid Compute reuses warm instances across invocations, sharply reducing cold-start frequency vs classic serverless. Keep deps lean; lazy-init the Anthropic client. | MEDIUM |
| **maxDuration** | Set `maxDuration` (e.g. 60–300s) in function config. Claude parse + ClickUp create is well under this. `waitUntil` work is capped at the function timeout — keep handlers short. | HIGH |
| **Raw body for signature checks** | Slack signature: Bolt/adapter handle it (needs the raw request, which the adapter's `Request`-object receiver provides). ClickUp webhook: read the **raw text body** (`await req.text()`) *before* JSON-parsing — HMAC must run on the exact bytes. | HIGH |

### Two distinct endpoints (architecturally important)

1. **`/api/slack`** — Slack → bot. Handled by `@vercel/slack-bolt`. Bolt verifies Slack signature; ack-then-process pattern. Flow: capture message → Claude parse → post Block Kit preview in thread → on confirm button, create ClickUp task → post task link in thread.
2. **`/api/clickup-webhook`** — ClickUp → Slack. **Plain Vercel function, NOT Bolt.** Verify `X-Signature` (HMAC-SHA256 of raw body with webhook secret, hex, `timingSafeEqual`). Respond `200` fast, then `waitUntil(postToSlack())` for the status/assignee-change notification.

## Anthropic Structured-Parsing Pattern (prescriptive)

Force a single tool so Claude must return a typed object — do not parse free text.

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

// Zod schema drives both the tool input_schema and runtime validation.
const TaskSchema = z.object({
  title: z.string(),
  description: z.string(),
  cliente: z.enum([
    "Felipe Vergara","Children Chic","Ultra1plus","FHCA",
    "Delta/Nicmafia","Apturio","Interno",
  ]).nullable(),                       // map to Cliente dropdown option id
  assignee_names: z.array(z.string()), // resolve to ClickUp member ids in code
  start_date: z.string().nullable(),   // ISO; convert to epoch ms for ClickUp
  due_date: z.string().nullable(),
  links: z.array(z.string().url()),
});
```

- Call `messages.create` with `tools: [{ name: "create_task", input_schema: <jsonSchema(TaskSchema)> }]` and `tool_choice: { type: "tool", name: "create_task" }`.
- The SDK's `betaZodTool` helper (`@anthropic-ai/sdk/helpers/beta/zod`) can generate the schema and type the result, but a hand-written `input_schema` + `tool_choice` is the stable, GA-safe approach.
- **Constrain `cliente` to the 7 real options in the enum** so Claude can't invent a client; do the same conceptually for assignees but resolve names → IDs in your own code against the fixed Slack→ClickUp map (LLMs should not emit raw IDs).
- **Model:** default to **`claude-sonnet-4-5`** for best Spanish comprehension + fuzzy name/date resolution; switch to **`claude-haiku-4-5`** if cost/latency matters and accuracy holds (this is a small, well-scoped extraction task). Both are GA as of June 2026.

## ClickUp specifics (verified)

- **Create task:** `POST https://api.clickup.com/api/v2/list/901327239630/task` (your "Task- Seo Team" list), `Authorization: <token>` header.
- **Dates:** `due_date` / `start_date` are **Unix epoch milliseconds**; set `due_date_time: true` only if time-of-day matters.
- **Assignees:** `assignees: [<userId>, ...]` (numeric ClickUp user IDs — resolve from your fixed map + names from text).
- **Dropdown custom field (Cliente, id `05ebdc8a-4736-404d-9132-3ab32875e1f1`):** value must be the **option UUID** from `type_config.options[].id`, **not** the orderindex:
  ```json
  "custom_fields": [
    { "id": "05ebdc8a-4736-404d-9132-3ab32875e1f1", "value": "<option-uuid>" }
  ]
  ```
  Fetch the option UUIDs once via `GET /list/{list_id}/field` and hardcode the 7 name→UUID map (or read at startup).
- **Link/Loom field:** url-type custom field — `{ "id": "<field-id>", "value": "https://..." }`.
- **Webhooks:** create via `POST /team/{team_id}/webhook` with events `taskStatusUpdated`, `taskAssigneeUpdated` (and `taskUpdated` as a catch-all). The create response returns the **`secret`** used to verify `X-Signature`.

## ClickUp webhook verification pattern

```typescript
import crypto from "node:crypto";
// read RAW body first
const raw = await req.text();
const sig = req.headers.get("x-signature") ?? "";
const expected = crypto.createHmac("sha256", process.env.CLICKUP_WEBHOOK_SECRET!)
  .update(raw).digest("hex");
const ok = sig.length === expected.length &&
  crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
if (!ok) return new Response("invalid signature", { status: 401 });
```

## Secret / Env Management

| Secret | Where | Notes |
|--------|-------|-------|
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` | Vercel Project Env Vars | Pull locally with `vercel env pull`. Signing secret used by Bolt for Slack signature verification. |
| `ANTHROPIC_API_KEY` | Vercel Project Env Vars | Lazy-init the client to help cold starts. |
| `CLICKUP_API_TOKEN` | Vercel Project Env Vars | Personal token (`pk_...`) or OAuth token for the workspace `90131720021`. |
| `CLICKUP_WEBHOOK_SECRET` | Vercel Project Env Vars | Returned when the webhook is created; needed for `X-Signature` verify. |

Use Vercel Environment Variables (Production/Preview/Development scopes) — no extra secret manager needed at this scale. Never commit `.env*`.

## Installation

```bash
# Core
npm install @slack/bolt@4.7.3 @vercel/slack-bolt@1.5.0 @anthropic-ai/sdk@0.105.0 @vercel/functions@3.7.1 zod@4.4.3

# Dev dependencies
npm install -D typescript@^5.6 @types/node@^22 vercel
```

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| `@vercel/slack-bolt` + Fluid `waitUntil` | Raw Events API + manual HMAC signature verify | Only if you must avoid Bolt's bundle entirely; you'd reimplement signature checks, retries dedup, and ack timing yourself — not worth it here. |
| `@vercel/slack-bolt` (no queue) | AWS SQS / Inngest / QStash queue + worker | When you need guaranteed delivery, retries, or jobs longer than the function timeout. Overkill for v1; revisit if reliability SLAs grow. |
| `@anthropic-ai/sdk` forced tool use | Vercel AI SDK (`ai` + `@ai-sdk/anthropic`) `generateObject` | If you later want multi-provider abstraction or built-in `generateObject` ergonomics. Adds a dependency layer; the native SDK is leaner for a single-provider bot. |
| Plain `fetch` to ClickUp v2 | Community ClickUp Node SDKs | Community SDKs are thin and often stale; `fetch` gives full control over custom-field payloads. Use a community wrapper only if it demonstrably saves boilerplate. |
| ClickUp REST API | ClickUp MCP server (in this env) | MCP is great for prototyping/reading IDs interactively, but production runtime should call REST directly for determinism. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Bolt's `ExpressReceiver`/`AwsLambdaReceiver` on Vercel | Built for long-lived servers/Lambda; doesn't solve Vercel's response-ends-the-function problem cleanly | `@vercel/slack-bolt` adapter |
| Slack `response_url`-only fire-and-forget without Fluid Compute | On classic serverless the function dies at response, killing your async work → silent failures | Fluid Compute + `waitUntil` via the adapter |
| Asking Claude for raw JSON in prose | Brittle parsing, hallucinated clients/IDs, markdown fences | Forced single-tool use with Zod-derived schema + enum-constrained `cliente` |
| Letting the LLM emit ClickUp user IDs / option UUIDs | LLMs invent IDs | LLM emits human names; resolve to IDs in code via fixed maps |
| Skipping raw-body capture before HMAC | JSON re-serialization changes bytes → signature mismatch | Read `req.text()` first, verify, then `JSON.parse` |
| `claude-fable-5` / `claude-mythos-5` | Access suspended (June 12 2026 export-control directive) | `claude-sonnet-4-5` (default) or `claude-haiku-4-5` |

## Stack Patterns by Variant

**If latency/cost on parsing becomes a concern:**
- Use `claude-haiku-4-5` instead of Sonnet for the extraction call.
- Because the task is narrow, schema-constrained extraction — Haiku is usually sufficient.

**If you later need guaranteed/retried delivery (e.g. ClickUp webhooks must never be dropped):**
- Introduce QStash or Inngest between the webhook endpoint and the Slack post.
- Because `waitUntil` has no retries and is bounded by function timeout.

**If the team outgrows Vercel env vars for secrets:**
- Move to Vercel + a secrets backend (Doppler/Infisical) or Vercel's native integrations.
- Because >~10 secrets across many environments gets unwieldy; not needed at v1.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `@vercel/slack-bolt@1.5.0` | `@slack/bolt@^4.4.0` (use `4.7.3`) | Peer dependency — must be Bolt v4, not v3. |
| `@anthropic-ai/sdk@0.105.0` | `zod@^3.25 || ^4` (use `4.4.3`) | Optional peer for tool/zod helpers; safe to pin zod 4.x. |
| `@vercel/functions@3.7.1` | Vercel Node 22 runtime, Fluid Compute | `waitUntil` requires Fluid Compute enabled on the project. |
| Bolt v4 | Vercel Node runtime (not Edge) | Use the Node.js runtime; Bolt and `crypto` HMAC are not Edge-targeted here. |

## Sources

- Vercel changelog — *Deploy Slack's Bolt.js to Vercel with `@vercel/slack-bolt`* — adapter purpose, Fluid Compute + `waitUntil` ack solution, framework-agnostic — HIGH
- Vercel Academy — *Acknowledgment and Latency* (Slack agents) — ack-first pattern, 3s deadline — HIGH
- Vercel docs — Fluid Compute, `waitUntil` (changelog + `@vercel/functions`) — background execution semantics, limits (no retries, bounded by timeout) — HIGH
- npm registry (live `npm view`) — exact versions: `@vercel/slack-bolt@1.5.0` (peer `@slack/bolt ^4.4.0`), `@slack/bolt@4.7.3`, `@anthropic-ai/sdk@0.105.0` (peer zod), `@vercel/functions@3.7.1`, `zod@4.4.3` — HIGH
- developer.clickup.com — Tasks + Custom Fields docs — dropdown value = option UUID from `type_config.options`, `due_date` epoch ms, `assignees` user IDs, `custom_fields` format — HIGH
- ClickUp webhook signature guidance (consultevo + community 2026) — `X-Signature` HMAC-SHA256 of raw body, hex, timing-safe compare — MEDIUM (verify exact header against live webhook create response)
- anthropic-sdk-typescript `helpers.md` (GitHub) — `betaZodTool`, forced `tool_choice` for structured output — HIGH
- Claude Models overview (platform.claude.com) — GA models June 2026: `claude-sonnet-4-5`, `claude-haiku-4-5`, `claude-opus-4-8`; Fable/Mythos 5 suspended — HIGH
- PROJECT.md — real ClickUp IDs: list `901327239630`, Cliente field `05ebdc8a-4736-404d-9132-3ab32875e1f1` (7 options), 9 members — HIGH

---
*Stack research for: Slack ↔ ClickUp NL-to-task bot on Vercel serverless*
*Researched: 2026-06-18*
