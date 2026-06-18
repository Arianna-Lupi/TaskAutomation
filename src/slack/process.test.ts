import { describe, it, expect, vi } from "vitest";
import {
  processMessageEvent,
  RECEIPT_TEXT,
  type SlackClientLike,
  type ProcessDeps,
} from "./process.js";
import type { RedisLike } from "../store/redis.js";

const TASK_CHANNEL = "C_TASK";

function nxRedis(): RedisLike {
  const seen = new Set<string>();
  return {
    set: vi.fn(async (key: string) => {
      if (seen.has(key)) return null;
      seen.add(key);
      return "OK";
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
});
