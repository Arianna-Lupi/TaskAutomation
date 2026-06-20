---
phase: 06-dynamic-config-from-clickup
verified: 2026-06-19T20:05:00Z
status: human_needed
score: 5/5 must-haves verified (offline logic + degradation); 3 live-integration checks deferred to human
overrides_applied: 0
human_verification:
  - test: "Add or rename a Cliente option in the live ClickUp list (901327239630), wait for TTL (~10min) or hit the refresh endpoint, then send a Slack message naming that client and open the preview"
    expected: "The new/renamed client appears in the preview mapped to its correct ClickUp option UUID, with no redeploy"
    why_human: "Requires a live ClickUp token + the real Cliente field; offline tests prove getClienteOptions parsing + provider tiering against mocks only"
  - test: "Add the users:read.email bot scope in the Slack app dashboard, reinstall the app, then @-mention a teammate whose Slack email matches their ClickUp member email"
    expected: "The mention resolves to the correct ClickUp member id by email, with no hardcoded Slack id"
    why_human: "users.info email read requires the new users:read.email scope + reinstall; not grantable in this environment. Offline tests cover the email-match + degrade logic against a stub Slack client"
  - test: "Hit GET /api/admin/refresh-config?secret=<SLACK_SIGNING_SECRET> against the deployed function with live Upstash Redis, then trigger a parse"
    expected: "cfg:* hot keys are cleared (cfg:*:lastgood retained), 200 JSON lists the cleared keys, and the next parse re-fetches fresh ClickUp data"
    why_human: "Endpoint constructs a live Redis client (createRedis) and calls redis.keys('cfg:*'); offline tests cover the secret gate + key-selection logic, not the live Upstash round-trip"
---

# Phase 6: Dynamic Config from ClickUp Verification Report

**Phase Goal:** Replace hardcoded config (clients.ts, members.ts, SLACK_TO_MEMBER) with values read live from ClickUp + Slack, cached in Redis with a TTL, resilient fallback to static maps, manual refresh. Adding a client/member in ClickUp works without a redeploy.
**Verified:** 2026-06-19T20:05:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth (Success Criterion) | Status | Evidence |
|---|---------------------------|--------|----------|
| 1 | Adding/renaming a Cliente in ClickUp shows in a new preview without redeploy (after TTL or manual refresh), mapped to right UUID | ✓ VERIFIED (logic) | `client.getClienteOptions()` GETs `/list/{listId}/field`, finds `CLIENTE_FIELD_ID`, returns `{id(UUID), name}[]` (client.ts:192-233). `buildClientesConfig` keys `byName[name]=UUID` (provider.ts:67-85). TTL=600s + manual refresh endpoint. Live ClickUp fetch → human-deferred. |
| 2 | A newly added ClickUp member resolves as an assignee with no code change | ✓ VERIFIED (logic) | `getMembers()` GETs `/team/{teamId}/member`, extracts id/name/email (client.ts:235-273). `buildMembersConfig` → `byName`/`aliases` (provider.ts:91-113). `resolveAssignees` reads injected `config.byName` (assignees.ts:81-90). Dynamic-injection resolver tests green. |
| 3 | Slack user matched to ClickUp member by email, no hardcoded Slack IDs required | ✓ VERIFIED (logic) | `resolveSlackMentionsToMembers` calls `users.info` → `profile.email` → `membersConfig.byEmail[email]` (slackEmail.ts:104-112); `byEmail` populated from live members (provider.ts:97-99). Live `users.info` needs `users:read.email` scope → human-deferred. |
| 4 | If ClickUp/Redis is down, last-good cache or static maps keep the flow working | ✓ VERIFIED | `resolveTiered`: hot cache → live fetch → last-good → static, every tier try/caught, never throws (provider.ts:152-205). process.ts wraps provider + slack-map resolution in try/catch degrading to static (process.ts:165-197). Static maps preserved (CLIENTS/MEMBERS/SLACK_TO_MEMBER each grep==1). provider.test.ts covers Redis-throw + fetch-fail → last-good → static. |
| 5 | Manual refresh clears cache so next parse reads fresh ClickUp data | ✓ VERIFIED (logic) | `api/admin/refresh-config.ts`: timing-safe secret gate (401 on mismatch), `redis.keys("cfg:*")` filtered to drop `:lastgood`, `del(...toClear)`, returns `{cleared}` (refresh-config.ts:20-50). Live Upstash round-trip → human-deferred. |

