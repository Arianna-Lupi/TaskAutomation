# Architecture Research

**Domain:** Bidirectional Slack ↔ ClickUp integration bot (LLM-parsed task creation) on Vercel serverless
**Researched:** 2026-06-18
**Confidence:** HIGH (Slack/Vercel/ClickUp/Anthropic patterns verified against official docs; only the exact "best" confirmation-state choice is a judgment call, flagged MEDIUM)

## Standard Architecture

This is a **webhook-driven, stateless function** architecture. There is no long-running server. Every interaction is an inbound HTTP request to a Vercel function that must respond fast (Slack enforces a 3-second ACK deadline). All "memory" lives in an external store. Two independent ingress paths converge on shared service logic.

### System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                            INGRESS (Vercel functions)                  │
├──────────────────────────────────────────────────────────────────────┤
│  POST /api/slack/events        POST /api/slack/interactions           │
│  (message in channel)          (confirm / cancel button click)        │
│        │                              │                                │
│  POST /api/clickup/webhook     ──────────────────────                 │
│  (task status/assignee change) │                                       │
│        │                       │                                       │
│   [verify signature]      [verify signature]                          │
│   [ACK <3s, defer work]   [ACK <3s, defer work]                       │
└────────┼───────────────────────┼──────────────────────────────────────┘
         │                        │
┌────────┴────────────────────────┴──────────────────────────────────────┐
│                          SERVICE / DOMAIN LAYER                         │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ LLM Parser │  │  Resolver/   │  │  ClickUp     │  │  Slack       │  │
│  │ (Anthropic │  │  Mapper      │  │  client      │  │  client      │  │
│  │  tool use) │  │ (names→IDs)  │  │ (create/get) │  │ (post/update)│  │
│  └────────────┘  └──────────────┘  └──────────────┘  └──────────────┘  │
└────────┬─────────────────┬─────────────────┬───────────────┬───────────┘
         │                 │                 │               │
┌────────┴─────────────────┴─────────────────┴───────────────┴───────────┐
│                              STORES                                      │
│  ┌────────────────────┐   ┌─────────────────────┐  ┌────────────────┐  │
│  │ Upstash Redis      │   │ Config-as-code (TS)  │  │ Env / Secrets  │  │
│  │ - pending tasks    │   │ - Slack→ClickUp map  │  │ - tokens       │  │
│  │ - event dedup      │   │ - client aliases     │  │ - signing keys │  │
│  │ - task↔thread map  │   │ - list/field IDs     │  │                │  │
│  └────────────────────┘   └─────────────────────┘  └────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| Slack events endpoint | Receive channel messages, verify signature, dedup, ACK <3s, hand off to parse pipeline | `@vercel/slack-bolt` adapter or a thin custom handler; `waitUntil()` for async work |
| Slack interactions endpoint | Receive Block Kit button clicks (confirm/cancel), verify, ACK, run create-task flow | Same Bolt app (`action` handlers) or separate route |
| ClickUp webhook endpoint | Receive `taskStatusUpdated` / `taskAssigneeUpdated`, verify HMAC, ACK 200, post Slack notification | Plain Vercel function + `node:crypto` HMAC check |
| LLM Parser | Free-text Slack message → structured task object (title, description, client string, assignee strings, start/due, links) | Anthropic SDK with **tool use** for guaranteed structured JSON |
| Resolver/Mapper | Map parsed strings → real ClickUp IDs: client → dropdown option id, assignee names → member ids, validate dates | Pure functions over config-as-code + fuzzy match; no I/O |
| ClickUp client | Create task with custom fields; read task/member/status on inbound webhook | `fetch` wrapper around ClickUp API v2 |
| Slack client | Post preview (Block Kit) in thread, post created-task link, post status notifications | Bolt `client` / Web API `chat.postMessage` |
| Pending-task store | Hold parsed task between preview and confirm click | Upstash Redis with TTL |
| Config-as-code | Static team/client mappings + workspace/list/field IDs | Committed TS constants (9 members, 7 clients) |

