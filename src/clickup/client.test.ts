import { describe, it, expect, vi } from "vitest";
import { createClickUpClient } from "./client.js";
import { ClickUpRetryError } from "./retry.js";
import { LINK_LOOM_FIELD_ID, type FetchLike } from "./types.js";
import { CLIENTE_FIELD_ID } from "../config/clients.js";

/** Deterministic, instant retry config: records sleeps, zero jitter, base 1ms. */
function fakeRetry() {
  const delays: number[] = [];
  return {
    delays,
    retry: {
      sleep: async (ms: number) => {
        delays.push(ms);
      },
      baseDelayMs: 1,
      random: () => 0,
    },
  };
}

/** A response-shaped object with an optional Retry-After header. */
function response(status: number, opts: { retryAfter?: number } = {}) {
  const body = status >= 200 && status < 300 ? { id: "t1", url: "https://app.clickup.com/t/t1" } : {};
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    ...(opts.retryAfter != null
      ? { headers: { get: (name: string) => (name === "Retry-After" ? String(opts.retryAfter) : null) } }
      : {}),
  };
}

const TOKEN = "pk_secret_token";
const LIST_ID = "901327239630";

function okFetch(
  responseJson: unknown = { id: "abc123", url: "https://app.clickup.com/t/abc123" },
): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => responseJson,
    text: async () => JSON.stringify(responseJson),
  }));
}

function lastBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("createClickUpClient.createTask", () => {
  it("POSTs to /list/{listId}/task with the raw token and JSON content-type", async () => {
    const fetch = okFetch();
    const client = createClickUpClient({ token: TOKEN, listId: LIST_ID, fetch: fetch as unknown as FetchLike });
    await client.createTask({ name: "Hola" });

    const [url, init] = fetch.mock.calls[0] as [string, { method: string; headers: Record<string, string> }];
    expect(url).toBe(`https://api.clickup.com/api/v2/list/${LIST_ID}/task`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(TOKEN);
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("sends dates as epoch-ms integers with *_date_time=false", async () => {
    const fetch = okFetch();
    const client = createClickUpClient({ token: TOKEN, listId: LIST_ID, fetch: fetch as unknown as FetchLike });
    await client.createTask({ name: "T", startDateMs: 1718000000000, dueDateMs: 1718600000000 });

    const body = lastBody(fetch);
    expect(body.start_date).toBe(1718000000000);
    expect(body.start_date_time).toBe(false);
    expect(body.due_date).toBe(1718600000000);
    expect(body.due_date_time).toBe(false);
    expect(Number.isInteger(body.start_date as number)).toBe(true);
  });

  it("passes assignee ids through as a numeric array", async () => {
    const fetch = okFetch();
    const client = createClickUpClient({ token: TOKEN, listId: LIST_ID, fetch: fetch as unknown as FetchLike });
    await client.createTask({ name: "T", assigneeIds: [216158839, 118065209] });
    expect(lastBody(fetch).assignees).toEqual([216158839, 118065209]);
  });

  it("sets Cliente (by UUID) and Link/Loom (url) in custom_fields", async () => {
    const fetch = okFetch();
    const client = createClickUpClient({ token: TOKEN, listId: LIST_ID, fetch: fetch as unknown as FetchLike });
    await client.createTask({
      name: "T",
      clienteOptionId: "63d9626f-9b80-4a19-8638-93b8042d2e9c",
      link: "https://loom.com/x",
    });
    const cf = lastBody(fetch).custom_fields as { id: string; value: string }[];
    expect(cf).toContainEqual({ id: CLIENTE_FIELD_ID, value: "63d9626f-9b80-4a19-8638-93b8042d2e9c" });
    expect(cf).toContainEqual({ id: LINK_LOOM_FIELD_ID, value: "https://loom.com/x" });
  });

  it("omits custom_fields entirely when both Cliente and link are null", async () => {
    const fetch = okFetch();
    const client = createClickUpClient({ token: TOKEN, listId: LIST_ID, fetch: fetch as unknown as FetchLike });
    await client.createTask({ name: "T", clienteOptionId: null, link: null });
    expect(lastBody(fetch).custom_fields).toBeUndefined();
  });

  it("omits description/assignees/dates when not provided", async () => {
    const fetch = okFetch();
    const client = createClickUpClient({ token: TOKEN, listId: LIST_ID, fetch: fetch as unknown as FetchLike });
    await client.createTask({ name: "Solo nombre" });
    const body = lastBody(fetch);
    expect(body).toEqual({ name: "Solo nombre" });
  });

  it("returns {id, url} parsed from the response", async () => {
    const fetch = okFetch({ id: "t1", url: "https://app.clickup.com/t/t1" });
    const client = createClickUpClient({ token: TOKEN, listId: LIST_ID, fetch: fetch as unknown as FetchLike });
    await expect(client.createTask({ name: "T" })).resolves.toEqual({
      id: "t1",
      url: "https://app.clickup.com/t/t1",
    });
  });

  it("throws on a non-2xx response with status + body, without leaking the token", async () => {
    const fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({}),
      text: async () => "Bad Request: invalid field",
    }));
    const client = createClickUpClient({ token: TOKEN, listId: LIST_ID, fetch: fetch as unknown as FetchLike });
    await expect(client.createTask({ name: "T" })).rejects.toThrow(/400/);
    await expect(client.createTask({ name: "T" })).rejects.toThrow(/invalid field/);
    await expect(client.createTask({ name: "T" })).rejects.not.toThrow(/pk_secret_token/);
  });
});