**Score:** 5/5 truths verified at the logic + degradation level. 3 live-integration confirmations routed to human (no tokens/scope/live Redis in this environment, as the instructions specify).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/clickup/client.ts` | getClienteOptions + getMembers via retry fetch | ✓ VERIFIED | Both present (lines 192, 235), route through injected retry `fetch`, raw Authorization header, throw status+body never token, shape-guard every access, malformed payload throws typed error. |
| `src/store/redis.ts` | config-cache helpers w/ TTL + last-good | ✓ VERIFIED | writeConfigCache (TTL key + no-TTL lastgood, lines 308-318), readConfigCache, readConfigLastGood, clearConfigCache (clears TTL only). CONFIG_CACHE_TTL_SECONDS=600. |
| `src/config/provider.ts` | 3-tier ConfigProvider + alias overlay + byEmail | ✓ VERIFIED | 235 lines. createConfigProvider, resolveTiered (cache→live→lastgood→static), build*/static* builders, curated alias overlay merged on live names, byEmail from live members. |
| `src/resolve/cliente.ts` | injected ClientesConfig, static default | ✓ VERIFIED | `resolveCliente(raw, config=staticClientesConfig())`, Object.hasOwn guards, backward-compatible default. |
| `src/resolve/assignees.ts` | injected MembersConfig, static default | ✓ VERIFIED | `config?:MembersConfig` default staticMembersConfig(); slackToMember override tier unchanged first; Object.hasOwn guards preserved. |
| `src/slack/slackEmail.ts` | email match + cfg:slackmap cache + degrade | ✓ VERIFIED | resolveSlackMentionsToMembers (cache→users.info email→byEmail→static overlay→omit, never throws), extractSlackMentionIds. missing_scope detected via `e.data.error`. |
| `api/admin/refresh-config.ts` | secret-gated cfg:* clear | ✓ VERIFIED | timingSafeEqual gate, keeps :lastgood, returns cleared list. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| client.ts | ClickUp `/list/{id}/field` + `/team/{teamId}/member` | injected retry fetch | ✓ WIRED | Both endpoints hit through the wrapped `fetch`. |
| redis.ts | RedisLike set/get | `cfg:` namespaced keys | ✓ WIRED | cfg:<name> + cfg:<name>:lastgood. |
| provider.ts | client.getClienteOptions/getMembers + redis cache | fetch→cache→lastgood→static | ✓ WIRED | resolveTiered calls readConfigCache/writeConfigCache/readConfigLastGood + static builders. |
| resolve/index.ts | resolveCliente / resolveAssignees | injected clientesConfig / membersConfig | ✓ WIRED | resolveTask threads both configs (summary + index re-exports). |
| process.ts | provider + slack-email resolver | await getClientes/getMembers + resolveSlackToMember → parseAndResolve | ✓ WIRED | process.ts:165-197 merges live configs + email-resolved slack map into per-call parse deps. |
| app.ts | createConfigProvider + resolveSlackMentionsToMembers | per-warm-instance provider, CLICKUP_TEAM_ID into client | ✓ WIRED | app.ts:112,123-125,166-182 — provider + resolveSlackToMember closure passed into processMessageEvent. |
| refresh-config.ts | Redis cfg:* keys | keys('cfg:*') + del (drop :lastgood) | ✓ WIRED | createRedis returns upstash Redis with .keys(); typecheck confirms. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full unit suite green (no regression from 235 baseline) | `npx vitest run` | 287 passed / 2 skipped (24 files passed, 2 skipped) | ✓ PASS |
| Strict TypeScript compiles | `npx tsc --noEmit` | exit 0, no errors | ✓ PASS |
| 2 live tests skipped (expected) | (in suite) | `parse.live.test.ts` skipped + 1 other | ✓ PASS (matches instruction) |
| Static maps preserved as fallback | grep CLIENTS/MEMBERS/SLACK_TO_MEMBER | each == 1 | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Status | Evidence |
|-------------|-------------|--------|----------|
| DYN-01 (live Cliente options) | 06-01/02 | ✓ SATISFIED | getClienteOptions + buildClientesConfig byName UUID. |
| DYN-02 (Redis TTL cache, no redeploy) | 06-01/02 | ✓ SATISFIED | writeConfigCache TTL 600s; resolveTiered cache tier. |
| DYN-03 (live members, no 9 hardcoded ids) | 06-01/02 | ✓ SATISFIED | getMembers + buildMembersConfig; resolveAssignees injected config. |
| DYN-04 (Slack→ClickUp by email) | 06-03 | ✓ SATISFIED (logic) | resolveSlackMentionsToMembers email match; byEmail map. Live scope deferred. |
| DYN-05 (resilient fallback) | 06-01/02/03 | ✓ SATISFIED | 3-tier provider + process.ts degradation; static maps + last-good preserved. |
| DYN-06 (manual refresh) | 06-03 | ✓ SATISFIED (logic) | refresh-config endpoint clears cfg:* keeping last-good. Live Redis deferred. |

No orphaned requirements — all DYN-01..06 claimed by plans and mapped to evidence.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | — | No TBD/FIXME/XXX/HACK/PLACEHOLDER/TODO in any phase file | ℹ️ Info | Clean — completion is auditable. |

### Backward Compatibility

Resolvers default to static configs (`staticClientesConfig()` / `staticMembersConfig()`) when no provider config is injected. ProcessDeps.provider is optional; with no provider the capture path behaves exactly as v1.0. All prior resolver/process tests pass unchanged (287 total, up from 235 baseline with +52 new, 0 regressions).

### Human Verification Required

1. **Live Cliente add/rename round-trip** — Add/rename a client in ClickUp list 901327239630, wait for TTL or hit refresh, send a Slack message, confirm the preview shows it mapped to the right UUID. (Needs live ClickUp token.)
2. **Email-based assignee resolution** — Add `users:read.email` bot scope + reinstall, @-mention a teammate, confirm resolution by email with no hardcoded Slack id. (Needs new Slack scope + reinstall.)
3. **Live refresh endpoint** — Hit `/api/admin/refresh-config?secret=<SLACK_SIGNING_SECRET>` against the deployed function with live Upstash; confirm cfg:* cleared (last-good retained) and next parse re-fetches. (Needs live Redis + deploy.)

### Gaps Summary

No code gaps. All five success criteria are implemented with the full 3-tier degradation chain, the static maps are preserved as the safety net, curated aliases are merged on top of live names, backward compatibility is intact, and the unit suite (287 pass / 2 skipped) plus strict typecheck are green. The only items not confirmable in this environment are the three live-integration paths (real ClickUp fetch, Slack `users.info` with the new `users:read.email` scope, and the live Upstash refresh round-trip) — these are routed to human verification exactly as the phase instructions anticipated. Phase goal is achieved at the logic + resilience level; production confirmation is the remaining step.

---

_Verified: 2026-06-19T20:05:00Z_
_Verifier: Claude (gsd-verifier)_