## Recommended Project Structure

```
api/                              # Vercel serverless entrypoints (one fn per file)
├── slack/
│   ├── events.ts                 # message ingress → parse pipeline
│   └── interactions.ts           # button clicks → confirm/cancel
└── clickup/
    └── webhook.ts                # ClickUp → Slack notifications
src/
├── slack/
│   ├── verify.ts                 # signing-secret HMAC verification
│   ├── blocks.ts                 # Block Kit preview builder + confirm/cancel buttons
│   └── notify.ts                 # status/assignee → Slack message formatting
├── llm/
│   ├── parse.ts                  # Anthropic tool-use call
│   └── schema.ts                 # ParsedTask tool input_schema (single source of truth)
├── resolve/
│   ├── client.ts                 # client string → dropdown option id
│   ├── assignee.ts               # name/mention → ClickUp member id (map + fuzzy)
│   └── dates.ts                  # normalize start/due to epoch ms
├── clickup/
│   ├── client.ts                 # create task / get task / get members
│   ├── verify.ts                 # webhook HMAC verification
│   └── types.ts
├── store/
│   └── pending.ts                # Upstash Redis: put/get/delete pending task, dedup, task↔thread
└── config/
    └── mappings.ts               # Slack user ↔ ClickUp member, client aliases, IDs
```

### Structure Rationale

- **`api/` mirrors the three webhook surfaces:** Slack messages, Slack interactions, ClickUp webhooks are three independent ingress contracts with different signatures and payloads — keep them as separate functions so each can ACK fast and fail independently.
- **`src/` is pure-ish domain logic, framework-free:** `llm`, `resolve`, `clickup` have no Slack/Vercel coupling, so the parse→resolve→create pipeline is unit-testable without a live request. This matters because the LLM parser and the resolver are the highest-risk parts and you want to test them in isolation.
- **`config/mappings.ts` as code, not a database:** the dataset is tiny and slow-changing (9 members, 7 clients). Committed constants give you version history, code review, and zero infra. Promote to a store only if non-engineers need to edit it.

## Architectural Patterns

### Pattern 1: ACK-first, defer the work (`waitUntil`)

**What:** Verify signature, return 200 to Slack within ~2s, then continue heavy work (LLM call, ClickUp create) in the background via `waitUntil()` (Vercel Fluid compute) so the function isn't killed after responding.
**When to use:** Every Slack ingress. LLM parsing + ClickUp calls easily exceed 3s.
**Trade-offs:** Background work can fail silently after the 200 — you must post errors back to the Slack thread, not rely on the HTTP response. The official `@vercel/slack-bolt` adapter wires this `waitUntil` behavior for Bolt apps automatically.

**Example:**
```typescript
// api/slack/events.ts (conceptual)
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifySlackSignature(raw, req.headers)) return new Response('bad sig', { status: 401 });
  const body = JSON.parse(raw);
  if (body.type === 'url_verification') return Response.json({ challenge: body.challenge });

  // dedup Slack retries (same X-Slack-Retry-Num / event_id)
  if (await alreadySeen(body.event_id)) return new Response('dup', { status: 200 });

  waitUntil(handleMessage(body.event)); // parse → preview, runs after we return
  return new Response('', { status: 200 }); // ACK well under 3s
}
```

### Pattern 2: Structured output via Anthropic tool use

**What:** Don't parse free-form LLM prose. Define a `create_task` tool whose `input_schema` is the ParsedTask shape; force the model to call it (`tool_choice`). The tool input is guaranteed-shaped JSON.
**When to use:** The NL→structure step. Eliminates regex/JSON-repair hacks.
**Trade-offs:** Model can still hallucinate a client/assignee that doesn't exist — the schema guarantees *shape*, not *valid IDs*. Resolution + the human confirm step are the real validity gates. Keep the tool schema and the TS `ParsedTask` type in one file (`llm/schema.ts`) to avoid drift.

