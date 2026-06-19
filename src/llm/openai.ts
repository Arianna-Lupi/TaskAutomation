import OpenAI from "openai";

/**
 * Minimal structural type capturing only the OpenAI method `parseTask` calls —
 * `chat.completions.parse` (the structured-outputs helper). Depending on this
 * narrow shape (rather than the full `OpenAI` client) lets tests inject a tiny
 * mock and run completely offline, mirroring the RedisLike/SlackClientLike DI
 * pattern from Phase 1.
 */
export type ParsedChoice = {
  message: {
    parsed: unknown | null;
    refusal?: string | null;
  };
};

/**
 * The structured-output request body parseTask builds. Kept as documentation of
 * the call shape; the `parse` method below accepts a looser param so the real
 * `OpenAI` client (whose `parse` is generic over the exact response_format) and
 * lightweight test mocks both satisfy `OpenAILike`. The concrete body is type-
 * checked where it is constructed in parse.ts.
 */
export type ParseRequestBody = {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  response_format: unknown;
};

export type OpenAILike = {
  chat: {
    completions: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parse(body: any): Promise<{ choices: ParsedChoice[] }>;
    };
  };
};

type OpenAIEnv = {
  OPENAI_API_KEY: string;
};

/**
 * Build a real OpenAI client. Lazy by design — never constructed at module load
 * (mirrors createRedis). The env is injected by the caller (which passes
 * loadEnv()), keeping secret handling pure and testable — no ambient reads.
 * Throws a
 * clear error naming OPENAI_API_KEY if it is absent/empty so a misconfigured
 * deploy fails loudly. The key is read only from the injected env, never logged.
 */
export function createOpenAIClient(env: OpenAIEnv): OpenAI {
  if (!env.OPENAI_API_KEY) {
    throw new Error("Cannot create OpenAI client — missing: OPENAI_API_KEY");
  }
  return new OpenAI({ apiKey: env.OPENAI_API_KEY });
}
