import { describe, it, expect, vi } from "vitest";
import {
  processMessageEvent,
  RECEIPT_TEXT,
  type SlackClientLike,
  type ProcessDeps,
} from "./process.js";
import { PARSE_ERROR_MESSAGE, GENERIC_ERROR_MESSAGE } from "./report.js";
import type { RedisLike } from "../store/redis.js";
import type { OpenAILike } from "../llm/openai.js";
import type { ParsedTask } from "../resolve/types.js";

const TASK_CHANNEL = "C_TASK";

/** In-memory RedisLike honoring nx (set) + GETDEL, with spyable set/del. */
function memRedis(): RedisLike & {
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
} {
  const store = new Map<string, unknown>();
  const set = vi.fn(async (key: string, value: unknown, opts?: { nx?: true }) => {
    if (opts?.nx && store.has(key)) return null;
    store.set(key, value);
    return "OK";
  });
  const del = vi.fn(async (...keys: string[]) => {
    let removed = 0;
    for (const key of keys) if (store.delete(key)) removed += 1;
    return removed;
  });
  return {
    set,
    del,
    get: vi.fn(async (k: string) => (store.has(k) ? store.get(k) : null)),
    getdel: vi.fn(async (k: string) => {
      if (!store.has(k)) return null;
      const v = store.get(k);
      store.delete(k);
      return v;
    }),
  };
}

function fakeClient(): SlackClientLike & {
  chat: { postMessage: ReturnType<typeof vi.fn> };
} {
  return { chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) } };
}

/** A fake OpenAILike returning a fixed ParsedTask so the pipeline runs offline. */
function fakeParseClient(parsed: ParsedTask): OpenAILike {
  return {
    chat: {
      completions: {
        parse: vi.fn(async () => ({
          choices: [{ message: { parsed, refusal: null } }],
        })),
      },
    },
  };
}

const parsedTask: ParsedTask = {
  title: "Diseñar landing",
  description: "landing de campaña",
  clienteRaw: "feli",
  assigneesRaw: ["miguel"],
  startDatePhrase: null,
  dueDatePhrase: null,
  links: [],
};

function deps(over: Partial<ProcessDeps> = {}): ProcessDeps {
  return {
    redis: memRedis(),
    client: fakeClient(),
    env: { SLACK_TASK_CHANNEL_ID: TASK_CHANNEL, TEAM_TIMEZONE: "America/Caracas" },
    parseDeps: { client: fakeParseClient(parsedTask), model: "gpt-4o-mini", timezone: "America/Caracas" },
    genPendingId: () => "PID-test",
    now: () => Date.UTC(2026, 5, 18, 12, 0, 0),
    botUserId: "U_BOT",
    ...over,
  };
}

const goodMessage = {
  channel: TASK_CHANNEL,
  user: "U_HUMAN",
  ts: "1700000000.000100",
  text: "diseñar landing para feli con miguel",
};

describe("processMessageEvent", () => {
  it("parses, persists a pending, and posts a preview (not the placeholder)", async () => {
    const d = deps();
    await processMessageEvent(d, { eventId: "E1", message: goodMessage });

    const redis = d.redis as ReturnType<typeof memRedis>;
    // A pending was written under pending:<id>.
    expect(redis.set).toHaveBeenCalledWith(
      "pending:PID-test",
      expect.any(String),
      expect.objectContaining({ ex: expect.any(Number) }),
    );

    const post = (d.client as ReturnType<typeof fakeClient>).chat.postMessage;
    expect(post).toHaveBeenCalledTimes(1);
    const arg = post.mock.calls[0]![0];
    expect(arg.channel).toBe(TASK_CHANNEL);
    expect(arg.thread_ts).toBe(goodMessage.ts);
    expect(Array.isArray(arg.blocks)).toBe(true);
    // The preview carries the resolved cliente name, not the 👀 placeholder.
    expect(JSON.stringify(arg.blocks)).toContain("Felipe Vergara");
  });

  it("dedups: a retry of the same event_id posts no second preview", async () => {
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
    expect((d.client as ReturnType<typeof fakeClient>).chat.postMessage).not.toHaveBeenCalled();
  });

  it("skips a processable message with empty text (no preview)", async () => {
    const d = deps();
    await processMessageEvent(d, {
      eventId: "E_empty",
      message: { ...goodMessage, text: "   " },
    });
    expect((d.client as ReturnType<typeof fakeClient>).chat.postMessage).not.toHaveBeenCalled();
  });

  it("does NOT clear the dedup key when parseAndResolve fails (no re-parse spend)", async () => {
    const redis = memRedis();
    const badParse: OpenAILike = {
      chat: {
        completions: { parse: vi.fn(async () => { throw new Error("LLM down"); }) },
      },
    };
    const d = deps({
      redis,
      parseDeps: { client: badParse, model: "gpt-4o-mini", timezone: "America/Caracas" },
    });
    await expect(
      processMessageEvent(d, { eventId: "Eparse", message: goodMessage }),
    ).resolves.toBeUndefined();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("HARD-01: posts the Spanish parse-error notice in-thread when parseAndResolve fails", async () => {
    const client = fakeClient();
    const badParse: OpenAILike = {
      chat: {
        completions: { parse: vi.fn(async () => { throw new Error("LLM down"); }) },
      },
    };
    const d = deps({
      client,
      parseDeps: { client: badParse, model: "gpt-4o-mini", timezone: "America/Caracas" },
    });
    await expect(
      processMessageEvent(d, { eventId: "Eparsemsg", message: goodMessage }),
    ).resolves.toBeUndefined();

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    const arg = client.chat.postMessage.mock.calls[0]![0];
    expect(arg.channel).toBe(TASK_CHANNEL);
    expect(arg.thread_ts).toBe(goodMessage.ts);
    expect(arg.text).toBe(PARSE_ERROR_MESSAGE);
  });

  it("HARD-01: posts the generic Spanish notice when the side-effect tail fails", async () => {
    const client = fakeClient();
    // First postMessage (the preview) rejects → outer catch; the second
    // postMessage (the generic notice) succeeds.
    client.chat.postMessage.mockRejectedValueOnce(new Error("slack 500"));
    const d = deps({ client });

    await expect(
      processMessageEvent(d, { eventId: "Egeneric", message: goodMessage }),
    ).resolves.toBeUndefined();

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    const second = client.chat.postMessage.mock.calls[1]![0];
    expect(second.text).toBe(GENERIC_ERROR_MESSAGE);
    expect(second.channel).toBe(TASK_CHANNEL);
    expect(second.thread_ts).toBe(goodMessage.ts);
  });

  it("clears the dedup key on a transient postMessage failure so a redelivery re-posts", async () => {
    const redis = memRedis();
    const client = fakeClient();
    client.chat.postMessage.mockRejectedValueOnce(new Error("slack 429"));
    const d = deps({ redis, client });

    await processMessageEvent(d, { eventId: "Eretry", message: goodMessage });
    expect(redis.del).toHaveBeenCalledWith("evt:Eretry");

    await processMessageEvent(d, { eventId: "Eretry", message: goodMessage });
    // 1st invocation: preview post rejects (1) → HARD-01 generic notice posts (2).
    // 2nd invocation (redelivery, dedup key was cleared): preview re-posts (3).
    expect(client.chat.postMessage).toHaveBeenCalledTimes(3);
    const lastCall = client.chat.postMessage.mock.calls.at(-1)![0];
    expect(lastCall.text).toBe(RECEIPT_TEXT);
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
