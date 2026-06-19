import { describe, it, expect, vi } from "vitest";
import { createClickUpClient } from "./client.js";
import { LINK_LOOM_FIELD_ID, type FetchLike } from "./types.js";
import { CLIENTE_FIELD_ID } from "../config/clients.js";

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
