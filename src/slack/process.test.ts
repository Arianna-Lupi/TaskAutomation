import { describe, it, expect, vi } from "vitest";
import {
  processMessageEvent,
  RECEIPT_TEXT,
  type SlackClientLike,
  type ProcessDeps,
} from "./process.js";
import type { RedisLike } from "../store/redis.js";

const TASK_CHANNEL = "C_TASK";

function nxRedis(): RedisLike & {
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
} {
  const seen = new Set<string>();
  return {
    set: vi.fn(async (key: string) => {
      if (seen.has(key)) return null;
      seen.add(key);
      return "OK";
    }),
    del: vi.fn(async (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) {
        if (seen.delete(key)) removed += 1;
      }
      return removed;
    }),
  };
}

function fakeClient(): SlackClientLike & {
  chat: { postMessage: ReturnType<typeof vi.fn> };
} {
  return { chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) } };
}

function deps(over: Partial<ProcessDeps> = {}): ProcessDeps {
  return {
    redis: nxRedis(),
    client: fakeClient(),
    env: { SLACK_TASK_CHANNEL_ID: TASK_CHANNEL },
    botUserId: "U_BOT",
    ...over,
  };
}

const goodMessage = {
  channel: TASK_CHANNEL,
  user: "U_HUMAN",
  ts: "1700000000.000100",
};

describe("processMessageEvent", () => {
  it("posts exactly one in-thread receipt for a valid captured message", async () => {
    const d = deps();
    await processMessageEvent(d, { eventId: "E1", message: goodMessage });
    const post = (d.client as ReturnType<typeof fakeClient>).chat.postMessage;
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({
      channel: TASK_CHANNEL,
      thread_ts: goodMessage.ts,
      text: RECEIPT_TEXT,
    });
    expect(RECEIPT_TEXT.length).toBeGreaterThan(0);
  });

  it("dedups: a retry of the same event_id posts no second receipt", async () => {
    const d = deps();
    await processMessageEvent(d, { eventId: "Edup", message: goodMessage });
    await processMessageEvent(d, { eventId: "Edup", message: goodMessage });
    const post = (d.client as ReturnType<typeof fakeClient>).chat.postMessage;
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("ignores a message that fails the filter (no postMessage)", async () => {
    const d = deps();
    await processMessageEvent(d, {
      eventId: "E2",
      message: { ...goodMessage, channel: "C_OTHER" },
    });
    const post = (d.client as ReturnType<typeof fakeClient>).chat.postMessage;
    expect(post).not.toHaveBeenCalled();
  });

  it("ignores the bot's own message (echo loop)", async () => {
    const d = deps();
    await processMessageEvent(d, {
      eventId: "E3",
      message: { ...goodMessage, user: "U_BOT" },
    });
    const post = (d.client as ReturnType<typeof fakeClient>).chat.postMessage;
    expect(post).not.toHaveBeenCalled();
  });

  it("never throws into the ack path when postMessage rejects", async () => {
    const client = fakeClient();
    client.chat.postMessage.mockRejectedValueOnce(new Error("slack 500"));
    const d = deps({ client });
    await expect(
      processMessageEvent(d, { eventId: "E4", message: goodMessage }),
    ).resolves.toBeUndefined();
  });

  it("clears the dedup key on a transient postMessage failure so a redelivery re-posts", async () => {
    const redis = nxRedis();
    const client = fakeClient();
    // First attempt fails transiently; the redelivery succeeds.
    client.chat.postMessage.mockRejectedValueOnce(new Error("slack 429"));
    const d = deps({ redis, client });

    await processMessageEvent(d, { eventId: "Eretry", message: goodMessage });
    // The dedup key must have been released after the failed receipt.
    expect(redis.del).toHaveBeenCalledWith("evt:Eretry");
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);

    // Slack redelivers the same event_id — it must be re-attempted and posted.
    await processMessageEvent(d, { eventId: "Eretry", message: goodMessage });
    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
  });

  it("does NOT clear the dedup key for a true duplicate on the success path", async () => {
    const redis = nxRedis();
    const client = fakeClient();
    const d = deps({ redis, client });

    await processMessageEvent(d, { eventId: "Eok", message: goodMessage });
    await processMessageEvent(d, { eventId: "Eok", message: goodMessage });

    // Receipt posted exactly once, and the key was never released.
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(redis.del).not.toHaveBeenCalled();
  });
});
