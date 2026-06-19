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
