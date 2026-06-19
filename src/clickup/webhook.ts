import {
  getThreadForTask,
  markWebhookDeliveryOnce,
  type RedisLike,
} from "../store/redis.js";
import { MEMBERS } from "../config/members.js";
import type {
  ClickUpHistoryItem,
  ClickUpWebhookPayload,
} from "./types.js";

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
};

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

/**
 * Escape Slack mrkdwn control characters in UNTRUSTED text (ClickUp task names,
 * status labels, resolved/unresolved assignee text). Without this, a task named
 * `<!channel>`, `<@U123>`, or `<url|text>` would trigger pings or spoofed links
 * when posted. Order matters: `&` must be escaped first. Per Slack guidance only
 * `&`, `<`, `>` are special in message text.
 */
export function escapeSlackText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
  const added = addedNames.map((n) => `+${escapeSlackText(n)}`).join(" ");
  const removed = removedNames.map((n) => `-${escapeSlackText(n)}`).join(" ");
  const parts = [added, removed].filter((p) => p.length > 0).join(" / ");
  return `👤 *${escapeSlackText(name)}* asignados actualizados: ${parts}`;
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

  // 1. Only the two subscribed events.
  if (!HANDLED_EVENTS.has(payload.event)) return;
  const taskId = payload.task_id;
  if (typeof taskId !== "string" || taskId.length === 0) return;

  const items = payload.history_items ?? [];

  // 2. Filter to a meaningful transition (noise dropped here).
  let kind: "status" | "assignee";
  let status: StatusTransition = null;
  let assignee: AssigneeTransition = null;
  if (payload.event === "taskStatusUpdated") {
    status = extractStatusTransition(items);
    if (!status) return;
    kind = "status";
  } else {
    assignee = extractAssigneeTransition(items);
    if (!assignee) return;
    kind = "assignee";
  }

  // 3. Scope to bot-created tasks only — unknown task_id is a silent drop.
  const ref = await getThreadForTask(redis, taskId);
  if (!ref) return;

  // 4. Redelivery dedup on (event + task_id + first history-item id).
  const deliveryKey = `${payload.event}:${taskId}:${items[0]?.id ?? "noitem"}`;
  const first = await markWebhookDeliveryOnce(redis, deliveryKey);
  if (!first) return;

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
}
