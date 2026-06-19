---
phase: 02-nl-parser-resolver
reviewed: 2026-06-18T00:00:00Z
depth: deep
files_reviewed: 11
files_reviewed_list:
  - src/llm/schema.ts
  - src/llm/openai.ts
  - src/llm/parse.ts
  - src/resolve/cliente.ts
  - src/resolve/assignees.ts
  - src/resolve/dates.ts
  - src/resolve/index.ts
  - src/resolve/types.ts
  - src/config/clients.ts
  - src/config/members.ts
  - src/parseAndResolve.ts
findings:
  critical: 1
  warning: 3
  info: 2
  total: 6
status: issues_found
---

# Phase 2: Code Review Report

**Reviewed:** 2026-06-18
**Depth:** deep
**Files Reviewed:** 11
**Status:** issues_found

## Summary

The LLM trust boundary (parse.ts / openai.ts) is solid: strict structured outputs,
refusal/empty/malformed handling, re-validation via `safeParse`, injectable client,
no secret logging. Date math is in-zone and epoch-ms correct. The resolvers correctly
avoid inventing IDs for *normal* unmatched tokens.

However, the alias/override lookups use bare object-index access on plain object
literals, so JS prototype-chain keys (`constructor`, `toString`, `valueOf`,
`hasOwnProperty`, `__proto__`) returned as raw tokens from the LLM resolve to inherited
`Object.prototype` members instead of `null`. In `resolveAssignees` this pushes
**Function objects into `assigneeIds`** — a direct violation of the "never invent an id"
guarantee (Pitfall 4), proven empirically below. Plus two date-precision issues.

## Critical Issues

### CR-01: Prototype-chain assignee tokens inject garbage ids into `assigneeIds`

**File:** `src/resolve/assignees.ts:61,72-73` (with `resolveAssignees` at 37-47)
**Issue:** `slackToMember[trimmed]` and `MEMBER_ALIASES[norm]` are bare index reads on
plain object literals. For tokens like `"constructor"`, `"toString"`, `"valueOf"`,
`"hasOwnProperty"`, the lookup returns an inherited `Object.prototype` function (truthy,
`!== undefined`) instead of a miss. Verified: `resolveAssignees(["constructor","toString","ari"])`
yields `ids = [ [Function: Object], [Function: toString], 150028631 ]`. The `id === null`
guard at line 39 also misses the `undefined` that `MEMBERS[<proto-fn>]` produces, so
`undefined` is pushed too. These bogus values flow straight to ClickUp as assignees — an
invented id at the LLM trust boundary (Pitfall 4). TypeScript does not catch it because the
`as Record<string, MemberName>` cast lies about the runtime value.
**Fix:** Gate every map read on own-property presence (or use `Map`/null-proto objects):
```ts
const slackHit = Object.hasOwn(slackToMember, trimmed) ? slackToMember[trimmed] : undefined;
// ...
if (Object.hasOwn(MEMBER_ALIASES, norm)) {
  const aliased = (MEMBER_ALIASES as Record<string, MemberName>)[norm];
  return MEMBERS[aliased];
}
return null;
```
Also harden the loop: `if (id == null) { unresolved.push(raw); continue; }` to catch both
`null` and `undefined`.

## Warnings

### WR-01: Prototype-chain cliente tokens return `undefined`, breaking the `string | null` contract

**File:** `src/resolve/cliente.ts:20-21`
**Issue:** Same root cause as CR-01. `CLIENT_ALIASES["constructor"]` returns the inherited
`Object` function (truthy), so `CLIENTS[<fn>]` evaluates to `undefined`, and `resolveCliente`
returns `undefined` rather than the declared `null`. Less severe than CR-01 (the result is
falsy `undefined`, not a garbage id), but it violates the signature and could surprise a
caller doing `=== null`.
**Fix:** `if (Object.hasOwn(CLIENT_ALIASES, norm)) { return CLIENTS[(CLIENT_ALIASES as ...)[norm]]; } return null;`

### WR-02: Two-digit years in `dd/mm/yy` are not expanded to a 4-digit year

**File:** `src/resolve/dates.ts:56-60`
**Issue:** The regex allows `\d{2,4}` for the year and passes it straight to
`DateTime.fromObject({ year, ... })`. `"12/07/26"` resolves to **year 26 AD**, not 2026 —
a valid-but-absurd epoch far in the past. ClickUp would receive a nonsensical due date.
**Fix:** Expand 2-digit years before constructing: `const year = explicit[3] ? expandYear(Number(explicit[3])) : today.year;`
where `expandYear(y) => y < 100 ? 2000 + y : y` (or reject 2-digit years outright and return null).

### WR-03: `parseAndResolve` cannot forward a custom `systemPrompt`

**File:** `src/parseAndResolve.ts:26-29`
**Issue:** `parseTask` accepts an optional `systemPrompt`, but `ParseAndResolveDeps` omits it
and the glue never forwards one, so callers of the phase-2 entry point can never override the
prompt. Not a correctness bug, but it makes the injectable seam in `parseTask` dead at the
public boundary.
**Fix:** Add `systemPrompt?: string` to `ParseAndResolveDeps` and pass `systemPrompt: deps.systemPrompt` into the `parseTask` call.

## Info

### IN-01: `dd/mm` without a year never rolls forward to the next year

**File:** `src/resolve/dates.ts:60`
**Issue:** A bare `dd/mm` always uses `today.year`. Late in the year, `"02/01"` resolves to
Jan 2 of the *current* year (in the past) rather than the upcoming one. Weekday resolution
correctly rolls forward; bare dates do not, which is inconsistent. Confirm this matches the
intended convention before shipping.
**Fix:** If the constructed date is before `today`, add a year: `if (dt < today && !explicit[3]) dt = dt.plus({ years: 1 });`

### IN-02: `OpenAILike.parse(body: any)` widens the request type at the boundary

**File:** `src/llm/openai.ts:33-34`
**Issue:** The `any` param is deliberate (DI shim) and the *output* is re-validated by
`safeParse`, so this is low-risk. Noted only because `ParseRequestBody` already documents the
exact shape — consider typing `parse(body: ParseRequestBody)` to keep the seam honest while
still satisfying the real client.
**Fix:** Narrow the mock signature to `ParseRequestBody` where the real `OpenAI` client still structurally matches.

---

_Reviewed: 2026-06-18_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