**Example:**
```typescript
const tool = {
  name: 'create_task',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      client: { type: 'string', enum: CLIENT_NAMES },     // bias toward the 7 real options
      assignees: { type: 'array', items: { type: 'string' } },
      start_date: { type: 'string' }, due_date: { type: 'string' }, // ISO; null if absent
      links: { type: 'array', items: { type: 'string' } },
    },
    required: ['title'],
  },
};
// messages.create({ tools: [tool], tool_choice: { type: 'tool', name: 'create_task' } })
```

### Pattern 3: Resolve-then-confirm (IDs computed before preview, not after)

**What:** Run the resolver (client→option id, names→member ids) *before* showing the preview, so the preview displays the *resolved* values ("Cliente: Children Chic ✓", "Asignado: Verónica") and flags anything unresolved ("⚠ no encontré 'Vero R.'"). Store the fully-resolved, ClickUp-ready payload as the pending task.
**When to use:** Always — the confirm click should be a near-pure "POST this payload" with no LLM/resolution work, so the create path is fast and deterministic.
**Trade-offs:** If a mapping is missing, you surface it at preview time (good — human can correct) rather than failing after confirm.

## Data Flow

### Flow A — Slack → ClickUp (task creation)

```
User posts free text in #channel
    ↓
POST /api/slack/events  →  verify sig  →  dedup  →  ACK 200 (<3s)
    ↓ (waitUntil)
LLM Parser (tool use) → ParsedTask
    ↓
Resolver → { listId, name, desc, dates, custom_fields:[client opt id], assignees:[member ids], unresolved:[…] }
    ↓
store.putPending(pendingId, payload, TTL=1h)
    ↓
Slack: post preview in THREAD with [Confirmar] / [Cancelar]   (button value = pendingId)
─────────────────────────────────────────────────────────────────────
User clicks [Confirmar]
    ↓
POST /api/slack/interactions → verify sig → ACK 200 (<3s)
    ↓ (waitUntil)
store.getPending(pendingId)  →  ClickUp: POST /list/{id}/task
    ↓
store.mapTaskToThread(taskId → {channel, thread_ts});  store.deletePending(pendingId)
    ↓
Slack: post created-task link in same thread; disable buttons
```

### Flow B — ClickUp → Slack (status/assignee notification)

```
Task status/assignee changes in ClickUp
    ↓
POST /api/clickup/webhook  →  verify HMAC (X-Signature, sha256)  →  ACK 200
    ↓ (waitUntil)
parse event (taskStatusUpdated / taskAssigneeUpdated, history_items)
    ↓
store.getThreadForTask(taskId)  →  {channel, thread_ts}  (fallback: channel root if unknown)
    ↓
Slack: post "✅ <task> → In Progress · asignado a Juan" in the original thread
```

### State Management — the confirmation-state decision

The core serverless problem: the function that builds the preview and the function that handles the confirm click are **different invocations with no shared memory**. The pending task must survive between them. Two viable approaches:

| Approach | How | Pros | Cons |
|----------|-----|------|------|
| **Encode in button `value`** | Serialize the resolved payload into the Block Kit button `value` (or `message metadata`) | Zero external store; payload travels with the click; tamper-safe because the whole interaction payload is HMAC-signed by Slack | **2000-char hard limit** on button value — rich descriptions + multiple links + multiple assignee IDs can blow it; awkward to evolve; can't add TTL/dedup |
| **External store (Upstash Redis)** | Store payload under a short `pendingId`; put only `pendingId` in the button value | No size limit; natural TTL/expiry; same store handles event dedup + task↔thread map (both needed anyway); confirm handler stays tiny | One more dependency + a few ms latency |

**Recommendation: external store (Upstash Redis), with `pendingId` in the button value.** MEDIUM-HIGH confidence.

