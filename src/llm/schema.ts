import { z } from "zod";
import type { ParsedTask } from "../resolve/types.js";

/**
 * The single source of truth for the OpenAI structured-output shape. The LLM
 * emits only raw human strings (LOCKED CONTEXT) — no IDs, no date math. Every
 * field is required (OpenAI strict mode); optionals are `.nullable()` and the
 * two list fields are plain string arrays (the model always emits them, empty
 * when nothing applies). Validity/resolution is the resolver's job (plan 02).
 */
export const ParsedTaskSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  clienteRaw: z.string().nullable(),
  assigneesRaw: z.array(z.string()),
  startDatePhrase: z.string().nullable(),
  dueDatePhrase: z.string().nullable(),
  links: z.array(z.string()),
});

export type ParsedTaskFromSchema = z.infer<typeof ParsedTaskSchema>;

/**
 * Compile-time guarantee that the Zod schema's inferred type is structurally
 * identical to the shared ParsedTask contract (src/resolve/types.ts). If either
 * shape drifts, this assignment stops compiling — a build-time canary so the
 * parser and resolver can never silently disagree on the contract.
 */
type Equals<A, B> = A extends B ? (B extends A ? true : never) : never;
const _schemaMatchesContract: Equals<ParsedTaskFromSchema, ParsedTask> = true;
void _schemaMatchesContract;
