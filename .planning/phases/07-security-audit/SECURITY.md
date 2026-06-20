---
status: audit_complete
phase: 7
milestone: v1.1
requirements: [SEC-01, SEC-02, SEC-03]
date: 2026-06-19
auditor: security-audit (audit-only, no source changes)
scope: OWASP Top 10 (2021) + focused cybersecurity review
---

# Security Audit — Slack → ClickUp Task Bot (Phase 7)

## Executive Summary

The application is a small, well-factored serverless bot with a **strong security
baseline**: both inbound trust boundaries (Slack, ClickUp) verify HMAC signatures
over the **raw request body** with **timing-safe** comparison, no user-controlled
URL ever reaches `fetch` (no SSRF surface), LLM output is re-validated through a
Zod schema and IDs are resolved against fixed server-side maps (the LLM never
emits IDs), tampered `private_metadata` is schema-validated, idempotency is
enforced at every create/delivery point, and **no secret is logged anywhere** in
the runtime code. `npm audit` shows **0 runtime vulnerabilities** — all 21
findings live exclusively in the dev toolchain (`vercel` CLI, `vitest`/`vite`/
`esbuild`).

The material findings are concentrated in the **two ops endpoints**
(`api/slack/diag.ts`, `api/admin/refresh-config.ts`), which authenticate via the
**Slack signing secret passed in the URL query string** and use **GET to perform
state-changing actions** (bot self-join to an arbitrary channel; cache eviction).
Secret-in-URL is logged by proxies / CDN access logs / `Referer` headers and
reusing the *signing secret* as a bearer credential overloads a key whose only
other job is HMAC verification. These are the top fixes for Phase 8.

### Findings by severity

| Severity | Count | IDs |
|----------|-------|-----|
| Critical | 0 | — |
| High     | 2 | FIND-01, FIND-02 |
| Medium   | 4 | FIND-03, FIND-04, FIND-05, FIND-06 |
| Low      | 5 | FIND-07, FIND-08, FIND-09, FIND-10, FIND-11 |
| Info / DiD | 2 | FIND-12, FIND-13 |

No critical, externally-exploitable, unauthenticated RCE/data-exfil path was
found. The two High findings are operational-endpoint hardening issues, not
remote compromise of the core task flow.

---

## OWASP Top 10 (2021) — Category Walkthrough

