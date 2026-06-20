import { createHash } from "node:crypto";
import {
  getThreadForTask,
  markWebhookDeliveryOnce,
  type RedisLike,
} from "../store/redis.js";
import { MEMBERS } from "../config/members.js";
import { escapeSlackText } from "../util/slackMrkdwn.js";
import type {
  ClickUpHistoryItem,
  ClickUpWebhookPayload,
} from "./types.js";

// Re-exported for backward compatibility — escapeSlackText now lives in the
// shared util so the outbound preview (src/slack/blocks.ts) can use it too.
export { escapeSlackText } from "../util/slackMrkdwn.js";

/**
 * Flow B core (Phase 4, NOTIFY-02/03): parse a ClickUp reverse-webhook payload,
 * filter to meaningful status/assignee transitions, look up the originating
 * Slack thread via the Phase 3 `task2thread` map, build a compact Spanish
 * message, and post it — with redelivery dedup and a silent drop for tasks the
 * bot did not create. Fully dependency-injected so the whole behavior is proven
 * offline with a mocked Slack poster + an in-memory Redis and hand-built payloads.
 */

/** The two ClickUp events Flow B subscribes to. */
const HANDLED_EVENTS = new Set(["taskStatusUpdated", "taskAssigneeUpdated"]);

/** Minimal Slack poster shape (mirrors @slack/web-api WebClient.chat.postMessage). */
export type SlackPosterLike = {
  chat: {
    postMessage(args: {
      channel: string;
      thread_ts?: string;
      text: string;
    }): Promise<unknown>;
  };
  /**
   * Optional reactions surface (WebClient.reactions). When present, a status
   * change syncs an emoji reaction on the original message (progress/done).
   * Optional so existing tests/mocks without it keep compiling.
   */
  reactions?: {
    add(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
    remove(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
  };
};

/** Status-reaction emojis on the original message (no leading colons). */
const PROGRESS_EMOJI = "hourglass_flowing_sand";
const DONE_EMOJI = "white_check_mark";

/** Classify a ClickUp status name into the reaction it should drive, or null. */
function reactionForStatus(status: string): "progress" | "done" | null {
  const s = status
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  if (/(done|complet|closed|cerrad|finaliz|terminad|listo|resuelt)/.test(s)) return "done";
  if (/(progress|curso|proceso|haciend|doing|trabajand|desarroll)/.test(s)) return "progress";
  return null;
}

/**
 * Reflect the new status as an emoji reaction on the ORIGINAL message (the
 * thread root = ref.thread_ts): in-progress → progress emoji; done → remove the
 * progress emoji and add the done emoji. Best-effort: every call is wrapped so
 * already_reacted / no_reaction / missing-scope errors are swallowed (never
 * throws into the webhook path). No-op when the Slack client has no reactions
 * surface (keeps the existing notification working).
 */
async function syncStatusReaction(
  slack: SlackPosterLike,
  channel: string,
  timestamp: string,
  newStatus: string,
): Promise<void> {
  const reactions = slack.reactions;
  if (!reactions) return;
  const target = reactionForStatus(newStatus);
  if (target === null) return;

  const addEmoji = target === "done" ? DONE_EMOJI : PROGRESS_EMOJI;
  const removeEmoji = target === "done" ? PROGRESS_EMOJI : DONE_EMOJI;

  try {
    await reactions.remove({ channel, timestamp, name: removeEmoji });
  } catch {
    // no_reaction / not present → fine, nothing to remove.
  }
  try {
    await reactions.add({ channel, timestamp, name: addEmoji });
  } catch (err) {
    // already_reacted is fine; log anything else (e.g. missing reactions:write).
    const e = (err as { data?: { error?: string } })?.data?.error;
    if (e && e !== "already_reacted") {
      console.error("[clickup-webhook] reaction add failed:", e);
    }
  }
}

export type ClickUpWebhookDeps = {
  redis: RedisLike;
  slack: SlackPosterLike;
  /** Optional fallback to fetch a task's name when the payload lacks one. */
  getTaskName?: (taskId: string) => Promise<string | null>;
  /** Injectable clock (unused today; kept for parity with other deps). */
  now?: () => number;
};

/** Reverse member map: ClickUp numeric id → canonical name (built once). */
const ID_TO_MEMBER: Record<number, string> = Object.fromEntries(
  Object.entries(MEMBERS).map(([name, id]) => [id, name]),
);

/**
 * Parse a raw webhook body (string or already-parsed object) into a typed
 * payload. Defensive: returns null on bad JSON, a non-object, or a missing
 * `event`. Never throws.
 */
export function parseWebhookPayload(
  raw: string | unknown,
): ClickUpWebhookPayload | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (obj == null || typeof obj !== "object") return null;
  const candidate = obj as Record<string, unknown>;
  if (typeof candidate.event !== "string") return null;
  return candidate as ClickUpWebhookPayload;
}

/** PURE: the Spanish status-change message. */
export function buildStatusMessage(
  name: string,
  oldStatus: string,
  newStatus: string,
): string {
  return `🔄 *${escapeSlackText(name)}* cambió de estado: ${escapeSlackText(oldStatus)} → ${escapeSlackText(newStatus)}`;
}

/** PURE: the Spanish assignee-change message (+added / -removed). */
export function buildAssigneeMessage(
  name: string,
  addedNames: string[],
  removedNames: string[],
): string {
  const segs: string[] = [];
  if (addedNames.length > 0) {
    segs.push(`se añadió a ${addedNames.map((n) => escapeSlackText(n)).join(", ")}`);
  }
  if (removedNames.length > 0) {
    segs.push(`se quitó a ${removedNames.map((n) => escapeSlackText(n)).join(", ")}`);
  }
  return `👤 *${escapeSlackText(name)}*: ${segs.join("; ")}.`;
}

/**
 * Extract a human status label from a history-item before/after value, which
 * ClickUp may send as a bare string or as a `{ status: "label" }` object
 * (exact shape is a research gap — tolerate both). Returns null if unusable.
 */
function statusLabel(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value != null && typeof value === "object") {
    const s = (value as { status?: unknown }).status;
    if (typeof s === "string") return s;
  }
  return null;
}

