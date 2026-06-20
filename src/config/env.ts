import { z } from "zod";

/**
 * Fail-fast environment contract. Required vars must be non-empty strings;
 * TEAM_TIMEZONE is the only var with a default. process.env is NEVER read at
 * module load — `loadEnv` reads its (injectable) source so imports never crash
 * and tests can supply a fixture.
 */
const nonEmpty = z.string().trim().min(1);

const EnvSchema = z.object({
  SLACK_BOT_TOKEN: nonEmpty,
  SLACK_SIGNING_SECRET: nonEmpty,
  SLACK_TASK_CHANNEL_ID: nonEmpty,
  UPSTASH_REDIS_REST_URL: z
    .string()
    .trim()
    .url()
    .startsWith("https://", "must be the https REST URL (not a rediss:// connection string)"),
  UPSTASH_REDIS_REST_TOKEN: nonEmpty,
  TEAM_TIMEZONE: nonEmpty.default("America/Caracas"),
  // OpenAI structured-outputs parser (Phase 2). API key is required so a
  // misconfigured production deploy fails fast; the model has a sensible
  // default (gpt-4o-mini — cheap, good Spanish; gpt-4.1-mini is the fallback).
  OPENAI_API_KEY: nonEmpty,
  OPENAI_MODEL: nonEmpty.default("gpt-4o-mini"),
  // ClickUp REST v2 (Phase 3 Flow A — outbound task creation). The personal/OAuth
  // token is required so a misconfigured deploy fails fast; the destination list
  // defaults to the Task-Seo Team list (901327239630) but can be overridden.
  CLICKUP_API_TOKEN: nonEmpty,
  CLICKUP_LIST_ID: nonEmpty.default("901327239630"),
  // ClickUp reverse-webhook (Phase 4 Flow B — inbound notifications). The signing
  // secret is returned when the webhook is registered (POST /team/{id}/webhook)
  // and is required so a misconfigured deploy fails fast — the X-Signature gate
  // cannot be verified without it. CLICKUP_TEAM_ID is used by the one-time
  // registration helper and defaults to the Task-Seo workspace (90131720021).
  CLICKUP_WEBHOOK_SECRET: nonEmpty,
  CLICKUP_TEAM_ID: nonEmpty.default("90131720021"),
  // Ops-endpoint gate (Phase 8 SEC-04 / FIND-01). OPTIONAL with NO min-length so
  // a missing OR empty value never trips the fail-fast Zod validation: the gate
  // is fail-closed at the endpoint (404 when unset), not at boot. When set, the
  // ops endpoints (diag, refresh-config) require `Authorization: Bearer <token>`.
  OPS_API_TOKEN: z.string().trim().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

/** First value that is a non-empty https:// URL (skips rediss:// etc). */
function firstHttpsUrl(...vals: Array<string | undefined>): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && /^https:\/\//i.test(v.trim())) return v.trim();
  }
  return undefined;
}

/** First non-empty trimmed value. */
function firstNonEmpty(...vals: Array<string | undefined>): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Resolve the Upstash Redis REST URL/token from whichever env names exist.
 * Upstash's Vercel integration auto-injects `KV_REST_API_URL`/`KV_REST_API_TOKEN`;
 * we also accept the canonical `UPSTASH_REDIS_REST_*` names. The URL is chosen as
 * the first https:// value across both, so a stray `rediss://` (the connection
 * string, which the REST client cannot use → "fetch failed") is ignored.
 */
function normalizeRedis(
  source: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const url = firstHttpsUrl(source.UPSTASH_REDIS_REST_URL, source.KV_REST_API_URL);
  const token = firstNonEmpty(
    source.UPSTASH_REDIS_REST_TOKEN,
    source.KV_REST_API_TOKEN,
  );
  return {
    ...source,
    ...(url ? { UPSTASH_REDIS_REST_URL: url } : {}),
    ...(token ? { UPSTASH_REDIS_REST_TOKEN: token } : {}),
  };
}

/**
 * Validate and return a typed Env. Throws an Error naming every offending key
 * if validation fails. Empty-string required vars are treated as missing.
 *
 * @param source map of env values (defaults to process.env)
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = EnvSchema.safeParse(normalizeRedis(source));
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const key = issue.path.join(".") || "(root)";
        return `${key}: ${issue.message}`;
      })
      .join("; ");
    throw new Error(`Invalid environment configuration — ${issues}`);
  }
  return result.data;
}