describe("createClickUpClient.getTask", () => {
  function okGet(json: unknown): ReturnType<typeof vi.fn> {
    return vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => json,
      text: async () => JSON.stringify(json),
    }));
  }

  it("GETs /task/{id} with the raw token and returns { id, name, status }", async () => {
    const fetch = okGet({ id: "t9", name: "Diseñar landing", status: { status: "in progress" } });
    const client = createClickUpClient({ token: TOKEN, listId: LIST_ID, fetch: fetch as unknown as FetchLike });
    const result = await client.getTask("t9");

    const [url, init] = fetch.mock.calls[0] as [string, { method?: string; headers: Record<string, string> }];
    expect(url).toBe("https://api.clickup.com/api/v2/task/t9");
    expect(init.headers.Authorization).toBe(TOKEN);
    expect(result.id).toBe("t9");
    expect(result.name).toBe("Diseñar landing");
  });

  it("returns name even when status is absent", async () => {
    const fetch = okGet({ id: "t1", name: "Sin estado" });
    const client = createClickUpClient({ token: TOKEN, listId: LIST_ID, fetch: fetch as unknown as FetchLike });
    expect((await client.getTask("t1")).name).toBe("Sin estado");
  });

  it("throws on a non-2xx response with status + body, without leaking the token", async () => {
    const fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => "Task not found",
    }));
    const client = createClickUpClient({ token: TOKEN, listId: LIST_ID, fetch: fetch as unknown as FetchLike });
    await expect(client.getTask("nope")).rejects.toThrow(/404/);
    await expect(client.getTask("nope")).rejects.toThrow(/not found/);
    await expect(client.getTask("nope")).rejects.not.toThrow(/pk_secret_token/);
  });

  it("throws when the response is missing a string name", async () => {
    const fetch = okGet({ id: "t1" });
    const client = createClickUpClient({ token: TOKEN, listId: LIST_ID, fetch: fetch as unknown as FetchLike });
    await expect(client.getTask("t1")).rejects.toThrow(/name/);
  });
});

