import { Redis } from "@upstash/redis";

/**
 * Minimal structural type for the Redis SET operation `markEventOnce` needs.
 * Keeping the helper dependency-injected (accepts a RedisLike) makes it
 * unit-testable without a live Upstash instance and reusable by the Slack
 * ingress (plan 03).
 */
export type RedisLike = {
  // Return type is `unknown` to stay structurally compatible with the
  // @upstash/redis client; markEventOnce only distinguishes null vs non-null
  // (NX returns the stored marker / "OK" on a new key, null when it existed).
  set(
    key: string,
    value: unknown,
    opts: { nx: true; ex: number },
  ): Promise<unknown>;
  // DEL the dedup key so a downstream failure can be re-attempted on a Slack
  // redelivery (clearEvent). Variadic in @upstash/redis; we only ever pass one.
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
