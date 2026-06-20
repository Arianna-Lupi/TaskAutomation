---
phase: 06-dynamic-config-from-clickup
plan: 02
subsystem: config-provider + resolver
tags: [dynamic-config, provider, resolver, fallback]
requires: [06-01]
provides:
  - "createConfigProvider — getClientes/getMembers with 3-tier fallback (cache→last-good→static)"
  - "ClientesConfig / MembersConfig shapes + pure builders (build*/static*)"
  - "resolveCliente/resolveAssignees/resolveTask accept injected config, default to static"
affects: [src/config/provider.ts, src/resolve/cliente.ts, src/resolve/assignees.ts, src/resolve/index.ts]
tech-stack:
  added: []
  patterns: [provider-injection, 3-tier-resolution, alias-overlay, backward-compatible-defaults]
key-files:
  created:
    - src/config/provider.ts
    - src/config/provider.test.ts
  modified:
    - src/resolve/cliente.ts
    - src/resolve/cliente.test.ts
    - src/resolve/assignees.ts
    - src/resolve/assignees.test.ts
    - src/resolve/index.ts
    - src/resolve/index.test.ts
decisions:
  - "Config shapes key byName/aliases by LOWERCASED name → id; resolvers do an Object.hasOwn-guarded direct lookup (no per-call loop)"
  - "Curated aliases resolve to the LIVE uuid for their canonical name, falling back to the static uuid when the name isn't present live"
  - "Resolvers default to staticClientesConfig()/staticMembersConfig() when no config injected → identical v1.0 behavior"
metrics:
  duration: "~20m"
  completed: 2026-06-19
---

# Phase 6 Plan 02: Config provider + resolver injection Summary

Built the config provider (the single place where config flips from hardcoded to live-with-fallback) and switched the resolvers to provider-injection while staying byte-for-byte backward-compatible via static defaults.

## What was built

- **src/config/provider.ts** — `createConfigProvider({ clickup, redis })` exposing `getClientes()`/`getMembers()`. Each getter runs a shared `resolveTiered` helper: hot cache → live fetch (populates cache + last-good) → last-good → static maps, every tier wrapped so a ClickUp/Redis failure degrades instead of throwing (DYN-05). Pure builders `buildClientesConfig`/`buildMembersConfig` merge the curated alias overlay on top of live names; `staticClientesConfig`/`staticMembersConfig` build the fallback from the untouched static maps. `byEmail` (lowercased) populated from live members for DYN-04.
- **src/resolve/cliente.ts / assignees.ts** — accept an optional injected config, default to the static config builders. Object.hasOwn prototype-pollution guards preserved on every tier; the Slack-override tier in assignees is unchanged and still runs first.
- **src/resolve/index.ts** — `resolveTask` opts gained `clientesConfig`/`membersConfig`, threaded into the two resolvers. Config types re-exported from the barrel.

## Tests

- provider.test.ts: 14 tests (cache hit/miss, last-good, static fallback, Redis-throw degrade, alias overlay, byEmail). 
- Resolver suites: +13 new dynamic-injection tests; all prior resolver tests pass unchanged. Full suite 276 passing / 2 skipped (up from 235).

## Deviations from Plan

None — plan executed as written. (Static maps clients.ts/members.ts left untouched as the safety net + alias source.)

## Self-Check: PASSED
- src/config/provider.ts present (min_lines satisfied), contains getClientes.
- `grep -c 'export const CLIENTS' src/config/clients.ts` == 1, `export const MEMBERS` == 1 (static maps preserved).
- Commits b7d6248, b407552 exist on phase-06-dynamic-config.
