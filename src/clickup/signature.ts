import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * ClickUp reverse-webhook authenticity (Phase 4, NOTIFY-01).
 *
 * ClickUp signs each webhook delivery with `X-Signature` = HMAC-SHA256 of the
 * RAW request body using the secret returned when the webhook was registered.
 * The exact wire format is a flagged research gap (04-CONTEXT > Claude's
 * Discretion), so this verifier is deliberately defensive:
 *   - it computes the HMAC over the exact bytes it is given (the ingress MUST
 *     pass the raw body, never a re-serialized JSON string — Pitfall 2/7);
 *   - it tolerates an optional leading "sha256=" prefix on the incoming value;
 *   - it compares case-insensitively (hex) and timing-safely;
 *   - it NEVER throws — any malformed input simply returns false.
 *
 * The companion test computes the expected HMAC itself, proving the logic is
 * correct offline before the live ClickUp secret is ever known.
 */
export function verifyClickUpSignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  if (typeof signature !== "string" || signature.length === 0) return false;
  if (typeof secret !== "string" || secret.length === 0) return false;

  // Strip an optional "sha256=" prefix, normalize to lowercase hex.
  const incoming = signature.replace(/^sha256=/i, "").trim().toLowerCase();
  // Hex of an SHA-256 digest is always 64 lowercase chars; reject anything else
  // before allocating buffers (this also guards timingSafeEqual's equal-length
  // requirement).
  if (!/^[0-9a-f]{64}$/.test(incoming)) return false;

  let expected: string;
  try {
    expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  } catch {
    return false;
  }

  const a = Buffer.from(incoming, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Case-insensitively look up the `X-Signature` header from either a `Headers`
 * object or a plain record. ClickUp's header casing is not contractually fixed
 * (04-CONTEXT > Endpoint), so the lookup must not depend on a specific casing.
 * Returns the trimmed value, or null when absent/empty.
 */
export function getClickUpSignatureHeader(
  headers: Headers | Record<string, string | undefined>,
): string | null {
  const TARGET = "x-signature";

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const value = headers.get("x-signature");
    return value && value.length > 0 ? value : null;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === TARGET) {
      return typeof value === "string" && value.length > 0 ? value : null;
    }
  }
  return null;
}
