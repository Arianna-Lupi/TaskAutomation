---
phase: 02-nl-parser-resolver
verified: 2026-06-18T19:12:00Z
status: passed
score: 4/4 must-haves verified
overrides_applied: 0
deferred:
  - truth: "Live OpenAI extraction accuracy on real Spanish messages"
    addressed_in: "Phase 3+"
    evidence: "02-CONTEXT.md deferred ideas: 'Live OpenAI accuracy tuning and prompt iteration happen once real messages flow (Phase 3+). Phase 2 just needs correct shape + resolution logic + tests.' Live smoke test exists and is gated/skipped without OPENAI_API_KEY (structural-only assertion)."
---

# Phase 2: NL Parser + Resolver Verification Report

**Phase Goal:** Offline-testable pipeline: raw message string → ParsedTask (OpenAI structured outputs) → ResolvedTask (deterministic resolver mapping cliente→option UUID, assignees→member IDs, Spanish relative dates→epoch ms in team TZ); unmatched → null.
**Verified:** 2026-06-18T19:12:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Free-form message yields a structured object with title, description, cliente, asignados, start/due date, links | ✓ VERIFIED | `src/llm/schema.ts` ParsedTaskSchema (7 fields, exact shape); `src/llm/parse.ts` parseTask via `zodResponseFormat(ParsedTaskSchema,"parse_task")` + `chat.completions.parse`; `src/parseAndResolve.ts` composes parse→resolve. parse.test.ts asserts model passthrough, schema wiring, ParseError on malformed. 82 offline tests pass. |
| 2 | Cliente string resolves to one of the 7 real dropdown option UUIDs, or null when no valid match | ✓ VERIFIED | `src/config/clients.ts` CLIENTS = 7 verbatim UUIDs + CLIENTE_FIELD_ID `05ebdc8a-...`; `src/resolve/cliente.ts` case-insensitive name then alias match, else null. clients.test.ts asserts all 7 UUIDs verbatim; cliente.test.ts covers name/alias/no-match→null. |
| 3 | Assignee names (Slack→member map or loose text) resolve to real member IDs, or null when unmatched | ✓ VERIFIED | `src/config/members.ts` MEMBERS = 9 verbatim ids + MEMBER_ALIASES + SLACK_TO_MEMBER scaffold; `src/resolve/assignees.ts` resolves Slack-map→name→alias, dedups, surfaces unmatched in `unresolved`. members.test.ts asserts 9 ids verbatim; assignees.test.ts covers slack override, alias, dedup, unresolved (["Pepe"]). |
| 4 | Relative Spanish dates resolve to correct epoch-ms in team timezone | ✓ VERIFIED | `src/resolve/dates.ts` luxon `DateTime.fromMillis(now,{zone})`, start-of-day convention, handles hoy/mañana/pasado mañana/weekdays/en N días/dd-mm(/yyyy), unparseable→null, `now` injected (no Date.now). dates.test.ts asserts exact ms incl. 23:30-local OFF-BY-ONE GUARD (Pitfall 5). |

**Score:** 4/4 truths verified

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | Live OpenAI extraction accuracy on real messages | Phase 3+ | CONTEXT deferred ideas; live smoke test gated on OPENAI_API_KEY (skipped offline, structural-only when present) |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/config/clients.ts` | 7 UUIDs + field id + aliases | ✓ VERIFIED | All 7 UUIDs + CLIENTE_FIELD_ID match CONTEXT verbatim |
| `src/config/members.ts` | 9 ids + aliases + Slack scaffold | ✓ VERIFIED | All 9 ids match CONTEXT verbatim; SLACK_TO_MEMBER exported empty |
| `src/config/env.ts` | OPENAI_API_KEY required + OPENAI_MODEL default | ✓ VERIFIED | Added to EnvSchema; default "gpt-4o-mini"; TEAM_TIMEZONE retained |
| `src/resolve/cliente.ts` | resolveCliente→UUID\|null | ✓ VERIFIED | Wired to clients.ts; null on no match |
| `src/resolve/assignees.ts` | resolveAssignees→{ids,unresolved} | ✓ VERIFIED | Wired to members.ts; dedup + unresolved |
| `src/resolve/dates.ts` | resolveSpanishDate→ms\|null | ✓ VERIFIED | luxon, TZ-correct, injected now |
| `src/resolve/index.ts` | resolveTask aggregator (pure) | ✓ VERIFIED | Composes 3 resolvers; default TZ; barrel re-exports |
| `src/llm/schema.ts` | ParsedTaskSchema (zod) | ✓ VERIFIED | Compile-time Equals check vs shared ParsedTask |
| `src/llm/parse.ts` | parseTask injectable + ParseError | ✓ VERIFIED | Strict json_schema; validates output; typed ParseError |
| `src/llm/openai.ts` | createOpenAIClient lazy factory | ✓ VERIFIED | Lazy, no process.env at load; throws naming key |
| `src/parseAndResolve.ts` | parseAndResolve glue | ✓ VERIFIED | parse→resolve; public surface re-exported |
| `src/llm/parse.live.test.ts` | gated live smoke test | ✓ VERIFIED | `describe.skipIf(!process.env.OPENAI_API_KEY)`; skipped offline |

### Key Link Verification

| From | To | Via | Status |
|------|----|----|--------|
| clients.ts | Cliente field 05ebdc8a-... | CLIENTE_FIELD_ID const | ✓ WIRED |
| cliente.ts | config/clients.ts | import CLIENTS+CLIENT_ALIASES | ✓ WIRED |
| dates.ts | luxon DateTime in TEAM_TIMEZONE | fromMillis(now,{zone}) | ✓ WIRED |
| parse.ts | OpenAI structured outputs | zodResponseFormat strict | ✓ WIRED |
| parseAndResolve.ts | resolve/index.ts | resolveTask(parsed,now,opts) | ✓ WIRED |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full test suite | `npx vitest run` | 82 passed, 1 skipped (live) | ✓ PASS |
| Typecheck | `npx tsc --noEmit` | exit 0, no errors | ✓ PASS |
| LLM emits no IDs | prompt + schema inspection | strings-only; resolver maps IDs | ✓ PASS |
| Resolver purity | `grep Date.now\|process.env\|fetch src/resolve` | only comments, no calls | ✓ PASS |

### Anti-Patterns Found

None. The only `Date.now` matches in src/resolve are doc comments stating it is deliberately not called. No TODO/FIXME/stub/placeholder in phase files.

### Human Verification Required

None blocking. Live OpenAI extraction accuracy is explicitly deferred to Phase 3+ (CONTEXT deferred ideas); the gated live smoke test confirms SDK wiring when a key is present and is correctly skipped offline.

### Gaps Summary

No gaps. All 4 ROADMAP success criteria are achieved and verified by code inspection plus 82 passing offline tests and a clean typecheck. The 7 Cliente UUIDs, CLIENTE_FIELD_ID, and 9 member ids match 02-CONTEXT.md verbatim and are test-locked. The LLM emits raw strings only (prompt + schema), and the deterministic resolver performs all ID/date mapping with unmatched → null. Dates resolve to epoch ms in TEAM_TIMEZONE with injected `now` and a 23:30-local off-by-one guard. The single live OpenAI test skips without a key, as expected.

---

_Verified: 2026-06-18T19:12:00Z_
_Verifier: Claude (gsd-verifier)_
