import crypto from "node:crypto";

/**
 * Pure, testable gate for the internal ops endpoints (diag, refresh-config).
 *
 * The gate is FAIL-CLOSED: when no `OPS_API_TOKEN` is configured the endpoints
 * have no ops surface at all (callers should return 404 on "disabled"). When a
 * token IS configured, a request must carry `Authorization: Bearer <token>`
 * matching it via a timing-safe compare. This replaces the old "Slack signing
 * secret in the URL query" gate (FIND-01) and lives here so the endpoints stay
 * thin and the logic is unit-tested without booting the full env (SEC-04).
 */

/** Timing-safe string compare with a length guard (never throws). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Pull the token out of an `Authorization: Bearer <token>` header. */
function parseBearer(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(authHeader.trim());
  const token = match?.[1];
  return token != null ? token.trim() : null;
}

/**
 * Evaluate an ops request against the configured token.
 *
 * @param opsToken   the configured OPS_API_TOKEN (may be undefined/empty)
 * @param authHeader the incoming Authorization header value (may be null)
 * @returns "disabled" when no token is configured (→ 404),
 *          "unauthorized" when the Bearer token is missing/wrong (→ 401),
 *          "ok" only on an exact, timing-safe match.
 */
export function evaluateOpsAuth(
  opsToken: string | undefined,
  authHeader: string | null,
): "disabled" | "unauthorized" | "ok" {
  const token = (opsToken ?? "").trim();
  if (token.length === 0) return "disabled";

  const presented = parseBearer(authHeader);
  if (presented == null) return "unauthorized";

  return safeEqual(presented, token) ? "ok" : "unauthorized";
}