/**
 * Extract a ClickUp member id from an assignee history-item value, which may be
 * a numeric id, a numeric string, or an `{ id }` object. Returns null if absent.
 */
function assigneeId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  if (value != null && typeof value === "object") {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "number" && Number.isFinite(id)) return id;
    if (typeof id === "string" && /^\d+$/.test(id)) return Number(id);
  }
  return null;
}

/** Resolve a member id → canonical name, falling back to the raw id string. */
function memberName(id: number): string {
  return ID_TO_MEMBER[id] ?? String(id);
}

type StatusTransition = { old: string; next: string } | null;
type AssigneeTransition = { added: number[]; removed: number[] } | null;

/** Find the meaningful status transition (old !== new), else null. */
function extractStatusTransition(items: ClickUpHistoryItem[]): StatusTransition {
  const item = items.find((it) => it.field === "status");
  if (!item) return null;
  const old = statusLabel(item.before);
  const next = statusLabel(item.after);
  if (old == null || next == null || old === next) return null;
  return { old, next };
}

/**
 * Collect added/removed assignee ids across history items, tolerating both the
 * `assignee_add`/`assignee_rem` field naming and a generic `assignee` field
 * with before/after set. Returns null when there is no real add or remove.
 */
function extractAssigneeTransition(
  items: ClickUpHistoryItem[],
): AssigneeTransition {
  const added: number[] = [];
  const removed: number[] = [];
  for (const it of items) {
    const field = it.field ?? "";
    if (field === "assignee_add") {
      const id = assigneeId(it.after) ?? assigneeId(it.before);
      if (id != null) added.push(id);
    } else if (field === "assignee_rem") {
      const id = assigneeId(it.before) ?? assigneeId(it.after);
      if (id != null) removed.push(id);
    } else if (field === "assignee" || field === "assignees") {
      const afterId = assigneeId(it.after);
      const beforeId = assigneeId(it.before);
      if (afterId != null && beforeId == null) added.push(afterId);
      else if (beforeId != null && afterId == null) removed.push(beforeId);
    }
  }
  if (added.length === 0 && removed.length === 0) return null;
  return { added, removed };
}

/**
 * Build the redelivery dedup key. The reliable path keys on the first
 * history-item id. When no id is present, ClickUp does not give us a stable
 * delivery identifier, so we hash the event content (event + task_id +
 * field/before/after of every item) — this keeps true redeliveries collapsed
 * while letting genuinely different events on the same task through. Otherwise
 * the old literal "noitem" fallback collapsed DISTINCT events to one key and
 * dropped them for the 24h TTL (WR-02).
 */
function buildDeliveryKey(
  event: string,
  taskId: string,
  items: ClickUpHistoryItem[],
): string {
  const firstId = items[0]?.id;
  if (typeof firstId === "string" && firstId.length > 0) {
    return `${event}:${taskId}:${firstId}`;
  }
  const content = JSON.stringify(
    items.map((it) => ({ field: it.field, before: it.before, after: it.after })),
  );
  const digest = createHash("sha256")
    .update(`${event} ${taskId} ${content}`)
    .digest("hex")
    .slice(0, 16);
  return `${event}:${taskId}:c:${digest}`;
}

