import { describe, it, expect, vi } from "vitest";
import {
  processClickUpWebhook,
  parseWebhookPayload,
  buildStatusMessage,
  buildAssigneeMessage,
  type ClickUpWebhookDeps,
  type SlackPosterLike,
} from "./webhook.js";
import { mapTaskToThread, type RedisLike } from "../store/redis.js";
import { MEMBERS } from "../config/members.js";

/** In-memory RedisLike honoring nx-on-set + GETDEL (mirrors redis.test.ts). */
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

function spyPoster(): { slack: SlackPosterLike; post: ReturnType<typeof vi.fn> } {
  const post = vi.fn().mockResolvedValue({ ok: true });
  return { slack: { chat: { postMessage: post } }, post };
}

const CHANNEL = "C_TASK";
const THREAD = "1700000000.000100";
const TASK = "task123";

async function seedThread(redis: RedisLike, taskId = TASK): Promise<void> {
  await mapTaskToThread(redis, taskId, { channel: CHANNEL, thread_ts: THREAD });
}

const MIGUEL = MEMBERS["Miguel Pacheco"]; // 216158839
const VERO = MEMBERS["Veronica Romero"]; // 118065209

describe("parseWebhookPayload", () => {
  it("parses a JSON string into { event, task_id, history_items }", () => {
    const raw = JSON.stringify({
      event: "taskStatusUpdated",
      task_id: TASK,
      history_items: [{ id: "h1", field: "status" }],
    });
    const parsed = parseWebhookPayload(raw);
    expect(parsed?.event).toBe("taskStatusUpdated");
    expect(parsed?.task_id).toBe(TASK);
    expect(parsed?.history_items?.[0]?.id).toBe("h1");
  });

  it("accepts an already-parsed object", () => {
    expect(parseWebhookPayload({ event: "x", task_id: "t" })?.event).toBe("x");
  });

  it("returns null for invalid JSON, missing event, or non-object", () => {
    expect(parseWebhookPayload("{not json")).toBeNull();
    expect(parseWebhookPayload(JSON.stringify({ task_id: "t" }))).toBeNull();
    expect(parseWebhookPayload(42)).toBeNull();
    expect(parseWebhookPayload(null)).toBeNull();
  });

  it("never throws", () => {
    expect(() => parseWebhookPayload(undefined as unknown as string)).not.toThrow();
  });
});

describe("buildStatusMessage / buildAssigneeMessage (pure)", () => {
  it("status message has the 🔄 prefix and old → new", () => {
    expect(buildStatusMessage("Mi tarea", "abierto", "en progreso")).toBe(
      "🔄 *Mi tarea* cambió de estado: abierto → en progreso",
    );
  });

  it("assignee message has the 👤 prefix and added/removed names in plain Spanish", () => {
    expect(buildAssigneeMessage("Mi tarea", ["Miguel Pacheco"], ["Veronica Romero"])).toBe(
      "👤 *Mi tarea*: se añadió a Miguel Pacheco; se quitó a Veronica Romero.",
    );
  });

  it("assignee message tolerates empty add or remove lists", () => {
    expect(buildAssigneeMessage("T", ["Miguel Pacheco"], [])).toContain(
      "se añadió a Miguel Pacheco",
    );
    expect(buildAssigneeMessage("T", [], ["Veronica Romero"])).toContain(
      "se quitó a Veronica Romero",
    );
  });
});

