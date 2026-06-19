import { describe, it, expect, vi } from "vitest";
import { handleConfirm, handleCancel, type InteractionDeps } from "./interactions.js";
import { putPending, getPending, type RedisLike, type PendingTask } from "../store/redis.js";
import type { ClickUpClient } from "../clickup/client.js";
import type { ResolvedTask } from "../resolve/types.js";

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
      let n = 0;
      for (const k of keys) if (store.delete(k)) n += 1;
      return n;
    },
  };
}

function fakeClickup(
  result = { id: "task1", url: "https://app.clickup.com/t/task1" },
): ClickUpClient & { createTask: ReturnType<typeof vi.fn> } {
  return { createTask: vi.fn(async () => result) };
}

type UpdateArgs = { channel: string; ts: string; text: string; blocks?: unknown };
type PostArgs = { channel: string; thread_ts?: string; text: string; blocks?: unknown };

function fakeSlack() {
  return {
    chat: {
      update: vi.fn(async (_a: UpdateArgs) => ({ ok: true })),
      postMessage: vi.fn(async (_a: PostArgs) => ({ ok: true })),
    },
  };
}

const resolved: ResolvedTask = {
  title: "Diseñar landing",
  description: "landing de campaña",
  clienteOptionId: "63d9626f-9b80-4a19-8638-93b8042d2e9c",
  assigneeIds: [216158839, 118065209],
  unresolvedAssignees: [],
  startDateMs: 1718000000000,
  dueDateMs: 1718600000000,
  links: ["https://loom.com/x", "https://second.example"],
};

const pending: PendingTask = {
  resolved,
  channel: "C_TASK",
  messageTs: "1700000000.000100",
  threadTs: "1700000000.000100",
  rawText: "diseñar landing",
};

async function seeded() {
  const redis = memRedis();
  await putPending(redis, "PID", pending);
  const clickup = fakeClickup();
  const slack = fakeSlack();
  const deps: InteractionDeps = { redis, clickup, slack, timezone: "America/Caracas" };
  return { redis, clickup, slack, deps };
}

const ref = { pendingId: "PID", channel: "C_TASK", messageTs: "1700000000.000100" };

describe("handleConfirm", () => {
  it("creates exactly one task with epoch-ms dates, assignee ids, cliente UUID and link", async () => {
    const s = await seeded();
    await handleConfirm(s.deps, ref);

    expect(s.clickup.createTask).toHaveBeenCalledTimes(1);
    expect(s.clickup.createTask).toHaveBeenCalledWith({
      name: "Diseñar landing",
      description: "landing de campaña",
      assigneeIds: [216158839, 118065209],
      startDateMs: 1718000000000,
      dueDateMs: 1718600000000,
      clienteOptionId: "63d9626f-9b80-4a19-8638-93b8042d2e9c",
      link: "https://loom.com/x", // first link
    });
  });

  it("writes the task↔thread map, updates to confirmed blocks, and posts the link in-thread", async () => {
    const s = await seeded();
    await handleConfirm(s.deps, ref);

    // task2thread map written for the created task id.
    expect(await getThread(s.redis, "task1")).toEqual({
      channel: "C_TASK",
      thread_ts: "1700000000.000100",
    });

    expect(s.slack.chat.update).toHaveBeenCalledTimes(1);
    const upd = s.slack.chat.update.mock.calls[0]![0];
    expect(upd.channel).toBe("C_TASK");
    expect(upd.ts).toBe("1700000000.000100");
    expect(JSON.stringify(upd.blocks)).toContain("https://app.clickup.com/t/task1");

    expect(s.slack.chat.postMessage).toHaveBeenCalledTimes(1);
    const post = s.slack.chat.postMessage.mock.calls[0]![0];
    expect(post.thread_ts).toBe("1700000000.000100");
    expect(post.text).toContain("https://app.clickup.com/t/task1");
  });

  it("is exactly-once: a second confirm with the same pendingId does not create again", async () => {
    const s = await seeded();
    await handleConfirm(s.deps, ref);
    await handleConfirm(s.deps, ref);
    expect(s.clickup.createTask).toHaveBeenCalledTimes(1);
  });

  it("restores the pending if createTask throws after the claim", async () => {
    const redis = memRedis();
    await putPending(redis, "PID", pending);
    const clickup = { createTask: vi.fn(async () => { throw new Error("ClickUp 500"); }) };
    const slack = fakeSlack();
    const deps: InteractionDeps = { redis, clickup, slack, timezone: "America/Caracas" };

    await handleConfirm(deps, ref);
    // Pending is back so the human can retry.
    expect(await getPending(redis, "PID")).toEqual(pending);
    expect(slack.chat.update).not.toHaveBeenCalled();
  });
});

describe("handleCancel", () => {
  it("deletes the pending and updates the message to canceled blocks", async () => {
    const s = await seeded();
    await handleCancel(s.deps, ref);
    expect(await getPending(s.redis, "PID")).toBeNull();
    expect(s.slack.chat.update).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(s.slack.chat.update.mock.calls[0]![0].blocks)).toContain("Cancelado");
  });
});

// Local helper to read the task2thread map without importing the prefix.
async function getThread(redis: RedisLike, taskId: string) {
  const v = await redis.get(`task2thread:${taskId}`);
  if (typeof v === "string") return JSON.parse(v);
  return v;
}