describe("createClickUpClient — HARD-02 retry wiring", () => {
  it("retries a 429 then succeeds on the 200 (createTask)", async () => {
    const { delays, retry } = fakeRetry();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response(200));
    const client = createClickUpClient({
      token: TOKEN,
      listId: LIST_ID,
      fetch: fetch as unknown as FetchLike,
      retry,
    });

    await expect(client.createTask({ name: "T" })).resolves.toEqual({
      id: "t1",
      url: "https://app.clickup.com/t/t1",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(delays).toHaveLength(1); // exactly one backoff sleep
  });

  it("does NOT retry a 5xx on createTask (POST) — surfaces it after 1 attempt (WR-01)", async () => {
    // createTask is a non-idempotent POST: a 5xx may have landed AFTER the task
    // was created, so replaying it could create a DUPLICATE. The wrapper must
    // pass the 5xx straight through (the client turns it into an error) without
    // a second attempt.
    const { retry } = fakeRetry();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200));
    const client = createClickUpClient({
      token: TOKEN,
      listId: LIST_ID,
      fetch: fetch as unknown as FetchLike,
      retry,
    });
    await expect(client.createTask({ name: "T" })).rejects.toThrow(/503/);
    expect(fetch).toHaveBeenCalledTimes(1); // never replayed → no duplicate task
  });

  it("DOES retry a 5xx on getTask (GET, idempotent) then succeeds (WR-01)", async () => {
    const { retry } = fakeRetry();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: "t1", name: "Recuperada" }),
        text: async () => "",
      });
    const client = createClickUpClient({
      token: TOKEN,
      listId: LIST_ID,
      fetch: fetch as unknown as FetchLike,
      retry,
    });
    await expect(client.getTask("t1")).resolves.toMatchObject({ id: "t1" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws a typed ClickUpRetryError after maxAttempts of 429 (createTask)", async () => {
    const { delays, retry } = fakeRetry();
    const fetch = vi.fn().mockResolvedValue(response(429));
    const client = createClickUpClient({
      token: TOKEN,
      listId: LIST_ID,
      fetch: fetch as unknown as FetchLike,
      retry,
    });

    const err = await client.createTask({ name: "T" }).catch((e) => e);
    expect(err).toBeInstanceOf(ClickUpRetryError);
    expect((err as ClickUpRetryError).status).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(3); // default maxAttempts
    expect(delays).toHaveLength(2); // maxAttempts - 1 backoffs before the throw
  });

  it("honors Retry-After (seconds → ms) via the injected sleep", async () => {
    const { delays, retry } = fakeRetry();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(429, { retryAfter: 2 }))
      .mockResolvedValueOnce(response(200));
    const client = createClickUpClient({
      token: TOKEN,
      listId: LIST_ID,
      fetch: fetch as unknown as FetchLike,
      retry,
    });

    await client.createTask({ name: "T" });
    expect(delays).toEqual([2000]); // 2s Retry-After, not the 1ms base backoff
  });

  it("retries 429 on getTask too, then returns the task", async () => {
    const { retry } = fakeRetry();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: "t9", name: "Recuperada" }),
        text: async () => "",
      });
    const client = createClickUpClient({
      token: TOKEN,
      listId: LIST_ID,
      fetch: fetch as unknown as FetchLike,
      retry,
    });
    await expect(client.getTask("t9")).resolves.toMatchObject({ name: "Recuperada" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 400 (non-retryable) — surfaces immediately", async () => {
    const { delays, retry } = fakeRetry();
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({}),
      text: async () => "Bad Request",
    });
    const client = createClickUpClient({
      token: TOKEN,
      listId: LIST_ID,
      fetch: fetch as unknown as FetchLike,
      retry,
    });
    await expect(client.createTask({ name: "T" })).rejects.toThrow(/400/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(delays).toHaveLength(0);
  });
});

const TEAM_ID = "90131720021";

/** A fields payload: the Cliente dropdown + an unrelated text field to ignore. */
function fieldsPayload(): unknown {
  return {
    fields: [
      {
        id: "some-text-field",
        name: "Notas",
        type: "text",
      },
      {
        id: CLIENTE_FIELD_ID,
        name: "Cliente",
        type: "drop_down",
        type_config: {
          options: [
            { id: "uuid-felipe", name: "Felipe Vergara", orderindex: 0 },
            { id: "uuid-children", name: "Children Chic", orderindex: 1 },
            { id: "uuid-interno", name: "Interno", orderindex: 2 },
          ],
        },
      },
    ],
  };
}

describe("createClickUpClient.getClienteOptions", () => {
  function okFields(json: unknown): ReturnType<typeof vi.fn> {
    return vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => json,
      text: async () => JSON.stringify(json),
    }));
  }

  it("GETs /list/{listId}/field with the raw token and extracts the Cliente options", async () => {
    const fetch = okFields(fieldsPayload());
    const client = createClickUpClient({
      token: TOKEN,
      listId: LIST_ID,
      teamId: TEAM_ID,
      fetch: fetch as unknown as FetchLike,
    });
    const opts = await client.getClienteOptions();

    const [url, init] = fetch.mock.calls[0] as [string, { method?: string; headers: Record<string, string> }];
    expect(url).toBe(`https://api.clickup.com/api/v2/list/${LIST_ID}/field`);
    expect(init.headers.Authorization).toBe(TOKEN);
    expect(opts).toEqual([
      { id: "uuid-felipe", name: "Felipe Vergara" },
      { id: "uuid-children", name: "Children Chic" },
      { id: "uuid-interno", name: "Interno" },
    ]);
  });

  it("ignores fields other than the Cliente field", async () => {
    const fetch = okFields(fieldsPayload());
    const client = createClickUpClient({
      token: TOKEN,
      listId: LIST_ID,
      teamId: TEAM_ID,
      fetch: fetch as unknown as FetchLike,
    });
    const opts = await client.getClienteOptions();
    expect(opts.every((o) => typeof o.id === "string" && typeof o.name === "string")).toBe(true);
    expect(opts).toHaveLength(3);
  });

  it("routes through the retry fetch (429 then 200 succeeds)", async () => {
    const { delays, retry } = fakeRetry();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => fieldsPayload(),
        text: async () => "",
      });
    const client = createClickUpClient({
      token: TOKEN,
      listId: LIST_ID,
      teamId: TEAM_ID,
      fetch: fetch as unknown as FetchLike,
      retry,
    });
    const opts = await client.getClienteOptions();
    expect(opts).toHaveLength(3);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(delays).toHaveLength(1);
  });

  it("throws on a non-2xx response with status + body, without leaking the token", async () => {
    const fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => "Team not authorized",
    }));
    const client = createClickUpClient({
      token: TOKEN,
      listId: LIST_ID,
      teamId: TEAM_ID,
      fetch: fetch as unknown as FetchLike,
    });
    await expect(client.getClienteOptions()).rejects.toThrow(/401/);
    await expect(client.getClienteOptions()).rejects.toThrow(/not authorized/);
    await expect(client.getClienteOptions()).rejects.not.toThrow(/pk_secret_token/);
  });

  it("throws a clear error when the Cliente field is absent from the payload", async () => {
    const fetch = okFields({ fields: [{ id: "unrelated", name: "x" }] });
    const client = createClickUpClient({
      token: TOKEN,
      listId: LIST_ID,
      teamId: TEAM_ID,
      fetch: fetch as unknown as FetchLike,
    });
    await expect(client.getClienteOptions()).rejects.toThrow(/Cliente/);
  });

  it("throws a clear error when the options array is missing", async () => {
    const fetch = okFields({ fields: [{ id: CLIENTE_FIELD_ID, name: "Cliente" }] });
    const client = createClickUpClient({
      token: TOKEN,
      listId: LIST_ID,
      teamId: TEAM_ID,
      fetch: fetch as unknown as FetchLike,
    });
    await expect(client.getClienteOptions()).rejects.toThrow(/options/);
  });
});