describe("processClickUpWebhook — status changes", () => {
  it("posts '🔄 ... cambió de estado: old → new' to the mapped thread", async () => {
    const redis = memRedis();
    await seedThread(redis);
    const { slack, post } = spyPoster();
    const deps: ClickUpWebhookDeps = { redis, slack, getTaskName: async () => "Diseñar landing" };

    await processClickUpWebhook(deps, {
      event: "taskStatusUpdated",
      task_id: TASK,
      history_items: [
        { id: "h1", field: "status", before: { status: "abierto" }, after: { status: "en progreso" } },
      ],
    });

    expect(post).toHaveBeenCalledTimes(1);
    const arg = post.mock.calls[0]?.[0] as { channel: string; thread_ts: string; text: string };
    expect(arg.channel).toBe(CHANNEL);
    expect(arg.thread_ts).toBe(THREAD);
    expect(arg.text).toBe("🔄 *Diseñar landing* cambió de estado: abierto → en progreso");
  });

  it("tolerates plain-string before/after status labels", async () => {
    const redis = memRedis();
    await seedThread(redis);
    const { slack, post } = spyPoster();
    await processClickUpWebhook(
      { redis, slack, getTaskName: async () => "T" },
      {
        event: "taskStatusUpdated",
        task_id: TASK,
        history_items: [{ id: "h1", field: "status", before: "open", after: "done" }],
      },
    );
    expect((post.mock.calls[0]?.[0] as { text: string }).text).toBe(
      "🔄 *T* cambió de estado: open → done",
    );
  });

  it("does NOT post when old === new (no real transition)", async () => {
    const redis = memRedis();
    await seedThread(redis);
    const { slack, post } = spyPoster();
    await processClickUpWebhook(
      { redis, slack },
      {
        event: "taskStatusUpdated",
        task_id: TASK,
        history_items: [{ id: "h1", field: "status", before: "open", after: "open" }],
      },
    );
    expect(post).not.toHaveBeenCalled();
  });
});