/** Pull a task name straight off the payload when ClickUp includes one. */
function payloadTaskName(payload: ClickUpWebhookPayload): string | null {
  const p = payload as Record<string, unknown>;
  for (const key of ["task_name", "name"]) {
    const v = p[key];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

/**
 * Orchestrate a single webhook delivery (NOTIFY-03). Side-effecting body is
 * wrapped so a thrown error is logged, never propagated — the ingress runs this
 * inside `waitUntil` and must not reject after the 200 ACK.
 */
export async function processClickUpWebhook(
  deps: ClickUpWebhookDeps,
  payload: ClickUpWebhookPayload,
): Promise<void> {
  try {
    await runWebhook(deps, payload);
  } catch (err) {
    console.error(
      "[clickup-webhook] processing failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function runWebhook(
  deps: ClickUpWebhookDeps,
  payload: ClickUpWebhookPayload,
): Promise<void> {
  const { redis, slack } = deps;

  console.log("[clickup-webhook] received", {
    event: payload.event,
    task_id: payload.task_id,
    items: Array.isArray(payload.history_items) ? payload.history_items.length : 0,
  });

  // 1. Only the two subscribed events.
  if (!HANDLED_EVENTS.has(payload.event)) {
    console.log("[clickup-webhook] dropped: event not handled", { event: payload.event });
    return;
  }
  const taskId = payload.task_id;
  if (typeof taskId !== "string" || taskId.length === 0) return;

  // Defensive: a malformed (non-array) history_items must be a no-op, not a throw.
  const items = Array.isArray(payload.history_items) ? payload.history_items : [];

  // 2. Filter to a meaningful transition (noise dropped here).
  let kind: "status" | "assignee";
  let status: StatusTransition = null;
  let assignee: AssigneeTransition = null;
  if (payload.event === "taskStatusUpdated") {
    status = extractStatusTransition(items);
    if (!status) {
      console.log("[clickup-webhook] dropped: no meaningful status transition", { taskId });
      return;
    }
    kind = "status";
  } else {
    assignee = extractAssigneeTransition(items);
    if (!assignee) {
      console.log("[clickup-webhook] dropped: no assignee add/remove", { taskId });
      return;
    }
    kind = "assignee";
  }

  // 3. Scope to bot-created tasks only — unknown task_id is a silent drop.
  const ref = await getThreadForTask(redis, taskId);
  if (!ref) {
    console.log("[clickup-webhook] dropped: task not in task2thread map (not bot-created or map expired)", { taskId });
    return;
  }

  // 4. Redelivery dedup on (event + task_id + first history-item id), with a
  //    content-hash fallback when no item id is present (WR-02).
  //
  //    FIND-04 (replay residual, ACCEPTED): the ClickUp webhook payload carries
  //    no signed timestamp, so a timestamp-window rejection is impossible without
  //    inventing a field — which we deliberately do NOT do. The 24h `whk:` dedup
  //    TTL (markWebhookDeliveryOnce) is the accepted replay bound: a captured
  //    delivery replayed inside that window is collapsed to a no-op, and the
  //    X-Signature HMAC gate at ingress already rejects forged/tampered bodies.
  const deliveryKey = buildDeliveryKey(payload.event, taskId, items);
  const first = await markWebhookDeliveryOnce(redis, deliveryKey);
  if (!first) {
    console.log("[clickup-webhook] dropped: duplicate delivery", { taskId, deliveryKey });
    return;
  }
  console.log("[clickup-webhook] mapped + accepted, posting to thread", {
    taskId,
    kind,
    channel: ref.channel,
    thread_ts: ref.thread_ts,
  });

  // 5. Resolve the task name (payload first, then the injected fallback).
  let name = payloadTaskName(payload);
  if (name == null && deps.getTaskName) {
    try {
      name = await deps.getTaskName(taskId);
    } catch {
      name = null;
    }
  }
  if (name == null || name.length === 0) name = taskId;

  // 6. Build the Spanish message and post it to the mapped thread.
  let text: string;
  if (kind === "status" && status) {
    text = buildStatusMessage(name, status.old, status.next);
  } else if (assignee) {
    text = buildAssigneeMessage(
      name,
      assignee.added.map(memberName),
      assignee.removed.map(memberName),
    );
  } else {
    return;
  }

  await slack.chat.postMessage({
    channel: ref.channel,
    thread_ts: ref.thread_ts,
    text,
  });

  // Reflect the status on the original message as an emoji reaction (progress /
  // done). Best-effort, only for status changes. ref.thread_ts is the root
  // message ts (the human's original Slack message).
  if (kind === "status" && status) {
    await syncStatusReaction(slack, ref.channel, ref.thread_ts, status.next);
  }
}