Rationale: **you need a store regardless of the confirmation question.** Slack retries events when it doesn't get a 200 in time, so you need **dedup** keys; and Flow B requires a **task→thread mapping** so notifications land in the right thread. Both are Redis-shaped. Once Redis is in, holding the pending task there is free and removes the 2000-char ceiling (descriptions + Loom links + several assignee IDs realistically approach it). Use a short random `pendingId` as the button value, `SET pending:{id} <json> EX 3600`, delete on confirm/cancel. Note: **Vercel KV is sunset** (auto-migrated to Upstash Redis in Dec 2024) — provision **Upstash Redis via the Vercel Marketplace**, not "Vercel KV". Encode-in-button-value is a legitimate v0 shortcut if you want to defer Redis, but you'll add Redis for dedup/threading anyway, so do it once.

### Key Data Flows

1. **Pending task:** lives in Redis keyed by `pendingId`; `pendingId` rides in the Slack button value; deleted on confirm/cancel; TTL 1h auto-cleans abandoned previews.
2. **Task ↔ thread map:** written at create time (`taskId → {channel, thread_ts}`), read by the ClickUp webhook so status updates reply in the originating thread.
3. **Event dedup:** Slack `event_id` / ClickUp event id stored with short TTL; second delivery short-circuits to 200.

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| This project (3-4 users, 1 channel) | Current design is correct and over-provisioned; no queue needed — `waitUntil` is enough |
| 10s of users / multiple channels | Still fine; parameterize channel→list routing in config; watch Anthropic rate limits |
| 100s of msgs/min | Add a real queue (QStash/SQS) between ingress and processing so spikes don't fan out concurrent LLM calls; cache ClickUp member/field metadata |

### Scaling Priorities

1. **First bottleneck: LLM latency/cost, not infra.** Each message = one Anthropic call. At this team size it's negligible; the only "scaling" concern is keeping the parse prompt tight and caching the client/member lists (they're config-as-code, so already free).
2. **Second bottleneck: background-task durability.** `waitUntil` work that crashes is lost. If reliability ever matters more than now, move the post-ACK work onto a durable queue (QStash) so failed parses/creates retry. Not needed for v1.

## Anti-Patterns

### Anti-Pattern 1: Doing the LLM/ClickUp work before ACK

**What people do:** `await parse()` and `await createTask()` inside the request handler, then return 200.
**Why it's wrong:** Exceeds Slack's 3s deadline → Slack retries the event → duplicate previews / duplicate tasks.
**Do this instead:** Verify + dedup + ACK 200 first; run parse/create in `waitUntil`; report results/errors by posting to the thread.

### Anti-Pattern 2: Trusting the LLM to emit real ClickUp IDs

**What people do:** Ask the model to output the client dropdown option id or assignee member id directly.
**Why it's wrong:** It hallucinates IDs; IDs change; the model has no source of truth.
**Do this instead:** LLM emits human strings (client name, person name); a deterministic resolver maps strings → IDs against config-as-code, and the human confirm step catches misses.

### Anti-Pattern 3: Skipping signature verification (both directions)

**What people do:** Accept any POST to `/api/slack/events` or `/api/clickup/webhook`.
**Why it's wrong:** Public Vercel URLs are guessable; anyone can forge task-creation or spam notifications.
**Do this instead:** Verify Slack signing-secret HMAC (`v0:timestamp:body`, reject >5min skew) and ClickUp `X-Signature` HMAC-SHA256 on the raw body. **Read the raw request body before JSON-parsing** — Slack/ClickUp HMAC is over the raw bytes, and Vercel body parsing breaks it.

### Anti-Pattern 4: Treating confirm as a re-parse