| Category | Applies? | Finding | Severity |
|----------|----------|---------|----------|
| **A01 Broken Access Control** | Yes | Core Slack/ClickUp ingress is properly gated by HMAC. The two ops endpoints (`diag`, `refresh-config`) are gated only by the signing secret in the **query string** and perform **state changes over GET** (self-join arbitrary channel; cache flush) — no CSRF token, no POST, no purpose-scoped credential. `diag` can make the bot join any channel id (`conversations.join`) and enumerates every channel the bot is in. | **High** (FIND-01, FIND-02) |
| **A02 Cryptographic Failures** | Yes | HMAC-SHA256 used correctly with `crypto.timingSafeEqual` everywhere (`src/clickup/signature.ts:45`, `api/slack/diag.ts:29`, `api/admin/refresh-config.ts:24`). Equal-length guard precedes `timingSafeEqual`. No weak hashing, no homemade crypto. Gaps: signing secret reused as a URL credential (FIND-01); ClickUp webhook has **no timestamp → no replay protection** beyond the 24h dedup TTL (FIND-04). All transport is HTTPS (Vercel, Upstash REST, ClickUp v2, OpenAI). | **Medium** (FIND-04) |
| **A03 Injection** | Yes | No SQL/shell/template injection surface. LLM output is re-validated via Zod (`src/llm/parse.ts:74`) and resolved to IDs via fixed maps. ClickUp calls send JSON bodies via `JSON.stringify` (no string concatenation). **Slack mrkdwn injection** is correctly escaped on the *inbound ClickUp→Slack* path (`escapeSlackText`, `src/clickup/webhook.ts:79`) but **NOT** on the *outbound preview* path — `buildPreviewBlocks` injects `title`/`description`/`links` raw into `mrkdwn` (`src/slack/blocks.ts:79-87`). Same-channel, same-author, low impact, but inconsistent. | **Low** (FIND-07) |
| **A04 Insecure Design** | Yes | Strong: mandatory human confirmation before any task create; exactly-once create via `GETDEL` claim (`src/store/redis.ts:249`); point-of-no-return discipline in `handleConfirm`; LLM-emits-names-not-IDs design; kill switch (HARD-03). Design weakness: kill switch is **fail-open** (`isKillSwitchActive` returns `false` on Redis outage, `src/store/redis.ts:151`) — availability-over-safety, documented & intentional but worth recording as accepted risk. | **Low** (FIND-08, accepted) |
| **A05 Security Misconfiguration** | Yes | `loadEnv` fail-fast Zod validation of all secrets (`src/config/env.ts`) is excellent. Issues: ops endpoints are reachable in production with no env-gate / IP allowlist (FIND-02); `diag` response leaks internal topology (channel list, bot identity, team, Redis host) to any holder of the signing secret (FIND-03); no explicit security response headers (low, API-only JSON). No stack traces or secrets in error bodies. | **Medium** (FIND-03) |
| **A06 Vulnerable & Outdated Components** | Yes | `npm audit`: **0 runtime** vulnerabilities. 21 total (1 critical, 10 high, 9 moderate, 1 low) are **all dev-only** — `vercel` CLI tree (`@vercel/fun`→`tootallnate/once`, `tar`, `undici`, `path-to-regexp`, `ajv` ReDoS) and `vitest`/`vite`/`esbuild`. None ship to the serverless runtime. Node engine pinned `>=20 <21`. | **Medium** (FIND-05, dev-only) |
| **A07 Identification & Auth Failures** | Yes | Slack identity verified by Bolt/`VercelReceiver` signing-secret HMAC incl. the standard `x-slack-request-timestamp` staleness window (`src/slack/app.ts:90`). ClickUp identity verified by `X-Signature`. Echo-loop / own-bot / wrong-channel filtering (`isProcessableMessage`). Gap: no replay window on ClickUp (FIND-04); ops endpoints conflate "knows signing secret" with "is an operator" (FIND-01). | **Medium** (folds into FIND-01/04) |
| **A08 Software & Data Integrity Failures** | Yes | Inbound payload integrity enforced by HMAC before parse (raw-body-first ordering, `api/clickup/webhook.ts:69`). `private_metadata` round-tripped through Slack is schema-validated on return (`src/slack/modal.ts:71-83`, WR-04). Dedup keys namespaced to prevent cross-type collision. No deserialization of untrusted code; `JSON.parse` only, guarded. No dependency-pinning lockfile concern flagged beyond A06. | **Low** (FIND-09) |
| **A09 Logging & Monitoring Failures** | Yes | Good structured `console` logging of event lifecycle; **no secret/token is ever logged** (verified by grep across `src/` + `api/`). Gaps: no alerting/aggregation/rate-limit-anomaly detection; logs include channel/user/event ids (PII-light, acceptable for an internal tool); no audit trail for ops-endpoint use (who flushed cache / triggered self-join). | **Low** (FIND-10) |
| **A10 SSRF** | Yes | **Not exploitable.** Every `fetch` targets the fixed `https://api.clickup.com/api/v2` host (`src/clickup/client.ts:15`); only env-controlled `listId`/`teamId` and the HMAC-verified webhook `taskId` are interpolated into the **path** (never the host/scheme). `links` from user text are stored in a ClickUp custom field, never fetched. No user input controls a request URL, host, or port. Residual: `taskId` path-segment is not format-validated (path stays within api.clickup.com). | **Low** (FIND-11) |

---

## Focused Cybersecurity Analysis

### 1. Signature verification (Slack + ClickUp)
- **Raw-body correctness:** ClickUp handler reads `await req.text()` **before** any
  JSON parse and verifies over those exact bytes (`api/clickup/webhook.ts:69-75`).
  Slack handled by `VercelReceiver`, which the adapter feeds the raw `Request`. ✅
- **Timing-safe compare:** `crypto.timingSafeEqual` in all three verifiers, each
  with an explicit equal-length pre-check (signature regex `^[0-9a-f]{64}$` in
  `src/clickup/signature.ts:32`; `Buffer` length guard in the ops `safeEqual`). ✅
- **Header robustness:** case-insensitive `X-Signature` lookup, tolerates optional
  `sha256=` prefix, never throws on malformed input (returns `false`). ✅
- **Replay / staleness:** Slack — covered by Bolt's timestamp window. **ClickUp —
  no timestamp is part of the signed material, so a captured valid delivery can be
  replayed.** Mitigated only by the 24h `whk:` dedup key; after TTL expiry the same
  signed body would re-post. → **FIND-04 (Medium).**
- **Bypass paths:** none found. Empty/missing signature → 401. Empty secret →
  `false`. Unparseable-but-signed body → 200 ACK no-op (correct).

