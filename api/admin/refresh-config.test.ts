import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * GET /api/admin/refresh-config gating (WR-01).
 *
 * The GET handler must run the ops auth gate FIRST (matching diag.ts order) so
 * an unauthenticated caller never learns the endpoint exists:
 *   - OPS_API_TOKEN unset            → 404 (uniform "not found", no disclosure)
 *   - OPS_API_TOKEN set, no/wrong Bearer → 401
 *   - OPS_API_TOKEN set, correct Bearer  → 405 (authenticated, wrong method)
 *
 * `loadEnv()` runs at module load, so each case sets process.env then
 * dynamically re-imports the handler under vi.resetModules.
 */
const BASE_ENV: Record<string, string> = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_SIGNING_SECRET: "sign-test",
  SLACK_TASK_CHANNEL_ID: "C123",
  UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "redis-test",
  OPENAI_API_KEY: "sk-test",
  CLICKUP_API_TOKEN: "pk_test",
  CLICKUP_WEBHOOK_SECRET: "wh-secret",
};

async function loadGET(extra: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...extra })) {
    process.env[k] = v;
  }
  const mod = await import("./refresh-config.js");
  return mod.GET;
}

describe("GET /api/admin/refresh-config gating (WR-01)", () => {
  const ORIGINAL = { ...process.env };

  beforeEach(() => {
    delete process.env.OPS_API_TOKEN;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("returns 404 (not 405) when OPS_API_TOKEN is UNSET — no disclosure", async () => {
    const GET = await loadGET({});
    delete process.env.OPS_API_TOKEN;
    const res = await GET(new Request("https://x/api/admin/refresh-config"));
    expect(res.status).toBe(404);
  });

  it("returns 401 when token is set but no Bearer header is sent", async () => {
    const GET = await loadGET({ OPS_API_TOKEN: "secret-tok" });
    const res = await GET(new Request("https://x/api/admin/refresh-config"));
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is set but the Bearer value is wrong", async () => {
    const GET = await loadGET({ OPS_API_TOKEN: "secret-tok" });
    const res = await GET(
      new Request("https://x/api/admin/refresh-config", {
        headers: { authorization: "Bearer wrong" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 405 for an authenticated caller using the wrong method", async () => {
    const GET = await loadGET({ OPS_API_TOKEN: "secret-tok" });
    const res = await GET(
      new Request("https://x/api/admin/refresh-config", {
        headers: { authorization: "Bearer secret-tok" },
      }),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});
