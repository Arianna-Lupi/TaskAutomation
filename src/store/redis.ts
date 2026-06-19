import { Redis } from "@upstash/redis";
import type { ResolvedTask } from "../resolve/types.js";

/**
 * Minimal structural type for the Redis operations our helpers need. Keeping
 * helpers dependency-injected (accepts a RedisLike) makes them unit-testable
 * without a live Upstash instance and reusable by the Slack ingress (plan 03).
 */
export type RedisLike = {
  // Return type is `unknown` to stay structurally compatible with the
  // @upstash/redis client; markEventOnce only distinguishes null vs non-null
  // (NX returns the stored marker / "OK" on a new key, null when it existed).
  // opts is relaxed to optional nx/ex so a plain SET ... EX (putPending) works.
  set(
    key: string,
    value: unknown,
    opts?: { nx?: true; ex?: number },
  ): Promise<unknown>;
  // GET a value (used by getPending/getThreadForTask). @upstash/redis
  // auto-deserializes JSON values, so this may return an already-parsed object.
  get(key: string): Promise<unknown>;
  // GETDEL — atomically read-and-delete, the idempotency primitive for
  // claimPending (a double-confirm yields the value once, then null).
  getdel(key: string): Promise<unknown>;
  // DEL the dedup/pending key so a downstream failure can be re-attempted on a
  // Slack redelivery (clearEvent/deletePending). Variadic in @upstash/redis.
  del(...keys: string[]): Promise<unknown>;
};

type RedisEnv = {
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
};

/**
 * Build an @upstash/redis REST client. Lazy by design — never constructed at
 * module load. Throws a clear error naming the missing key(s) if the URL or
 * token is absent/empty so a misconfigured deploy fails loudly.
 */
export function createRedis(
  env: RedisEnv = {
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL ?? "",
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN ?? "",
  },
): Redis {
  const missing: string[] = [];
  if (!env.UPSTASH_REDIS_REST_URL) missing.push("UPSTASH_REDIS_REST_URL");
  if (!env.UPSTASH_REDIS_REST_TOKEN) missing.push("UPSTASH_REDIS_REST_TOKEN");
  if (missing.length > 0) {
    throw new Error(`Cannot create Redis client — missing: ${missing.join(", ")}`);
  }
  return new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  });
}

/** Default dedup TTL: 10 minutes — covers Slack's retry window (Pitfall 1). */
export const DEFAULT_EVENT_TTL_SECONDS = 600;

/**
 * Idempotency guard keyed on Slack `event_id`. Uses SET ... NX EX so the value
 * persists in Redis across cold starts and is readable on the next invocation.
 *
 * @returns true the first time this eventId is seen (key set); false if the key
 *          already existed (a Slack retry / duplicate — drop it).
 */
export async function markEventOnce(
  redis: RedisLike,
  eventId: string,
  ttlSeconds: number = DEFAULT_EVENT_TTL_SECONDS,
): Promise<boolean> {
  const result = await redis.set(`evt:${eventId}`, 1, {
    nx: true,
    ex: ttlSeconds,
  });
  return result !== null;
}

/**
 * Default webhook-redelivery dedup TTL: 24h — covers ClickUp's redelivery window
 * for a failed (non-2xx) delivery (CONTEXT > Dedup; Pitfall 7).
 */
export const DEFAULT_WEBHOOK_TTL_SECONDS = 86400;

/**
 * Idempotency guard for inbound ClickUp webhook deliveries. Mirrors
 * markEventOnce's SET-NX-EX semantics but lives in a distinct "whk:" namespace
 * so a ClickUp delivery key can never collide with a Slack "evt:" event_id.
 *
 * @returns true the first time this delivery key is seen (key set); false on a
 *          redelivery (ClickUp retried — drop it so the thread is posted once).
 */
export async function markWebhookDeliveryOnce(
  redis: RedisLike,
  deliveryKey: string,
  ttlSeconds: number = DEFAULT_WEBHOOK_TTL_SECONDS,
): Promise<boolean> {
  const result = await redis.set(`whk:${deliveryKey}`, 1, {
    nx: true,
    ex: ttlSeconds,
  });
  return result !== null;
}

/**
 * Release the idempotency guard for an eventId (DEL evt:<id>). Called when a
 * downstream side-effect failed *after* markEventOnce claimed the event, so the
 * next Slack redelivery of the same event_id is allowed to re-attempt instead of
 * being silently suppressed (Pitfall 1 — drop-on-transient-failure).
 */
export async function clearEvent(
  redis: RedisLike,
  eventId: string,
): Promise<void> {
  await redis.del(`evt:${eventId}`);
}

// ── Phase 5: per-channel kill switch (HARD-03) ─────────────────────────────

/**
 * Kill-switch namespace, kept distinct from evt:/whk:/pending:/task2thread: so a
 * channel id can never collide with a dedup or pending key. `killswitch:all` is
 * the global override that disables every channel at once.
 */
const KILLSWITCH_PREFIX = "killswitch:";
export const KILLSWITCH_GLOBAL_KEY = `${KILLSWITCH_PREFIX}all`;

