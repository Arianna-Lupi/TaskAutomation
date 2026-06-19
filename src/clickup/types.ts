/**
 * Types and field-id constants for the ClickUp REST v2 client (Phase 3 Flow A).
 * Pure declarations — no I/O, no process.env. The Cliente field id lives in
 * src/config/clients.ts (config-as-code); the Link/Loom url field id is defined
 * here next to the client that consumes it.
 */

/**
 * Structural subset of the global `fetch` we depend on. Injecting this (rather
 * than calling global fetch directly) keeps the client fully offline-testable
 * with a mock.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  /**
   * Header reader, present on the real `fetch` Response (and our test fakes).
   * Declared optional so the minimal mock may omit it; the retry wrapper reads
   * `Retry-After` through it compile-time-safely (IN-03) instead of an
   * unchecked cast.
   */
  headers?: { get(name: string): string | null };
}>;

/**
 * Inputs to createTask. All ClickUp-shaped already: assigneeIds are numeric
 * member ids, dates are epoch MILLISECONDS, clienteOptionId is a dropdown option
 * UUID, link is a plain url string. Nullable fields are omitted from the request
 * body when absent.
 */
export type CreateTaskParams = {
  name: string;
  description?: string | null;
  assigneeIds?: number[];
  startDateMs?: number | null;
  dueDateMs?: number | null;
  clienteOptionId?: string | null;
  link?: string | null;
};

/** The minimal slice of the ClickUp create-task response we surface. */
export type ClickUpTaskResult = {
  id: string;
  url: string;
};

/** The ClickUp custom-field id of the "Link/Loom" url field. */
export const LINK_LOOM_FIELD_ID = "5a03e7cb-0af0-4179-9f05-d0620334fc08";

/** The minimal slice of a GET /task/{id} response we surface for the name fallback. */
export type GetTaskResult = {
  id: string;
  name: string;
  status?: string;
};

/**
 * One entry in a ClickUp webhook `history_items` array. The exact wire shape is
 * a flagged research gap (04-CONTEXT > Claude's Discretion), so every field is
 * optional and loosely typed — extraction code must shape-guard, never assert.
 * `before`/`after` may be a primitive (status labels) or an object (assignee
 * `{ id, username }`); we keep them `unknown`.
 */
export type ClickUpHistoryItem = {
  id?: string;
  field?: string;
  before?: unknown;
  after?: unknown;
};

/**
 * A ClickUp reverse-webhook payload. Only `event` is reliably present; the rest
 * are optional so the parser can defensively reject anything unusable.
 */
export type ClickUpWebhookPayload = {
  event: string;
  task_id?: string;
  webhook_id?: string;
  history_items?: ClickUpHistoryItem[];
};
