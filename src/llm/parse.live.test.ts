import { describe, it, expect } from "vitest";
import { loadEnv } from "../config/env.js";
import { createOpenAIClient } from "./openai.js";
import { parseTask } from "./parse.js";
import { ParsedTaskSchema } from "./schema.js";

/**
 * Single OPTIONAL live smoke test. Entirely skipped when OPENAI_API_KEY is
 * absent, so offline CI stays green (there is no live key in this environment).
 * When a key IS present it confirms the real SDK structured-output round-trip
 * works — asserting ONLY structural shape, never specific extracted values
 * (live accuracy tuning is deferred — CONTEXT deferred ideas).
 */
describe.skipIf(!process.env.OPENAI_API_KEY)("parseTask live smoke", () => {
  it("returns a schema-valid ParsedTask from the real API", async () => {
    const env = loadEnv();
    const client = createOpenAIClient(env);
    const parsed = await parseTask(
      "Para FHCA: diseñar el banner de verano, asignar a Vero, para el viernes. https://loom.com/abc",
      { client, model: env.OPENAI_MODEL },
    );
    // Structural-only assertions.
    expect(() => ParsedTaskSchema.parse(parsed)).not.toThrow();
    expect(typeof parsed.title).toBe("string");
    expect(parsed.title.length).toBeGreaterThan(0);
  }, 30000);
});