/**
 * Operational safety valve (HARD-03): is the bot disabled for this channel?
 *
 * Checks `killswitch:<channelId>` first, then the global `killswitch:all` — a
 * present (non-null) value on either means the capture path must no-op. The
 * absence of both keys is the default (enabled), so the bot ships ON.
 *
 * FAIL-OPEN by design (CONTEXT > HARD-03): the switch is a single cheap GET and
 * must never hard-block message processing. If Redis is unavailable the check
 * logs and returns `false` (treats the bot as enabled) — availability over a
 * fail-closed outage. The flip is set out-of-band by a trusted operator
 * (scripts/killswitch.mjs or the Upstash console), never from message flow.
 */
export async function isKillSwitchActive(
  redis: RedisLike,
  channelId: string,
): Promise<boolean> {
  try {
    const channelKey = `${KILLSWITCH_PREFIX}${channelId}`;
    if ((await redis.get(channelKey)) != null) return true;
    if ((await redis.get(KILLSWITCH_GLOBAL_KEY)) != null) return true;
    return false;
  } catch (err) {
    // Fail open: a Redis outage must not silence the whole bot — log and process.
    console.error(
      "[redis] isKillSwitchActive failed — failing open (bot stays enabled):",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * Flip the per-channel kill switch. `on` SETs `killswitch:<channelId>` to 1 with
 * NO NX and NO TTL so it persists until explicitly cleared; `off` DELetes it.
 * Used by scripts/killswitch.mjs and available for tests. Pass `"all"` as the
 * channelId to toggle the global override.
 */
export async function setKillSwitch(
  redis: RedisLike,
  channelId: string,
  on: boolean,
): Promise<void> {
  const key = `${KILLSWITCH_PREFIX}${channelId}`;
  if (on) {
    await redis.set(key, 1);
  } else {
    await redis.del(key);
  }
}

// ── Phase 3: pending-task store + task↔thread map ──────────────────────────

/** A captured-but-unconfirmed task awaiting the human's Confirmar/Editar/Cancelar. */
export type PendingTask = {
  resolved: ResolvedTask;
  channel: string;
  messageTs: string;
  threadTs: string;
  rawText: string;
};

/** Where a created task's confirmation lives, for Phase 4 reverse notifications. */
export type TaskThreadRef = {
  channel: string;
  thread_ts: string;
};

/** Pending previews self-expire after 1h so abandoned ones don't linger. */
export const DEFAULT_PENDING_TTL_SECONDS = 3600;
/** task↔thread map lives ~30 days (Phase 4 reverse-webhook window). */
export const TASK2THREAD_TTL_SECONDS = 2592000;

const PENDING_PREFIX = "pending:";
const TASK2THREAD_PREFIX = "task2thread:";

/**
 * @upstash/redis auto-deserializes JSON on get/getdel, but a raw string can also
 * come back (e.g. a value set elsewhere). Normalize either into the object shape,
 * returning null when absent or unparseable.
 */
function coerceJson<T>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  if (typeof value === "object") return value as T;
  return null;
}

/** Persist a pending task under pending:<id> with a TTL (default 1h). */
export async function putPending(
  redis: RedisLike,
  pendingId: string,
  pending: PendingTask,
  ttlSeconds: number = DEFAULT_PENDING_TTL_SECONDS,
): Promise<void> {
  await redis.set(`${PENDING_PREFIX}${pendingId}`, JSON.stringify(pending), {
    ex: ttlSeconds,
  });
}

/** Read a pending task without consuming it (used by the Edit modal open). */
export async function getPending(
  redis: RedisLike,
  pendingId: string,
): Promise<PendingTask | null> {
  return coerceJson<PendingTask>(await redis.get(`${PENDING_PREFIX}${pendingId}`));
}

/**
 * Atomically read-and-delete a pending task (GETDEL). The idempotency primitive
 * for Confirmar: the first claim returns the PendingTask AND removes the key, so
 * a double-click / Slack redelivery on the second claim gets null and is a no-op
 * — guaranteeing the ClickUp task is created exactly once.
 */
export async function claimPending(
  redis: RedisLike,
  pendingId: string,
): Promise<PendingTask | null> {
  return coerceJson<PendingTask>(await redis.getdel(`${PENDING_PREFIX}${pendingId}`));
}

/** Discard a pending task (used by Cancelar). */
export async function deletePending(
  redis: RedisLike,
  pendingId: string,
): Promise<void> {
  await redis.del(`${PENDING_PREFIX}${pendingId}`);
}

/** Record the created task → original thread mapping for Phase 4. */
export async function mapTaskToThread(
  redis: RedisLike,
  taskId: string,
  ref: TaskThreadRef,
  ttlSeconds: number = TASK2THREAD_TTL_SECONDS,
): Promise<void> {
  await redis.set(`${TASK2THREAD_PREFIX}${taskId}`, JSON.stringify(ref), {
    ex: ttlSeconds,
  });
}

/** Look up where a task's confirmation thread is (consumed by Phase 4). */
export async function getThreadForTask(
  redis: RedisLike,
  taskId: string,
): Promise<TaskThreadRef | null> {
  return coerceJson<TaskThreadRef>(
    await redis.get(`${TASK2THREAD_PREFIX}${taskId}`),
  );
}
