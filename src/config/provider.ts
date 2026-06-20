/**
 * Dynamic config provider (DYN-01/02/03/05). The single point where "where does
 * config come from" flips from hardcoded to live-with-fallback.
 *
 * Each getter follows a 3-tier resolution:
 *   1. readConfigCache  — the hot Redis cache (cfg:<name>, ~10min TTL)
 *   2. live ClickUp fetch → writeConfigCache (populates cache + last-good)
 *   3. on fetch failure: readConfigLastGood → else the STATIC maps
 *
 * The static maps (clients.ts / members.ts) stay in the repo as the safety net
 * and the source of the curated alias overlay — they are NEVER deleted. Curated
 * aliases (feli, vero, aprendoseo→Interno, …) are merged on top of the live
 * names so the team's product-knowledge shortcuts survive a live fetch.
 *
 * Every cache/fetch path is wrapped so a Redis or ClickUp failure degrades to
 * the next tier instead of throwing into the caller — the parse flow must never
 * break because config is momentarily unavailable (DYN-05).
 */
import { CLIENTS, CLIENT_ALIASES } from "./clients.js";
import { MEMBERS, MEMBER_ALIASES } from "./members.js";
import type { ClickUpClient } from "../clickup/client.js";
import type { ClienteOption, ClickUpMember } from "../clickup/types.js";
import {
  readConfigCache,
  readConfigLastGood,
  writeConfigCache,
  type RedisLike,
} from "../store/redis.js";

/**
 * Resolved Cliente config: lowercased name → option UUID, plus a lowercased
 * alias → option UUID overlay. Both values are dropdown option UUIDs so the
 * resolver returns a UUID directly from either map.
 */
export type ClientesConfig = {
  byName: Record<string, string>;
  aliases: Record<string, string>;
};

/**
 * Resolved Members config: lowercased name → member id, alias → member id, and
 * lowercased email → member id (DYN-04). The static fallback leaves byEmail
 * empty (the static maps have no emails).
 */
export type MembersConfig = {
  byName: Record<string, number>;
  aliases: Record<string, number>;
  byEmail: Record<string, number>;
};

export type ConfigProvider = {
  getClientes(): Promise<ClientesConfig>;
  getMembers(): Promise<MembersConfig>;
};

const CLIENTES_CACHE_NAME = "clientes";
const MEMBERS_CACHE_NAME = "members";

// ── Pure builders ──────────────────────────────────────────────────────────

/**
 * Build a ClientesConfig from live ClickUp options, then merge the curated
 * aliases on top: each CLIENT_ALIASES[alias] = canonicalName resolves to the
 * live UUID for that name, falling back to the static CLIENTS UUID if the name
 * isn't present live (so a curated shortcut never goes dead).
 */
export function buildClientesConfig(liveOptions: ClienteOption[]): ClientesConfig {
  const byName: Record<string, string> = {};
  for (const opt of liveOptions) {
    if (opt && typeof opt.name === "string" && typeof opt.id === "string") {
      byName[opt.name.toLowerCase()] = opt.id;
    }
  }

  const aliases: Record<string, string> = {};
  for (const alias of Object.keys(CLIENT_ALIASES)) {
    const canonical = (CLIENT_ALIASES as Record<string, string>)[alias]!;
    const liveId = byName[canonical.toLowerCase()];
    const staticId = (CLIENTS as Record<string, string>)[canonical];
    const id = liveId ?? staticId;
    if (id != null) aliases[alias] = id;
  }

  return { byName, aliases };
}

/**
 * Build a MembersConfig from live ClickUp members (byName + byEmail), then merge
 * the curated member aliases on top (live id, falling back to the static id).
 */
export function buildMembersConfig(liveMembers: ClickUpMember[]): MembersConfig {
  const byName: Record<string, number> = {};
  const byEmail: Record<string, number> = {};
  for (const m of liveMembers) {
    if (m && typeof m.name === "string" && typeof m.id === "number") {
      byName[m.name.toLowerCase()] = m.id;
      if (typeof m.email === "string" && m.email.length > 0) {
        byEmail[m.email.toLowerCase()] = m.id;
      }
    }
  }

  const aliases: Record<string, number> = {};
  for (const alias of Object.keys(MEMBER_ALIASES)) {
    const canonical = (MEMBER_ALIASES as Record<string, string>)[alias]!;
    const liveId = byName[canonical.toLowerCase()];
    const staticId = (MEMBERS as Record<string, number>)[canonical];
    const id = liveId ?? staticId;
    if (id != null) aliases[alias] = id;
  }

  return { byName, aliases, byEmail };
}