### 2. Secrets handling
- `grep` for `token|secret|signing|api_key|authorization` across all `console.*`
  calls in `src/` + `api/`: **zero matches.** ✅
- ClickUp client error strings deliberately include status + response body but
  **never** the `Authorization` token (`src/clickup/client.ts:137,158,199,249`). ✅
- `diag` redis probe surfaces only URL **scheme + host**, never the token
  (`api/slack/diag.ts:54-55`). ✅
- **Concern:** the **signing secret travels in the request URL** for both ops
  endpoints → captured in Vercel/CDN access logs, proxy logs, and browser
  `Referer`. → **FIND-01 (High).**

### 3. Input-validation / trust boundaries
- **LLM output:** strict structured-output + `ParsedTaskSchema.safeParse`
  re-validation; refusals throw (`src/llm/parse.ts:70-82`). LLM emits only human
  strings; IDs resolved server-side. ✅
- **Block Kit button `value`:** carries only the opaque `pendingId`; consumed by a
  Redis `GETDEL` lookup — a forged value yields `null` → safe no-op. ✅
- **`private_metadata`:** JSON-parsed in try/catch + Zod-validated; bad payload
  aborts cleanly (`src/slack/modal.ts:71-83`; `handleEditSubmit` catch). ✅
- **Modal selects:** Cliente/Asignados come only from fixed option sets; a tampered
  submission can't smuggle arbitrary UUIDs/ids (still re-mapped). ✅
- **Webhook payload:** fully shape-guarded, tolerant of both string/object variants,
  never throws (`parseWebhookPayload`, `statusLabel`, `assigneeId`). ✅
- **Gap:** outbound preview does not escape mrkdwn (FIND-07).

### 4. The two secret-in-URL endpoints
- `api/slack/diag.ts` — GET, secret in query, **mutating** (`conversations.join`
  to an attacker-chosen `?join=<channel>`), and **info-disclosing** (bot identity,
  team, full channel membership list, Redis host). → FIND-01/02/03.
- `api/admin/refresh-config.ts` — GET, secret in query, **mutating** (cache
  eviction `redis.del(cfg:*)`). Low blast radius (re-fetch on next parse) but still
  a GET state change with a logged credential. → FIND-01/02.
- **Recommendation (Phase 8):** move auth to an `Authorization: Bearer <token>`
  header with a **dedicated** `OPS_API_TOKEN` (not the signing secret); require
  **POST** for the mutating actions; **env-gate or remove `diag`'s `join` capability
  in production**; consider Vercel deployment-protection / IP allowlist.

### 5. SSRF
- Confirmed no user-controlled URL/host/port reaches `fetch`. Fixed `BASE_URL`
  host; only env ids + HMAC-verified `taskId` reach the path. Stored `links` are
  never fetched. → FIND-11 (Low, hardening only: validate `taskId` format).

### 6. Dependency vulnerabilities (`npm audit`)
- **Runtime (`npm audit --omit=dev`): 0 vulnerabilities.** ✅
- **All deps: 21** (1 critical / 10 high / 9 moderate / 1 low) — **100% dev-only:**
  - `vercel` CLI tree → `@vercel/fun` → `@tootallnate/once`, `tar` (DoS), `uuid`,
    plus `@vercel/node` → `undici` (insufficient randomness), `path-to-regexp`
    (ReDoS backtracking), `ajv` (`$data` ReDoS), `esbuild` (dev-server SSRF).
  - `vitest`/`vite`/`esbuild` → `@vitest/mocker` (critical, test runner), `vite`
    path-traversal in optimized-deps `.map`.
- None of these are imported by the serverless functions. → FIND-05 (Medium,
  hygiene): bump `vercel` and `vitest` major versions in Phase 8 / CI, accept the
  dev-only residue.

### 7. Idempotency / integrity
- Create exactly-once via `claimPending` `GETDEL` + point-of-no-return discipline
  (`src/slack/interactions.ts:101-191`). ✅
- Slack event dedup `evt:` SET-NX-EX (`markEventOnce`), with deliberate
  clear-on-tail-failure for safe redelivery. ✅
- ClickUp webhook redelivery dedup `whk:` SET-NX-EX 24h, with content-hash fallback
  key when no item id (`buildDeliveryKey`). ✅
- **Residual:** redelivery dedup also functions as the *only* replay defense for the
  unauthenticated-timestamp ClickUp path → see FIND-04. → FIND-09 (Low): the
  content-hash key truncates SHA-256 to 16 hex chars (64-bit) — collision risk is
  negligible for this volume but noted.

