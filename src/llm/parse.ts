import { zodResponseFormat } from "openai/helpers/zod";
import { ParsedTaskSchema } from "./schema.js";
import type { OpenAILike, ParseRequestBody } from "./openai.js";
import type { ParsedTask } from "../resolve/types.js";

/** Thrown when the model output is missing, a refusal, or schema-invalid. */
export class ParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ParseError";
  }
}

/** Default system prompt: extract raw human strings only — never IDs or dates. */
export const DEFAULT_SYSTEM_PROMPT = [
  "Eres un extractor de tareas para un equipo de marketing que trabaja en español.",
  "Dado un mensaje libre de Slack, extrae los campos de una tarea.",
  "Reglas estrictas:",
  "- Devuelve SOLO cadenas humanas tal como aparecen (nombres, frases de fecha, enlaces).",
  "- NUNCA inventes ni traduzcas a IDs, UUIDs ni números de miembro.",
  "- NO calcules fechas: copia la frase relativa tal cual (p.ej. 'mañana', 'el viernes', '12/07').",
  "- 'clienteRaw' es el nombre del cliente mencionado, o null si no hay.",
  "- 'assigneesRaw' es la lista de personas asignadas mencionadas (vacía si ninguna).",
  "- 'links' son las URLs presentes en el mensaje (vacía si ninguna).",
  "- 'title' es un título corto y claro; 'description' detalle adicional o null.",
].join("\n");

export type ParseDeps = {
  client: OpenAILike;
  model: string;
  systemPrompt?: string;
};

/**
 * Extract a schema-shaped ParsedTask from a free-form message via OpenAI
 * structured outputs (zodResponseFormat strict json_schema for "parse_task").
 * The client + model are injected so every test runs offline against a mock.
 *
 * The model output is re-validated through ParsedTaskSchema; a refusal, an empty
 * payload, or any schema violation throws a typed ParseError rather than letting
 * an unvalidated object reach callers (Pitfall 4 — the structured-output shape
 * is guaranteed, validity is still gated here and in the resolver).
 */
export async function parseTask(
  text: string,
  deps: ParseDeps,
): Promise<ParsedTask> {
  const systemPrompt = deps.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  const body: ParseRequestBody = {
    model: deps.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ],
    response_format: zodResponseFormat(ParsedTaskSchema, "parse_task"),
  };

  let completion;
  try {
    completion = await deps.client.chat.completions.parse(body);
  } catch (cause) {
    throw new ParseError("OpenAI parse request failed", { cause });
  }

  const choice = completion.choices[0];
  if (!choice) {
    throw new ParseError("OpenAI returned no choices");
  }
  if (choice.message.refusal) {
    throw new ParseError(`OpenAI refused to parse: ${choice.message.refusal}`);
  }

  const result = ParsedTaskSchema.safeParse(choice.message.parsed);
  if (!result.success) {
    throw new ParseError(
      `Model output failed schema validation: ${result.error.message}`,
      { cause: result.error },
    );
  }

  return result.data;
}
