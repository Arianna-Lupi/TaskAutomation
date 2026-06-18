import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { createSlackApp } from "./app.js";
import type { Env } from "../config/env.js";

const SIGNING_SECRET = "test-signing-secret";

const testEnv: Env = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_SIGNING_SECRET: SIGNING_SECRET,
  SLACK_TASK_CHANNEL_ID: "C_TASK",
  UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "token-abc",
  TEAM_TIMEZONE: "America/Caracas",
};

function sign(body: string, timestamp: number, secret = SIGNING_SECRET): string {
  const base = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac("sha256", secret).update(base).digest("hex");
  return `v0=${hmac}`;
}

function slackRequest(
  body: string,
  { timestamp, signature }: { timestamp: number; signature: string },
): Request {
  return new Request("https://example.com/api/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": signature,
    },
    body,
  });
}

describe("Slack events endpoint (signature + challenge)", () => {
  it("accepts a validly-signed url_verification challenge and echoes the challenge", async () => {
    const { handler } = createSlackApp(testEnv);
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const ts = Math.floor(Date.now() / 1000);
    const res = await handler(slackRequest(body, { timestamp: ts, signature: sign(body, ts) }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { challenge?: string };
    expect(json.challenge).toBe("abc123");
  });

  it("rejects a request with an invalid signature", async () => {
    const { handler } = createSlackApp(testEnv);
    const body = JSON.stringify({ type: "url_verification", challenge: "x" });
    const ts = Math.floor(Date.now() / 1000);
    const res = await handler(
      slackRequest(body, { timestamp: ts, signature: "v0=deadbeef" }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects a request signed with the wrong secret", async () => {
    const { handler } = createSlackApp(testEnv);
    const body = JSON.stringify({ type: "url_verification", challenge: "x" });
    const ts = Math.floor(Date.now() / 1000);
    const res = await handler(
      slackRequest(body, { timestamp: ts, signature: sign(body, ts, "wrong-secret") }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects a stale request (timestamp older than 5 minutes)", async () => {
    const { handler } = createSlackApp(testEnv);
    const body = JSON.stringify({ type: "url_verification", challenge: "x" });
    const staleTs = Math.floor(Date.now() / 1000) - 60 * 6; // 6 minutes old
    const res = await handler(
      slackRequest(body, { timestamp: staleTs, signature: sign(body, staleTs) }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