/** Build the Cliente config purely from the static maps (the ultimate fallback). */
export function staticClientesConfig(): ClientesConfig {
  const byName: Record<string, string> = {};
  for (const name of Object.keys(CLIENTS)) {
    byName[name.toLowerCase()] = (CLIENTS as Record<string, string>)[name]!;
  }
  const aliases: Record<string, string> = {};
  for (const alias of Object.keys(CLIENT_ALIASES)) {
    const canonical = (CLIENT_ALIASES as Record<string, string>)[alias]!;
    const id = (CLIENTS as Record<string, string>)[canonical];
    if (id != null) aliases[alias] = id;
  }
  return { byName, aliases };
}

/** Build the Members config purely from the static maps (byEmail empty). */
export function staticMembersConfig(): MembersConfig {
  const byName: Record<string, number> = {};
  for (const name of Object.keys(MEMBERS)) {
    byName[name.toLowerCase()] = (MEMBERS as Record<string, number>)[name]!;
  }
  const aliases: Record<string, number> = {};
  for (const alias of Object.keys(MEMBER_ALIASES)) {
    const canonical = (MEMBER_ALIASES as Record<string, string>)[alias]!;
    const id = (MEMBERS as Record<string, number>)[canonical];
    if (id != null) aliases[alias] = id;
  }
  return { byName, aliases, byEmail: {} };
}

// ── Provider ───────────────────────────────────────────────────────────────

/**
 * Generic 3-tier resolution shared by both getters. Reads the hot cache; on a
 * miss fetches live and populates cache + last-good; on a fetch failure serves
 * last-good then the static fallback. Never throws — every tier is wrapped.
 */
async function resolveTiered<T>(
  name: string,
  redis: RedisLike,
  fetchLive: () => Promise<T>,
  staticFallback: () => T,
): Promise<T> {
  // Tier 1: hot cache.
  try {
    const cached = await readConfigCache<T>(redis, name);
    if (cached) return cached;
  } catch (err) {
    console.error(
      `[config] readConfigCache(${name}) failed — degrading to live fetch:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Tier 2: live ClickUp fetch → populate cache + last-good.
  try {
    const live = await fetchLive();
    try {
      await writeConfigCache(redis, name, live);
    } catch (writeErr) {
      console.error(
        `[config] writeConfigCache(${name}) failed (serving live anyway):`,
        writeErr instanceof Error ? writeErr.message : String(writeErr),
      );
    }
    return live;
  } catch (fetchErr) {
    console.error(
      `[config] live fetch for ${name} failed — falling back to last-good/static:`,
      fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
    );
  }

  // Tier 3a: non-expiring last-good safety net.
  try {
    const lastGood = await readConfigLastGood<T>(redis, name);
    if (lastGood) {
      console.error(`[config] ${name}: served last-good cache (DYN-05 fallback)`);
      return lastGood;
    }
  } catch (lgErr) {
    console.error(
      `[config] readConfigLastGood(${name}) failed — falling back to static maps:`,
      lgErr instanceof Error ? lgErr.message : String(lgErr),
    );
  }

  // Tier 3b: the static maps in the repo (always available).
  console.error(`[config] ${name}: served STATIC maps (DYN-05 final fallback)`);
  return staticFallback();
}

/**
 * Build the dynamic config provider. `clickup` supplies the live reads (plan 01)
 * and `redis` the cache (plan 01). Lazy/per-call — each getter resolves fresh
 * through the 3-tier path; the Redis TTL bounds how often a live fetch happens.
 */
export function createConfigProvider(deps: {
  clickup: Pick<ClickUpClient, "getClienteOptions" | "getMembers">;
  redis: RedisLike;
}): ConfigProvider {
  const { clickup, redis } = deps;
  return {
    getClientes() {
      return resolveTiered<ClientesConfig>(
        CLIENTES_CACHE_NAME,
        redis,
        async () => buildClientesConfig(await clickup.getClienteOptions()),
        staticClientesConfig,
      );
    },
    getMembers() {
      return resolveTiered<MembersConfig>(
        MEMBERS_CACHE_NAME,
        redis,
        async () => buildMembersConfig(await clickup.getMembers()),
        staticMembersConfig,
      );
    },
  };
}
