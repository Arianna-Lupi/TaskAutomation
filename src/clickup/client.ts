import { CLIENTE_FIELD_ID } from "../config/clients.js";
import { createRetryingFetch, type RetryingFetchOpts } from "./retry.js";
import {
  LINK_LOOM_FIELD_ID,
  type ClickUpTaskResult,
  type CreateTaskParams,
  type FetchLike,
  type GetTaskResult,
} from "./types.js";

const BASE_URL = "https://api.clickup.com/api/v2";

/** Production sleep: a real `setTimeout`. Overridden in tests for determinism. */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type ClickUpClient = {
  createTask(params: CreateTaskParams): Promise<ClickUpTaskResult>;
  getTask(taskId: string): Promise<GetTaskResult>;
};

type CreateTaskBody = {
  name: string;
  description?: string;
  assignees?: number[];
  start_date?: number;
  start_date_time?: boolean;
  due_date?: number;
  due_date_time?: boolean;
  custom_fields?: { id: string; value: string }[];
};

/**
 * Build an injectable ClickUp REST v2 client. `fetch` is injected so all callers
 * (and tests) supply their own — the client never reaches for a global. The
 * token is read once from the caller's env and used as the raw Authorization
 * header (ClickUp personal/OAuth tokens are NOT "Bearer " prefixed).
 *
 * HARD-02: every HTTP call (createTask, getTask) is routed through
 * `createRetryingFetch`, so a ClickUp 429 (honoring `Retry-After`) or 5xx is
 * retried with capped exponential backoff + jitter, and exhaustion throws a
 * typed `ClickUpRetryError` carrying the final status — which the HARD-01
 * create-failure path surfaces in-thread. The `sleep`/`random` are injected
 * (via `retry`) so the backoff is fully deterministic and instant under test;
 * production uses a real `setTimeout`. Non-retryable responses pass straight
 * through unchanged, so the existing client behavior is preserved.
 *
 * createTask POSTs to /list/{listId}/task. Nullable fields are omitted from the
 * body entirely; dates are sent as epoch-ms integers paired with
 * *_date_time=false (the resolver emits day-granularity midnight-in-TZ ms).
 * Cliente + Link/Loom are set inline via the custom_fields array (no separate
 * field-value call). A non-2xx response throws an Error carrying the status and
 * the response body text — but never the Authorization token.
 */
export function createClickUpClient(deps: {
  token: string;
  listId: string;
  fetch: FetchLike;
  /**
   * Retry knobs for the 429/5xx backoff wrapper (HARD-02). `sleep` defaults to a
   * real `setTimeout`; tests inject a recorder for deterministic, instant runs.
   */
  retry?: Partial<RetryingFetchOpts>;
}): ClickUpClient {
  const { token, listId } = deps;
  const fetch = createRetryingFetch(deps.fetch, {
    sleep: deps.retry?.sleep ?? defaultSleep,
    ...(deps.retry?.maxAttempts != null
      ? { maxAttempts: deps.retry.maxAttempts }
      : {}),
    ...(deps.retry?.baseDelayMs != null
      ? { baseDelayMs: deps.retry.baseDelayMs }
      : {}),
    ...(deps.retry?.random != null ? { random: deps.retry.random } : {}),
  });

  return {
    async createTask(params: CreateTaskParams): Promise<ClickUpTaskResult> {
      const body: CreateTaskBody = { name: params.name };

      if (params.description != null) body.description = params.description;
      if (params.assigneeIds && params.assigneeIds.length > 0) {
        body.assignees = params.assigneeIds;
      }
      if (params.startDateMs != null) {
        body.start_date = params.startDateMs;
        body.start_date_time = false;
      }
      if (params.dueDateMs != null) {
        body.due_date = params.dueDateMs;
        body.due_date_time = false;
      }

      const customFields: { id: string; value: string }[] = [];
      if (params.clienteOptionId != null) {
        customFields.push({ id: CLIENTE_FIELD_ID, value: params.clienteOptionId });
      }
      if (params.link != null) {
        customFields.push({ id: LINK_LOOM_FIELD_ID, value: params.link });
      }
      if (customFields.length > 0) body.custom_fields = customFields;

      const res = await fetch(`${BASE_URL}/list/${listId}/task`, {
        method: "POST",
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        // Surface status + body for diagnosis; the token is never included.
        const text = await res.text().catch(() => "");
        throw new Error(
          `ClickUp createTask failed — status ${res.status}: ${text}`,
        );
      }

      const json = (await res.json()) as { id?: unknown; url?: unknown };
      if (typeof json.id !== "string" || typeof json.url !== "string") {
        throw new Error("ClickUp createTask: response missing id/url");
      }
      return { id: json.id, url: json.url };
    },

    async getTask(taskId: string): Promise<GetTaskResult> {
      const res = await fetch(`${BASE_URL}/task/${taskId}`, {
        method: "GET",
        headers: { Authorization: token },
      });

      if (!res.ok) {
        // Surface status + body for diagnosis; the token is never included.
        const text = await res.text().catch(() => "");
        throw new Error(
          `ClickUp getTask failed — status ${res.status}: ${text}`,
        );
      }

      const json = (await res.json()) as {
        id?: unknown;
        name?: unknown;
        status?: unknown;
      };
      if (typeof json.name !== "string") {
        throw new Error("ClickUp getTask: response missing a string name");
      }
      // ClickUp returns status as an object ({ status: "in progress", ... }); we
      // surface only the label string when present, tolerating either shape.
      let status: string | undefined;
      if (typeof json.status === "string") {
        status = json.status;
      } else if (
        json.status != null &&
        typeof json.status === "object" &&
        typeof (json.status as { status?: unknown }).status === "string"
      ) {
        status = (json.status as { status: string }).status;
      }
      return {
        id: typeof json.id === "string" ? json.id : taskId,
        name: json.name,
        ...(status != null ? { status } : {}),
      };
    },
  };
}
