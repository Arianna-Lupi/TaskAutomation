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
  UPSTASH_REDIS_REST_URL: z.string().trim().url(),
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
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Validate and return a typed Env. Throws an Error naming every offending key
 * if validation fails. Empty-string required vars are treated as missing.
 *
 * @param source map of env values (defaults to process.env)
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = EnvSchema.safeParse(source);
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
