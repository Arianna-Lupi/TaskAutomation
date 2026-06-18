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
