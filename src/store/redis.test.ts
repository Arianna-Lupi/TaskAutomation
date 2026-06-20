import { describe, it, expect, vi } from "vitest";
import {
  markEventOnce,
  markWebhookDeliveryOnce,
  clearEvent,
  createRedis,
  putPending,
  getPending,
  claimPending,
  deletePending,
  mapTaskToThread,
  getThreadForTask,
  isKillSwitchActive,
  setKillSwitch,
  writeConfigCache,
  readConfigCache,
  readConfigLastGood,
  clearConfigCache,
  CONFIG_CACHE_TTL_SECONDS,
  type RedisLike,
  type PendingTask,
} from "./redis.js";
import type { ResolvedTask } from "../resolve/types.js";

const noopGet: RedisLike["get"] = vi.fn().mockResolvedValue(null);
const noopGetdel: RedisLike["getdel"] = vi.fn().mockResolvedValue(null);

function fakeRedis(
  setImpl: RedisLike["set"],
  delImpl: RedisLike["del"] = vi.fn().mockResolvedValue(1),
): RedisLike {
  return { set: setImpl, del: delImpl, get: noopGet, getdel: noopGetdel };
}

/**
 * Map-backed in-memory RedisLike honoring nx on set and GETDEL semantics. Values
 * are stored as the raw strings our helpers write; get/getdel parse-or-return as
 * @upstash/redis would (we return the stored string and let coerceJson parse).
 */