**What people do:** Re-run the LLM/resolver inside the confirm handler.
**Why it's wrong:** Non-deterministic (preview may differ from what's created), slow, and risks blowing the 3s ACK again.
**Do this instead:** Resolve once before preview; store the ClickUp-ready payload; confirm just POSTs it.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Slack | Events API + Interactivity webhooks; Web API for posting; signing-secret HMAC | Use `@vercel/slack-bolt` to get `waitUntil`-based ACK for free, or hand-roll. Thread replies need `thread_ts` |
| ClickUp | REST API v2 for create/read; outbound webhooks for change events; `X-Signature` HMAC-SHA256 verify | Dropdown custom field set via `{id, value: <option uuid>}`; dates are epoch **ms**; webhook secret returned at webhook-create time |
| Anthropic | Messages API with **tool use** + `tool_choice` for structured output | Schema is the contract; keep client/assignee enums in sync with config |
| Upstash Redis | Provision via **Vercel Marketplace** (Vercel KV is sunset); REST or `@upstash/redis` (HTTP, edge-safe) | Use HTTP client — TCP Redis is awkward in serverless |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| ingress (`api/`) ↔ domain (`src/`) | Direct function calls inside `waitUntil` | Keep `api/` thin: verify, ACK, delegate |
| LLM Parser ↔ Resolver | Plain object (`ParsedTask`) | Resolver does all I/O-free ID mapping |
| Resolver ↔ Config | Imported constants | Config-as-code; swap to store only if non-devs must edit |
| Domain ↔ Redis | `store/pending.ts` interface | One module owns key naming + TTLs |

## Suggested Build Order (for roadmap phasing)

1. **Ingress skeleton + signature verification + 3s ACK.** Slack events endpoint that verifies and ACKs, echoing receipt in-thread. Proves the hardest serverless constraint first. (Also stand up Upstash Redis here for dedup.)
2. **LLM parser in isolation.** `llm/parse.ts` + schema, tested offline against real example messages → `ParsedTask`. No Slack needed.
3. **Resolver + config-as-code.** Map client/assignee strings → real ClickUp IDs (the PROJECT.md IDs). Pure functions, unit-tested.
4. **Preview + confirmation state.** Block Kit preview in thread, pending task in Redis, confirm/cancel buttons. Closes the human-in-the-loop.
5. **ClickUp outbound create.** Wire confirm → create task with custom fields; post task link; write task↔thread map. End-to-end Flow A done.
6. **ClickUp inbound webhook → Slack notify.** Verify HMAC, map task→thread, post status/assignee changes. Completes bidirectional v1.
7. **Hardening.** Error reporting to thread, unresolved-field UX, dedup edge cases, config review.

This order is dependency-driven: signature/ACK underpins everything (1); parsing (2) and resolution (3) are independent and testable without Slack; (4) needs both plus the store; (5) needs (4); (6) is independent of (5) except for the shared task↔thread map written in (5). Flow A (steps 1-5) is a shippable slice before Flow B (step 6).

## Sources

- Deploy Bolt.js to Vercel / `@vercel/slack-bolt` (waitUntil ACK): https://vercel.com/changelog/build-slack-agents-with-vercel-slack-bolt — HIGH
- Vercel Academy, Slack ACK & latency (3s deadline): https://vercel.com/academy/slack-agents/acknowledgment-and-latency — HIGH
- Vercel Redis / Marketplace storage (Vercel KV sunset → Upstash): https://vercel.com/docs/redis ; https://vercel.com/docs/marketplace-storage — HIGH
- Upstash Redis on Vercel: https://vercel.com/marketplace/upstash — HIGH
- Slack Block Kit element limits (button value 2000, url 3000, action_id 255): https://docs.slack.dev/tools/python-slack-sdk/reference/models/blocks/index.html — HIGH
- ClickUp Tasks API / Custom Fields: https://developer.clickup.com/docs/tasks ; https://developer.clickup.com/docs/customfields — HIGH
- ClickUp webhook signature (HMAC-SHA256): https://developer.clickup.com/docs/webhooksignature — HIGH
- Anthropic tool use for structured output: training-data + Anthropic docs convention — MEDIUM (verify exact `tool_choice` syntax against current SDK at build time)

---
*Architecture research for: Slack ↔ ClickUp bidirectional task bot on Vercel serverless*
*Researched: 2026-06-18*