describe("processClickUpWebhook — assignee changes", () => {
  it("posts +added / -removed with member ids resolved to names", async () => {
    const redis = memRedis();
    await seedThread(redis);
    const { slack, post } = spyPoster();
    await processClickUpWebhook(
      { redis, slack, getTaskName: async () => "Revisar copy" },
      {
        event: "taskAssigneeUpdated",
        task_id: TASK,
        history_items: [
          { id: "a1", field: "assignee_add", after: { id: MIGUEL, username: "Miguel" } },
          { id: "a2", field: "assignee_rem", before: { id: VERO, username: "Vero" } },
        ],
      },
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect((post.mock.calls[0]?.[0] as { text: string }).text).toBe(
      "👤 *Revisar copy*: se añadió a Miguel Pacheco; se quitó a Veronica Romero.",
    );
  });

  it("falls back to the raw id when the member is unknown", async () => {
    const redis = memRedis();
    await seedThread(redis);
    const { slack, post } = spyPoster();
    await processClickUpWebhook(
      { redis, slack, getTaskName: async () => "T" },
      {
        event: "taskAssigneeUpdated",
        task_id: TASK,
        history_items: [{ id: "a1", field: "assignee_add", after: { id: 999999 } }],
      },
    );
    expect((post.mock.calls[0]?.[0] as { text: string }).text).toContain("se añadió a 999999");
  });

  it("does NOT post when there is neither an add nor a remove", async () => {
    const redis = memRedis();
    await seedThread(redis);
    const { slack, post } = spyPoster();
    await processClickUpWebhook(
      { redis, slack },
      { event: "taskAssigneeUpdated", task_id: TASK, history_items: [{ id: "a1", field: "status" }] },
    );
    expect(post).not.toHaveBeenCalled();
  });
});

describe("processClickUpWebhook — scoping, dedup, fallbacks", () => {
  it("silently drops a task_id NOT in task2thread (no post)", async () => {
    const redis = memRedis();
    // note: no seedThread
    const { slack, post } = spyPoster();
    await processClickUpWebhook(
      { redis, slack, getTaskName: async () => "T" },
      {
        event: "taskStatusUpdated",
        task_id: "unmapped",
        history_items: [{ id: "h1", field: "status", before: "a", after: "b" }],
      },
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("posts exactly once across a redelivery (same delivery key)", async () => {
    const redis = memRedis();
    await seedThread(redis);
    const { slack, post } = spyPoster();
    const payload = {
      event: "taskStatusUpdated",
      task_id: TASK,
      history_items: [{ id: "h1", field: "status", before: "a", after: "b" }],
    };
    const deps: ClickUpWebhookDeps = { redis, slack, getTaskName: async () => "T" };
    await processClickUpWebhook(deps, payload);
    await processClickUpWebhook(deps, payload);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("ignores unknown event types", async () => {
    const redis = memRedis();
    await seedThread(redis);
    const { slack, post } = spyPoster();
    await processClickUpWebhook(
      { redis, slack },
      { event: "taskCommentPosted", task_id: TASK, history_items: [] },
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("degrades to the task_id when getTaskName fails (never throws)", async () => {
    const redis = memRedis();
    await seedThread(redis);
    const { slack, post } = spyPoster();
    await expect(
      processClickUpWebhook(
        { redis, slack, getTaskName: async () => { throw new Error("boom"); } },
        {
          event: "taskStatusUpdated",
          task_id: TASK,
          history_items: [{ id: "h1", field: "status", before: "a", after: "b" }],
        },
      ),
    ).resolves.toBeUndefined();
    expect((post.mock.calls[0]?.[0] as { text: string }).text).toContain(`*${TASK}*`);
  });

  it("does not call getTaskName when a name is present on the payload", async () => {
    const redis = memRedis();
    await seedThread(redis);
    const { slack, post } = spyPoster();
    const getTaskName = vi.fn();
    await processClickUpWebhook(
      { redis, slack, getTaskName },
      {
        event: "taskStatusUpdated",
        task_id: TASK,
        task_name: "Desde payload",
        history_items: [{ id: "h1", field: "status", before: "a", after: "b" }],
      } as never,
    );
    expect(getTaskName).not.toHaveBeenCalled();
    expect((post.mock.calls[0]?.[0] as { text: string }).text).toContain("*Desde payload*");
  });

  it("escapes Slack-special chars in an untrusted task name (WR-01)", async () => {
    const redis = memRedis();
    await seedThread(redis);
    const { slack, post } = spyPoster();
    await processClickUpWebhook(
      { redis, slack, getTaskName: async () => "<!channel>" },
      {
        event: "taskStatusUpdated",
        task_id: TASK,
        history_items: [{ id: "h1", field: "status", before: "a", after: "b" }],
      },
    );
    const text = (post.mock.calls[0]?.[0] as { text: string }).text;
    expect(text).toContain("&lt;!channel&gt;");
    expect(text).not.toContain("<!channel>");
  });

  it("treats a malformed (non-array) history_items as a no-op (IN-02)", async () => {
    const redis = memRedis();
    await seedThread(redis);
    const { slack, post } = spyPoster();
    await expect(
      processClickUpWebhook(
        { redis, slack, getTaskName: async () => "T" },
        {
          event: "taskStatusUpdated",
          task_id: TASK,
          history_items: "not-an-array",
        } as never,
      ),
    ).resolves.toBeUndefined();
    expect(post).not.toHaveBeenCalled();
  });

  it("posts BOTH distinct status changes on the same task without item ids (WR-02)", async () => {
    const redis = memRedis();
    await seedThread(redis);
    const { slack, post } = spyPoster();
    const deps: ClickUpWebhookDeps = { redis, slack, getTaskName: async () => "T" };
    // Two genuinely different transitions, neither carrying a history-item id.
    await processClickUpWebhook(deps, {
      event: "taskStatusUpdated",
      task_id: TASK,
      history_items: [{ field: "status", before: "abierto", after: "en progreso" }],
    });
    await processClickUpWebhook(deps, {
      event: "taskStatusUpdated",
      task_id: TASK,
      history_items: [{ field: "status", before: "en progreso", after: "hecho" }],
    });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("still collapses a true redelivery without item ids (WR-02)", async () => {
    const redis = memRedis();
    await seedThread(redis);
    const { slack, post } = spyPoster();
    const deps: ClickUpWebhookDeps = { redis, slack, getTaskName: async () => "T" };
    const payload = {
      event: "taskStatusUpdated",
      task_id: TASK,
      history_items: [{ field: "status", before: "abierto", after: "hecho" }],
    };
    await processClickUpWebhook(deps, payload);
    await processClickUpWebhook(deps, payload);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does not throw when the Slack post itself fails", async () => {
    const redis = memRedis();
    await seedThread(redis);
    const post = vi.fn().mockRejectedValue(new Error("slack down"));
    const slack: SlackPosterLike = { chat: { postMessage: post } };
    await expect(
      processClickUpWebhook(
        { redis, slack, getTaskName: async () => "T" },
        {
          event: "taskStatusUpdated",
          task_id: TASK,
          history_items: [{ id: "h1", field: "status", before: "a", after: "b" }],
        },
      ),
    ).resolves.toBeUndefined();
  });
});
