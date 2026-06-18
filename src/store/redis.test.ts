import { describe, it, expect, vi } from "vitest";
import { markEventOnce, clearEvent, createRedis, type RedisLike } from "./redis.js";

function fakeRedis(
  setImpl: RedisLike["set"],
  delImpl: RedisLike["del"] = vi.fn().mockResolvedValue(1),
): RedisLike {
  return { set: setImpl, del: delImpl };
}

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