---

## Prioritized Remediation Plan (→ Phase 8)

| ID | Title | Severity | OWASP | Location | Phase 8 Fix |
|----|-------|----------|-------|----------|-------------|
| **FIND-01** | Ops endpoints authenticate with the **signing secret in the URL query** (logged by proxies/Referer; credential overload) | **High** | A01/A02/A07 | `api/slack/diag.ts:40-43`, `api/admin/refresh-config.ts:29-32` | Introduce a dedicated `OPS_API_TOKEN` env; auth via `Authorization: Bearer` header (timing-safe), not the signing secret, not the query string. |
| **FIND-02** | State-changing actions over **GET**, no env-gate (bot self-join arbitrary channel; cache flush) | **High** | A01/A05 | `api/slack/diag.ts:77-85`, `api/admin/refresh-config.ts:27-49` | Require **POST** for mutations; gate the `join` capability behind a prod env flag (or remove); add Vercel deployment protection / IP allowlist. |
| **FIND-03** | `diag` discloses internal topology (channel list, bot identity, team, Redis host) | **Medium** | A05 | `api/slack/diag.ts:87-99` | Behind the new ops token; trim output to what ops genuinely needs; gate in prod. |
| **FIND-04** | ClickUp webhook has **no timestamp/replay protection** (only 24h dedup) | **Medium** | A02/A07 | `src/clickup/signature.ts`, `api/clickup/webhook.ts` | Document the dedup window as the accepted replay bound; if ClickUp exposes a timestamp/delivery-id header, bind it into verification + dedup. |
| **FIND-05** | Dev-toolchain dependency CVEs (`vercel` CLI, `vitest`/`vite`/`esbuild`) — **dev-only, 0 runtime** | **Medium** | A06 | `package.json` devDeps | Bump `vercel`→latest and `vitest`→v3+ in CI; re-run `npm audit --omit=dev` (already clean) as the release gate. |
| **FIND-06** | No rate limiting / abuse throttle on public ingress endpoints | **Medium** | A04/A05 | `api/slack/*`, `api/clickup/webhook.ts` | Acceptable for v1 (signature-gated); consider Upstash ratelimit on unauthenticated 401 attempts if abused. |
| **FIND-07** | Outbound preview does **not** escape Slack mrkdwn (inconsistent with inbound `escapeSlackText`) | **Low** | A03 | `src/slack/blocks.ts:79-87` | Apply the existing `escapeSlackText` to `title`/`description`/`links` in `buildPreviewBlocks`. |
| **FIND-08** | Kill switch is **fail-open** on Redis outage | **Low (accepted)** | A04 | `src/store/redis.ts:151-158` | Intentional (availability). Record as accepted risk; optionally add monitoring on Redis-down. |
| **FIND-09** | Content-hash dedup key truncated to 64-bit | **Low** | A08 | `src/clickup/webhook.ts:208-212` | Widen to 32 hex chars (128-bit) — cheap defense-in-depth. |
| **FIND-10** | No alerting/audit trail for ops actions | **Low** | A09 | ops endpoints | Log (without secrets) who/what for each ops invocation; wire a basic alert on repeated 401s. |
| **FIND-11** | `taskId` path segment not format-validated before ClickUp `GET` | **Low** | A10 | `src/clickup/client.ts:151-152` | Validate `taskId` against `^[A-Za-z0-9]+$` before interpolating into the URL path. |
| **FIND-12** | No explicit security response headers | **Info/DiD** | A05 | all `api/*` | Optional for JSON-only APIs; add `X-Content-Type-Options: nosniff` if cheap. |
| **FIND-13** | Verify `.env*`/secrets are git-ignored and never committed | **Info/DiD** | A02 | repo hygiene | Confirm `.gitignore` covers `.env.local`; rotate any secret ever exposed in a URL/log. |

### Accepted Risks Log
- **FIND-08** — Kill switch fail-open behavior is an explicit availability-over-safety
  design decision (HARD-03). Accepted for v1.1.
- **FIND-04** — Replay protection bounded by the 24h webhook dedup TTL, accepted
  until/unless ClickUp provides a signed timestamp.
- **FIND-05** — Dev-only dependency CVEs accepted for runtime (0 runtime vulns);
  toolchain bump tracked for Phase 8 hygiene.

---

*Audit only — no source code was modified. Implementation fixes are Phase 8.*
