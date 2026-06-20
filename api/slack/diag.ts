import { WebClient } from "@slack/web-api";
import { loadEnv } from "../../src/config/env.js";
import { createRedis } from "../../src/store/redis.js";
import { evaluateOpsAuth } from "../../src/ops/auth.js";

/**
 * Diagnostic + self-join endpoint (internal ops, NOT part of the bot flow),
 * Phase 8 hardened.
 *
 *   GET  /api/slack/diag    Authorization: Bearer <OPS_API_TOKEN>
 *     → reduced health report (counts/booleans only).
 *   POST /api/slack/diag    Authorization: Bearer <OPS_API_TOKEN>
 *     → makes the bot join ONLY the configured SLACK_TASK_CHANNEL_ID
 *       (needs the channels:join scope), then returns the same report.
 *
 * Gating (FIND-01/02/03):
 *   - Fail-closed: when OPS_API_TOKEN is unset the endpoint returns 404.
 *   - When set it requires `Authorization: Bearer <OPS_API_TOKEN>` (timing-safe),
 *     checked FIRST, before any Slack/Redis call.
 *   - Self-join is POST-only and hardwired to SLACK_TASK_CHANNEL_ID; an
 *     attacker-supplied arbitrary channel is impossible (no join query param).
 *   - Response is reduced to counts/booleans: no full channel list, no Redis
 *     host, no cache key names. The token/secret is never logged or returned.
 *
 * Required bot scopes for full output: channels:read (membership),
 * channels:join (self-join). auth.test works with any valid bot token.
 */
const env = loadEnv();

function slackError(e: unknown): string {
  const data = (e as { data?: { error?: string } })?.data;
  if (data?.error) return data.error;
  return e instanceof Error ? e.message : String(e);
}

/**
 * Build the reduced diagnostic report. Each Slack/Redis call is wrapped so a
 * missing-scope or connectivity error is reported (telling you which scope to
 * add) instead of throwing the page.
 */
async function buildReport(web: WebClient): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = {};

  // Redis (Upstash) connectivity probe — the #1 runtime failure ("fetch failed"
  // means the REST URL is wrong). Expose only the scheme + a boolean, never the
  // host or token (reduced disclosure).
  try {
    const u = new URL(env.UPSTASH_REDIS_REST_URL);
    report.redisUrlScheme = u.protocol; // must be "https:"
  } catch {
    report.redisUrlScheme = "invalid";
  }
  try {
    const redis = createRedis(env);
    await redis.set("diag:ping", "1", { ex: 30 });
    const v = await redis.get("diag:ping");
    report.redisOk = v === "1" || v === 1;
  } catch {
    report.redisOk = false;
  }

  try {
    const auth = await web.auth.test();
    report.botUserId = auth.user_id;
    report.botName = auth.user;
    report.team = auth.team;
  } catch (e) {
    report.authError = slackError(e);
  }

  try {
    const convos = await web.users.conversations({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
    });
    const chans = convos.channels ?? [];
    report.channelCount = chans.length;
    report.taskChannelJoined = chans.some((c) => c.id === env.SLACK_TASK_CHANNEL_ID);
  } catch (e) {
    report.listError = slackError(e); // e.g. "missing_scope" → add channels:read
  }

  return report;
}

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export const GET = async (req: Request): Promise<Response> => {
  const gate = evaluateOpsAuth(env.OPS_API_TOKEN, req.headers.get("authorization"));
  if (gate === "disabled") return new Response("not found", { status: 404 });
  if (gate === "unauthorized") return new Response("unauthorized", { status: 401 });

  const web = new WebClient(env.SLACK_BOT_TOKEN);
  return jsonResponse(await buildReport(web));
};

/** Self-join action (mutation) — POST-only, hardwired to the task channel. */
export const POST = async (req: Request): Promise<Response> => {
  const gate = evaluateOpsAuth(env.OPS_API_TOKEN, req.headers.get("authorization"));
  if (gate === "disabled") return new Response("not found", { status: 404 });
  if (gate === "unauthorized") return new Response("unauthorized", { status: 401 });

  const web = new WebClient(env.SLACK_BOT_TOKEN);

  // The join target is ALWAYS the configured channel — never a request param.
  const report: Record<string, unknown> = {};
  try {
    const r = await web.conversations.join({ channel: env.SLACK_TASK_CHANNEL_ID });
    report.joinOk = Boolean(r.ok);
    if (!r.ok && r.error) report.joinError = r.error;
  } catch (e) {
    report.joinOk = false;
    report.joinError = slackError(e); // e.g. "missing_scope" → add channels:join
  }

  Object.assign(report, await buildReport(web));
  return jsonResponse(report);
};