function memRedis(): RedisLike {
  const store = new Map<string, unknown>();
  return {
    async set(key, value, opts) {
      if (opts?.nx && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async getdel(key) {
      if (!store.has(key)) return null;
      const v = store.get(key);
      store.delete(key);
      return v;
    },
    async del(...keys) {
      let removed = 0;
      for (const k of keys) if (store.delete(k)) removed += 1;
      return removed;
    },
  };
}

const sampleResolved: ResolvedTask = {
  title: "Diseñar landing",
  description: null,
  clienteOptionId: "63d9626f-9b80-4a19-8638-93b8042d2e9c",
  assigneeIds: [216158839],
  unresolvedAssignees: [],
  startDateMs: null,
  dueDateMs: 1718600000000,
  links: [],
};

const samplePending: PendingTask = {
  resolved: sampleResolved,
  channel: "C_TASK",
  messageTs: "1700000000.000100",
  threadTs: "1700000000.000100",
  rawText: "diseñar landing para feli, entrega mañana",
};

describe("markEventOnce", () => {
  it("returns true when set(...) resolves OK (key was new)", async () => {
    const redis = fakeRedis(vi.fn().mockResolvedValue("OK"));
    await expect(markEventOnce(redis, "E1")).resolves.toBe(true);
  });

  it("returns false when set(...) resolves null (key already existed → retry)", async () => {
    const redis = fakeRedis(vi.fn().mockResolvedValue(null));
    await expect(markEventOnce(redis, "E1")).resolves.toBe(false);
  });

  it("calls set with namespaced key, value 1, and { nx: true, ex: 600 } default", async () => {
    const set = vi.fn().mockResolvedValue("OK");
    await markEventOnce(fakeRedis(set), "abc");
    expect(set).toHaveBeenCalledWith("evt:abc", 1, { nx: true, ex: 600 });
  });

  it("honors a custom ttl", async () => {
    const set = vi.fn().mockResolvedValue("OK");
    await markEventOnce(fakeRedis(set), "abc", 30);
    expect(set).toHaveBeenCalledWith("evt:abc", 1, { nx: true, ex: 30 });
  });

  it("is idempotent across a retry: true then false for the same event_id", async () => {
    const store = new Set<string>();
    const redis = fakeRedis(async (key) => {
      if (store.has(key)) return null;
      store.add(key);
      return "OK";
    });
    expect(await markEventOnce(redis, "dup")).toBe(true);
    expect(await markEventOnce(redis, "dup")).toBe(false);
  });
});

describe("markWebhookDeliveryOnce", () => {
  it("returns true the first time a delivery key is seen, false on redelivery", async () => {
    const redis = memRedis();
    expect(await markWebhookDeliveryOnce(redis, "d1")).toBe(true);
    expect(await markWebhookDeliveryOnce(redis, "d1")).toBe(false);
  });

  it("calls set with the 'whk:' namespace, value 1, and { nx: true, ex: 86400 } default", async () => {
    const set = vi.fn().mockResolvedValue("OK");
    await markWebhookDeliveryOnce(fakeRedis(set), "d2");
    expect(set).toHaveBeenCalledWith("whk:d2", 1, { nx: true, ex: 86400 });
  });

  it("honors a custom ttl", async () => {
    const set = vi.fn().mockResolvedValue("OK");
    await markWebhookDeliveryOnce(fakeRedis(set), "d3", 120);
    expect(set).toHaveBeenCalledWith("whk:d3", 1, { nx: true, ex: 120 });
  });

  it("uses a namespace isolated from the Slack 'evt:' dedup keys", async () => {
    const redis = memRedis();
    // Same logical id used as a Slack event AND a webhook delivery must not collide.
    expect(await markEventOnce(redis, "shared")).toBe(true);
    expect(await markWebhookDeliveryOnce(redis, "shared")).toBe(true);
  });
});

describe("clearEvent", () => {
  it("DELs the namespaced dedup key for the eventId", async () => {
    const del = vi.fn().mockResolvedValue(1);
    await clearEvent(fakeRedis(vi.fn(), del), "abc");
    expect(del).toHaveBeenCalledWith("evt:abc");
  });

  it("re-arms markEventOnce: clear then mark returns true again", async () => {
    const store = new Set<string>();
    const redis = fakeRedis(
      async (key) => {
        if (store.has(key)) return null;
        store.add(key);
        return "OK";
      },
      async (...keys: string[]) => {
        let removed = 0;
        for (const key of keys) if (store.delete(key)) removed += 1;
        return removed;
      },
    );
    expect(await markEventOnce(redis, "dup")).toBe(true);
    expect(await markEventOnce(redis, "dup")).toBe(false);
    await clearEvent(redis, "dup");
    expect(await markEventOnce(redis, "dup")).toBe(true);
  });
});

describe("createRedis", () => {
  it("throws clearly when URL or token is absent", () => {
    expect(() =>
      createRedis({ UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "" }),
    ).toThrow(/UPSTASH_REDIS_REST_URL|UPSTASH_REDIS_REST_TOKEN/);
  });

  it("builds a client with set(...) when given url + token", () => {
    const client = createRedis({
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "token-abc",
    });
    expect(typeof client.set).toBe("function");
  });
});

describe("pending-task store", () => {
  it("putPending → getPending round-trips the pending task", async () => {
    const redis = memRedis();
    await putPending(redis, "P1", samplePending);
    expect(await getPending(redis, "P1")).toEqual(samplePending);
  });

  it("getPending on a missing key returns null", async () => {
    expect(await getPending(memRedis(), "nope")).toBeNull();
  });

  it("getPending is non-destructive (a second read still returns the value)", async () => {
    const redis = memRedis();
    await putPending(redis, "P1", samplePending);
    await getPending(redis, "P1");
    expect(await getPending(redis, "P1")).toEqual(samplePending);
  });

  it("writes pending:<id> as JSON with an EX ttl", async () => {
    const set = vi.fn().mockResolvedValue("OK");
    const redis = { ...memRedis(), set };
    await putPending(redis, "P1", samplePending, 1234);
    expect(set).toHaveBeenCalledWith(
      "pending:P1",
      JSON.stringify(samplePending),
      { ex: 1234 },
    );
  });

  it("claimPending returns the value EXACTLY once, then null (idempotent confirm)", async () => {
    const redis = memRedis();
    await putPending(redis, "P1", samplePending);
    expect(await claimPending(redis, "P1")).toEqual(samplePending);
    expect(await claimPending(redis, "P1")).toBeNull();
  });

  it("deletePending removes the key", async () => {
    const redis = memRedis();
    await putPending(redis, "P1", samplePending);
    await deletePending(redis, "P1");
    expect(await getPending(redis, "P1")).toBeNull();
  });

  it("tolerates an already-parsed object from @upstash/redis on read", async () => {
    const redis = memRedis();
    // Simulate @upstash/redis auto-deserializing JSON into an object.
    await redis.set("pending:P2", samplePending as unknown);
    expect(await getPending(redis, "P2")).toEqual(samplePending);
  });
});

describe("kill switch (HARD-03)", () => {
  it("isKillSwitchActive → true when killswitch:<channelId> is present", async () => {
    const redis = memRedis();
    await setKillSwitch(redis, "C_LIVE", true);
    expect(await isKillSwitchActive(redis, "C_LIVE")).toBe(true);
  });

  it("isKillSwitchActive → true when the global killswitch:all is present (per-channel absent)", async () => {
    const redis = memRedis();
    await redis.set("killswitch:all", 1);
    expect(await isKillSwitchActive(redis, "C_ANY")).toBe(true);
  });

  it("isKillSwitchActive → false when neither key is present (default = enabled)", async () => {
    const redis = memRedis();
    expect(await isKillSwitchActive(redis, "C_LIVE")).toBe(false);
  });

  it("FAILS OPEN: a throwing get returns false (Redis down → still processes) and logs", async () => {
    const err = new Error("redis down");
    const redis: RedisLike = {
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1),
      getdel: noopGetdel,
      get: vi.fn().mockRejectedValue(err),
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await isKillSwitchActive(redis, "C_LIVE")).toBe(false);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("checks the per-channel key with the killswitch: namespace", async () => {
    const get = vi.fn().mockResolvedValue(null);
    const redis: RedisLike = { set: vi.fn(), del: vi.fn(), getdel: noopGetdel, get };
    await isKillSwitchActive(redis, "C123");
    expect(get).toHaveBeenCalledWith("killswitch:C123");
  });

  it("setKillSwitch(..., true) persists the per-channel key (no NX, no TTL)", async () => {
    const set = vi.fn().mockResolvedValue("OK");
    const redis: RedisLike = { set, del: vi.fn(), getdel: noopGetdel, get: noopGet };
    await setKillSwitch(redis, "C123", true);
    expect(set).toHaveBeenCalledWith("killswitch:C123", 1);
  });

  it("setKillSwitch(..., false) deletes the per-channel key", async () => {
    const del = vi.fn().mockResolvedValue(1);
    const redis: RedisLike = { set: vi.fn(), del, getdel: noopGetdel, get: noopGet };
    await setKillSwitch(redis, "C123", false);
    expect(del).toHaveBeenCalledWith("killswitch:C123");
  });

  it("round-trips: set on → active, set off → inactive", async () => {
    const redis = memRedis();
    await setKillSwitch(redis, "C_LIVE", true);
    expect(await isKillSwitchActive(redis, "C_LIVE")).toBe(true);
    await setKillSwitch(redis, "C_LIVE", false);
    expect(await isKillSwitchActive(redis, "C_LIVE")).toBe(false);
  });

  it("uses a namespace isolated from evt:/whk:/pending:/task2thread:", async () => {
    const redis = memRedis();
    // The same id used as an event/delivery/pending must not flip the switch.
    await markEventOnce(redis, "shared");
    await markWebhookDeliveryOnce(redis, "shared");
    await putPending(redis, "shared", samplePending);
    expect(await isKillSwitchActive(redis, "shared")).toBe(false);
  });
});

describe("task↔thread map", () => {
  it("mapTaskToThread → getThreadForTask round-trips {channel, thread_ts}", async () => {
    const redis = memRedis();
    const ref = { channel: "C_TASK", thread_ts: "1700000000.000100" };
    await mapTaskToThread(redis, "task123", ref);
    expect(await getThreadForTask(redis, "task123")).toEqual(ref);
  });

  it("getThreadForTask on a missing task returns null", async () => {
    expect(await getThreadForTask(memRedis(), "nope")).toBeNull();
  });

  it("writes task2thread:<id> as JSON with the long TTL by default", async () => {
    const set = vi.fn().mockResolvedValue("OK");
    const redis = { ...memRedis(), set };
    const ref = { channel: "C_TASK", thread_ts: "1700000000.000100" };
    await mapTaskToThread(redis, "task123", ref);
    expect(set).toHaveBeenCalledWith(
      "task2thread:task123",
      JSON.stringify(ref),
      { ex: 2592000 },
    );
  });
});

// ── Phase 6: dynamic-config cache (DYN-02 / DYN-05) ────────────────────────

/**
 * Map-backed RedisLike that ALSO records the per-key opts (so a test can assert
 * the TTL'd write vs the no-TTL last-good write). Mirrors memRedis semantics.
 */
function memRedisWithOpts(): RedisLike & {
  opts: Map<string, { nx?: true; ex?: number } | undefined>;
  store: Map<string, unknown>;
} {
  const store = new Map<string, unknown>();
  const opts = new Map<string, { nx?: true; ex?: number } | undefined>();
  return {
    store,
    opts,
    async set(key, value, o) {
      if (o?.nx && store.has(key)) return null;
      store.set(key, value);
      opts.set(key, o);
      return "OK";
    },
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async getdel(key) {
      if (!store.has(key)) return null;
      const v = store.get(key);
      store.delete(key);
      return v;
    },
    async del(...keys) {
      let removed = 0;
      for (const k of keys) if (store.delete(k)) removed += 1;
      return removed;
    },
  };
}

describe("writeConfigCache", () => {
  it("writes cfg:<name> with a ~600s TTL AND cfg:<name>:lastgood with NO TTL", async () => {
    const redis = memRedisWithOpts();
    await writeConfigCache(redis, "clientes", { byName: { A: "uuid-a" } });

    expect(redis.store.has("cfg:clientes")).toBe(true);
    expect(redis.store.has("cfg:clientes:lastgood")).toBe(true);
    expect(redis.opts.get("cfg:clientes")).toEqual({ ex: CONFIG_CACHE_TTL_SECONDS });
    // last-good must have NO opts (no TTL) — the persistent safety net.
    expect(redis.opts.get("cfg:clientes:lastgood")).toBeUndefined();
  });

  it("stores JSON that round-trips through readConfigCache/readConfigLastGood", async () => {
    const redis = memRedisWithOpts();
    const data = { byName: { Felipe: "u1" }, aliases: { feli: "u1" } };
    await writeConfigCache(redis, "clientes", data);
    expect(await readConfigCache(redis, "clientes")).toEqual(data);
    expect(await readConfigLastGood(redis, "clientes")).toEqual(data);
  });
});

describe("readConfigCache", () => {
  it("returns the parsed object on a hit", async () => {
    const redis = memRedisWithOpts();
    await writeConfigCache(redis, "members", { byName: { X: 1 } });
    expect(await readConfigCache(redis, "members")).toEqual({ byName: { X: 1 } });
  });

  it("returns null on a miss (absent/expired key)", async () => {
    const redis = memRedisWithOpts();
    expect(await readConfigCache(redis, "members")).toBeNull();
  });

  it("tolerates an already-parsed object (upstash auto-deserialize)", async () => {
    const redis = memRedisWithOpts();
    redis.store.set("cfg:members", { byName: { X: 1 } });
    expect(await readConfigCache(redis, "members")).toEqual({ byName: { X: 1 } });
  });
});

describe("readConfigLastGood", () => {
  it("returns last-good on a hit and null on a miss", async () => {
    const redis = memRedisWithOpts();
    expect(await readConfigLastGood(redis, "clientes")).toBeNull();
    await writeConfigCache(redis, "clientes", { byName: { A: "x" } });
    expect(await readConfigLastGood(redis, "clientes")).toEqual({ byName: { A: "x" } });
  });
});

describe("clearConfigCache", () => {
  it("DELs only the TTL'd cfg:<name> keys, leaving last-good intact", async () => {
    const redis = memRedisWithOpts();
    await writeConfigCache(redis, "clientes", { a: 1 });
    await writeConfigCache(redis, "members", { b: 2 });

    await clearConfigCache(redis, "clientes", "members");

    expect(redis.store.has("cfg:clientes")).toBe(false);
    expect(redis.store.has("cfg:members")).toBe(false);
    // The safety net survives a refresh.
    expect(redis.store.has("cfg:clientes:lastgood")).toBe(true);
    expect(redis.store.has("cfg:members:lastgood")).toBe(true);
  });

  it("no-ops on an empty name list", async () => {
    const del = vi.fn().mockResolvedValue(0);
    const redis: RedisLike = { set: vi.fn(), del, getdel: noopGetdel, get: noopGet };
    await clearConfigCache(redis);
    expect(del).not.toHaveBeenCalled();
  });
});
