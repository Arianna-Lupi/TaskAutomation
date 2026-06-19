import type { FetchLike } from "./types.js";

/**
 * Typed exhaustion error thrown when a retryable ClickUp response (429 / 5xx)
 * persists past `maxAttempts`. Carries the final HTTP `status` so the caller
 * (HARD-01) can render it in the user-facing Spanish message — e.g.
 * `No pude crear la tarea en ClickUp (429)`. It is a real `Error` subclass so
 * `instanceof Error` and `instanceof ClickUpRetryError` both hold.
 */
export class ClickUpRetryError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`ClickUp request failed after retries — status ${status}`);
    this.name = "ClickUpRetryError";
    this.status = status;
  }
}

export type RetryingFetchOpts = {
  /** Injected delay (real `setTimeout` in prod, a recorder in tests). */
  sleep: (ms: number) => Promise<void>;
  /** Total attempts including the first (default 3). */
  maxAttempts?: number;
  /** Base for exponential backoff `base * 2^n` and the jitter span (default 1000ms). */
  baseDelayMs?: number;
  /** Injected RNG for jitter (default Math.random) — fixed in tests for exactness. */
  random?: () => number;
};

/**
 * Upper bound on any honored `Retry-After` delay (WR-02). ClickUp rate-limit
 * windows are seconds-scale; a large or garbage header value must never be able
 * to park the worker for minutes until the platform reaps it. Anything beyond
 * this clamps down to it.
 */
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Read a `Retry-After` header (seconds) defensively. `headers` is now declared
 * (optionally) on the FetchLike response (IN-03), so the access is compile-time
 * safe — no unchecked cast. The parsed delay is clamped to `MAX_RETRY_AFTER_MS`
 * (WR-02) so an absurd header can't hang the worker.
 */
function retryAfterMs(res: Awaited<ReturnType<FetchLike>>): number | null {
  const raw = res.headers?.get("Retry-After");
  if (raw == null) return null;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isNaN(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/**
 * HTTP methods whose retry is safe to perform on transient 5xx / network
 * failures: they are idempotent, so a replay can't create a duplicate resource.
 * Anything else (notably POST createTask) must NOT be replayed on a 5xx/network
 * error, because the server may have already applied the write before the
 * failure surfaced (WR-01).
 */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isIdempotent(init?: Parameters<FetchLike>[1]): boolean {
  // Default method for fetch is GET, which is idempotent.
  const method = (init?.method ?? "GET").toUpperCase();
  return IDEMPOTENT_METHODS.has(method);
}

/** Exponential backoff `base * 2^attempt` plus `random() * base` jitter. */
function backoffMs(attempt: number, base: number, random: () => number): number {
  return base * 2 ** attempt + random() * base;
}

/**
 * Wrap an injected `FetchLike` with bounded retry for ClickUp rate limits and
 * transient server errors (HARD-02). A 429 (rate limit) is retryable for ALL
 * methods — ClickUp rejected the request before processing it, so no write
 * happened and a replay is safe. A 5xx or a network rejection is retried ONLY
 * for idempotent methods (GET/HEAD/OPTIONS): for a non-idempotent request such
 * as the `createTask` POST the write may already have landed before the failure
 * surfaced, so replaying it could create a DUPLICATE task — those pass the 5xx
 * straight through (the client turns it into an error) and rethrow network
 * errors immediately (WR-01). On a retry the wrapper waits — honoring
 * `Retry-After` (seconds, clamped to 30s per WR-02) when present, else
 * exponential backoff + jitter. On the final attempt with a still-retryable
 * status it throws `ClickUpRetryError` carrying that status. All other
 * responses (2xx, non-429 4xx, and non-idempotent 5xx) are returned unchanged.
 * The `sleep`/`random` are injected so backoff is fully deterministic and
 * instant under test — no new dependencies, just the already-injected fetch.
 */
export function createRetryingFetch(
  fetch: FetchLike,
  opts: RetryingFetchOpts,
): FetchLike {
  const {
    sleep,
    maxAttempts = 3,
    baseDelayMs = 1000,
    random = Math.random,
  } = opts;

  return async (input, init) => {
    let lastError: unknown;
    const idempotent = isIdempotent(init);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const isFinal = attempt === maxAttempts - 1;

      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await fetch(input, init);
      } catch (err) {
        // Network-level rejection. For a non-idempotent request (e.g. POST
        // createTask) the write may already have landed before the socket
        // broke — replaying it could create a DUPLICATE task (WR-01). So only
        // idempotent methods (GET) retry network errors; others rethrow now.
        lastError = err;
        if (isFinal || !idempotent) throw err;
        await sleep(backoffMs(attempt, baseDelayMs, random));
        continue;
      }

      // 429 means ClickUp REJECTED the request before processing it, so a
      // retry is safe for ALL methods (no write happened). A 5xx, however,
      // may have been raised AFTER the write was applied — retrying a
      // non-idempotent 5xx risks a duplicate, so only idempotent methods
      // retry on 5xx (WR-01).
      const isRateLimit = res.status === 429;
      const isServerError = res.status >= 500;
      const retryable = isRateLimit || (isServerError && idempotent);
      if (!retryable) return res; // pass through: 2xx, non-429 4xx, POST-5xx.

      if (isFinal) throw new ClickUpRetryError(res.status);

      const delay = retryAfterMs(res) ?? backoffMs(attempt, baseDelayMs, random);
      await sleep(delay);
    }

    // Unreachable: the loop either returns, sleeps+continues, or throws above.
    throw lastError ?? new ClickUpRetryError(0);
  };
}
