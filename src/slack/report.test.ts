import { describe, it, expect, vi } from "vitest";
import {
  reportErrorToThread,
  PARSE_ERROR_MESSAGE,
  GENERIC_ERROR_MESSAGE,
  createFailureMessage,
} from "./report.js";

function fakeClient() {
  return { chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) } };
}

describe("reportErrorToThread", () => {
  it("posts once to the thread with { channel, thread_ts, text }", async () => {
    const client = fakeClient();
    await reportErrorToThread(client, "C1", "1700.0001", PARSE_ERROR_MESSAGE);
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: "1700.0001",
      text: PARSE_ERROR_MESSAGE,
    });
  });

  it("never throws when postMessage rejects (best-effort) and resolves to undefined", async () => {
    const client = fakeClient();
    client.chat.postMessage.mockRejectedValueOnce(new Error("slack 500"));
    await expect(
      reportErrorToThread(client, "C1", "1700.0001", GENERIC_ERROR_MESSAGE),
    ).resolves.toBeUndefined();
  });
});

describe("Spanish message constants", () => {
  it("PARSE_ERROR_MESSAGE is verbatim", () => {
    expect(PARSE_ERROR_MESSAGE).toBe(
      "⚠️ No entendí bien el mensaje. Escríbelo de otra forma o crea la tarea a mano.",
    );
  });

  it("GENERIC_ERROR_MESSAGE is verbatim", () => {
    expect(GENERIC_ERROR_MESSAGE).toBe(
      "⚠️ Hubo un problema al procesar el mensaje. Inténtalo de nuevo en un momento.",
    );
  });

  it("createFailureMessage interpolates a numeric status", () => {
    expect(createFailureMessage(429)).toBe(
      "⚠️ No se pudo crear la tarea en ClickUp (429). Inténtalo de nuevo.",
    );
  });

  it("createFailureMessage interpolates a string status", () => {
    expect(createFailureMessage("503")).toBe(
      "⚠️ No se pudo crear la tarea en ClickUp (503). Inténtalo de nuevo.",
    );
  });

  it("createFailureMessage renders a sensible placeholder for a missing status", () => {
    expect(createFailureMessage(undefined)).toBe(
      "⚠️ No se pudo crear la tarea en ClickUp (error). Inténtalo de nuevo.",
    );
  });
});
