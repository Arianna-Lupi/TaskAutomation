# Phase 2: NL Parser + Resolver - Context

**Gathered:** 2026-06-18
**Status:** Ready for planning
**Mode:** Auto-generated (autonomous smart-discuss)

<domain>
## Phase Boundary

An offline-testable pipeline: raw message string → `ParsedTask` (LLM extraction via OpenAI structured outputs) → `ResolvedTask` (deterministic resolver mapping cliente→option UUID, assignees→ClickUp member IDs, relative Spanish dates→epoch ms in team TZ). Anything that can't be matched resolves to `null` (never invented).

In scope: the OpenAI parse call (json_schema strict / zodResponseFormat), the Zod `ParsedTask` schema, config-as-code maps (7 clients, 9 members + aliases), the resolver functions, Spanish relative-date resolution, and full unit tests. No Slack wiring, no ClickUp HTTP calls, no preview — this phase is a pure, importable `parseAndResolve(text, now)` module.

Out of scope: posting previews (Phase 3), creating tasks (Phase 3), webhooks (Phase 4).
</domain>

<decisions>
## Implementation Decisions

### AI provider (LOCKED — changed from Claude to OpenAI to save Claude credits)
- `openai` SDK. **Structured Outputs**: `response_format: { type: "json_schema", json_schema: { name: "parse_task", strict: true, schema } }`, or the `zodResponseFormat(ParsedTaskSchema, "parse_task")` helper from `openai/helpers/zod`. This guarantees schema-shaped JSON — the equivalent of Claude forced tool use.
- Model: `gpt-4o-mini` default (cheap, good Spanish), `gpt-4.1-mini` fallback. Read model from env `OPENAI_MODEL` (default `gpt-4o-mini`); `OPENAI_API_KEY` required.
- The LLM emits only human-readable strings (client name, assignee names, date phrases, links). It does NOT emit IDs. The deterministic resolver maps strings → real IDs. The schema guarantees shape, not validity; validity is the resolver's + (later) the human's job.

### ParsedTask shape (Zod)
`{ title: string, description: string|null, clienteRaw: string|null, assigneesRaw: string[], startDatePhrase: string|null, dueDatePhrase: string|null, links: string[] }`. Keep the LLM output deliberately "raw" — resolution is separate and testable.

### Config-as-code maps (real IDs from PROJECT.md / ClickUp MCP)
- **Clientes** (dropdown field `05ebdc8a-4736-404d-9132-3ab32875e1f1`, option UUIDs):
  - Felipe Vergara `63d9626f-9b80-4a19-8638-93b8042d2e9c`
  - Children Chic `57123824-86d1-4fb8-a3a3-03fb1a8d8704`
  - Ultra1plus `b48a4350-8c92-434f-88d4-00527f2eb157`
  - FHCA `dce8df41-786e-40f4-9427-e833daf2d6a0`
  - Delta/Nicmafia `bf842969-d5c2-4eb8-a1fb-5d87d804eb0d`
  - Apturio `cde11ae3-2d92-4ca4-b9d7-ab4157af67ff`
  - Interno `c95d4707-50a8-4833-9046-9c153a4f7592`
- **Members** (ClickUp id ← name; also seed a Slack-userID→memberID map, values filled from env/later since Slack IDs aren't known yet — structure it so Slack IDs can be added):
  - Miguel Pacheco 216158839 · Juan Carlos Angulo 216178477 · Veronica Romero 118065209 · Amira El Sahli 112092886 · Oriana Reyes 106163644 · Fernando Perez 162145488 · Natalia Olivares 105901293 · Cammila Hernandez 100128182 · Arianna Lupi 150028631
- Put these in `src/config/clients.ts` and `src/config/members.ts` as typed constants. Include an `aliases` table (e.g. "vero"→Veronica, "delta"/"nicmafia"→Delta/Nicmafia, "feli"→Felipe) for fuzzy text resolution.

### Resolver rules
- **Cliente:** case-insensitive match of `clienteRaw` against option names + aliases → option UUID; no confident match → `null`.
- **Assignees:** for each raw name, match against member names + aliases (and, when present, the Slack→member map) → member id; collect resolved ids, drop unmatched (optionally return an `unresolved: string[]` for the preview to flag).
- **Dates:** resolve relative Spanish phrases ("hoy", "mañana", "pasado mañana", "viernes", "el lunes", "en 3 días", explicit "12/07") to epoch **milliseconds**, computed in `TEAM_TIMEZONE` (default `America/Caracas`) — NOT the server's UTC clock. Use a small date lib that handles TZ correctly (e.g. `date-fns` + `date-fns-tz`, or Luxon). Pass `now` in as a parameter so the resolver is deterministic and unit-testable. Unparseable → `null`.

### Output
- Export `parseTask(text): Promise<ParsedTask>` (OpenAI call) and `resolveTask(parsed, now): ResolvedTask` (pure), plus a convenience `parseAndResolve(text, now)`.
- `ResolvedTask` = `{ title, description, clienteOptionId: string|null, assigneeIds: number[], unresolvedAssignees: string[], startDateMs: number|null, dueDateMs: number|null, links: string[] }`.

### Testing
- Resolver tests are pure (no network): cliente match/alias/no-match, assignee map+alias+unmatched, date resolution across TZ with fixed `now` (assert exact ms, including a DST-free Caracas offset and an off-by-one guard).
- Parser tests: mock the OpenAI client (inject it) so tests run offline; assert the schema/prompt wiring and that a malformed model response is caught. A single optional live smoke test may be gated behind `OPENAI_API_KEY` presence.

### Claude's Discretion
Prompt wording, alias lists, date-lib choice (date-fns-tz vs luxon), file layout under `src/llm/` and `src/resolve/`.
</decisions>

<code_context>
## Existing Code Insights

Phase 1 established: strict ESM TS, `src/config/env.ts` (zod `loadEnv`), `src/store/redis.ts`, `src/slack/*`, vitest. Add `OPENAI_API_KEY` + `OPENAI_MODEL` to the env schema and `.env.example`. Inject dependencies (OpenAI client) for testability, matching Phase 1's style (the Slack code injects its client/redis). Reuse `TEAM_TIMEZONE` from env.
</code_context>

<specifics>
## Specific Ideas

- Keep parser and resolver as separate modules so the resolver (highest-value, deterministic) is fully testable without any API key.
- The Slack-userID→ClickUp-member map can't be fully populated yet (Slack IDs unknown until the workspace is wired); structure it as an env-or-config override so real Slack IDs slot in later without code changes. Name-based resolution from message text works now.
</specifics>

<deferred>
## Deferred Ideas

- Live OpenAI accuracy tuning and prompt iteration happen once real messages flow (Phase 3+). Phase 2 just needs correct shape + resolution logic + tests.
</deferred>