describe("createClickUpClient.getMembers", () => {
  function okMembers(json: unknown): ReturnType<typeof vi.fn> {
    return vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => json,
      text: async () => JSON.stringify(json),
    }));
  }

  const membersPayload = {
    members: [
      { user: { id: 216158839, username: "Miguel Pacheco", email: "miguel@arianna.com" } },
      { user: { id: 118065209, username: "Veronica Romero", email: "VERO@arianna.com" } },
      { user: { id: 999, username: "Sin Email" } },
    ],
  };

  it("GETs /team/{teamId}/member and extracts id/name/email", async () => {
    const fetch = okMembers(membersPayload);
    const client = createClickUpClient({
      token: TOKEN,
      listId: LIST_ID,
      teamId: TEAM_ID,
      fetch: fetch as unknown as FetchLike,
    });
    const members = await client.getMembers();

    const [url, init] = fetch.mock.calls[0] as [string, { method?: string; headers: Record<string, string> }];
    expect(url).toBe(`https://api.clickup.com/api/v2/team/${TEAM_ID}/member`);
    expect(init.headers.Authorization).toBe(TOKEN);
    expect(members).toEqual([
      { id: 216158839, name: "Miguel Pacheco", email: "miguel@arianna.com" },
      { id: 118065209, name: "Veronica Romero", email: "VERO@arianna.com" },
      { id: 999, name: "Sin Email", email: null },
    ]);
  });

  it("coerces a missing email to null and never throws on a partial member", async () => {
    const fetch = okMembers({ members: [{ user: { id: 5, username: "X" } }] });
    const client = createClickUpClient({
      token: TOKEN,
      listId: LIST_ID,
      teamId: TEAM_ID,
      fetch: fetch as unknown as FetchLike,
    });
    const members = await client.getMembers();
    expect(members).toEqual([{ id: 5, name: "X", email: null }]);
  });

  it("routes through the retry fetch (429 then 200)", async () => {
    const { delays, retry } = fakeRetry();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => membersPayload,
        text: async () => "",
      });
    const client = createClickUpClient({
      token: TOKEN,
      listId: LIST_ID,
      teamId: TEAM_ID,
      fetch: fetch as unknown as FetchLike,
      retry,
    });
    await client.getMembers();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(delays).toHaveLength(1);
  });

  it("throws on a non-2xx response with status + body, without leaking the token", async () => {
    const fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
      text: async () => "Forbidden",
    }));
    const client = createClickUpClient({
      token: TOKEN,
      listId: LIST_ID,
      teamId: TEAM_ID,
      fetch: fetch as unknown as FetchLike,
    });
    await expect(client.getMembers()).rejects.toThrow(/403/);
    await expect(client.getMembers()).rejects.not.toThrow(/pk_secret_token/);
  });

  it("throws a clear error when the members array is missing", async () => {
    const fetch = okMembers({ notMembers: [] });
    const client = createClickUpClient({
      token: TOKEN,
      listId: LIST_ID,
      teamId: TEAM_ID,
      fetch: fetch as unknown as FetchLike,
    });
    await expect(client.getMembers()).rejects.toThrow(/members/);
  });
});
