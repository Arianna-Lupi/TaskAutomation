import { waitUntil } from "@vercel/functions";
import { WebClient } from "@slack/web-api";
import { loadEnv, type Env } from "../../src/config/env.js";
import { createRedis } from "../../src/store/redis.js";
import { createClickUpClient } from "../../src/clickup/client.js";
import {
  verifyClickUpSignature,
  getClickUpSignatureHeader,
} from "../../src/clickup/signature.js";
import {
  parseWebhookPayload,
  processClickUpWebhook,
  type ClickUpWebhookDeps,
  type SlackPosterLike,
} from "../../src/clickup/webhook.js";

/**
 * Flow B HTTP ingress (Phase 4, NOTIFY-01/02). A PLAIN Vercel function — NOT the
 * Bolt adapter (that path is Slack-only). It:
 *   1. reads the RAW body FIRST (never JSON-parse before the HMAC — Pitfall 2/7),
 *   2. verifies ClickUp's X-Signature over that raw body (401 on missing/mismatch),
 *   3. ACKs 200 fast and runs processClickUpWebhook in the background via waitUntil
 *      (ClickUp retries on non-2xx; the 04-02 dedup covers redelivery).
 *
 * Env is loaded once per warm instance (fail-fast); heavy clients are built lazily.
 * The signing secret and API tokens are read from env only and never logged.
 */

// Construct env once per warm instance — a misconfigured deploy fails fast.
const env: Env = loadEnv();

// Lazily-built singletons per warm instance.
let cachedDeps: ClickUpWebhookDeps | undefined;

function getDeps(): ClickUpWebhookDeps {
  if (cachedDeps) return cachedDeps;

  const redis = createRedis(env);

  // @slack/web-api WebClient.chat.postMessage satisfies SlackPosterLike.
  const slack = new WebClient(env.SLACK_BOT_TOKEN) as unknown as SlackPosterLike;

  const clickup = createClickUpClient({
    token: env.CLICKUP_API_TOKEN,
    listId: env.CLICKUP_LIST_ID,
    fetch: globalThis.fetch as unknown as Parameters<
      typeof createClickUpClient
    >[0]["fetch"],
  });

  cachedDeps = {
    redis,
    slack,
    // Fall back to a live task fetch for the name; any failure resolves null so
    // the processor degrades to the task id (never throws into waitUntil).
    getTaskName: async (id: string): Promise<string | null> => {
      try {
        return (await clickup.getTask(id)).name;
      } catch {
        return null;
      }
    },
  };
  return cachedDeps;
}

export const POST = async (req: Request): Promise<Response> => {
  // 1. RAW body first — the HMAC must be computed over the exact bytes.
  const raw = await req.text();

  // 2. Case-insensitive X-Signature lookup + raw-body verify (NOTIFY-01).
  const sig = getClickUpSignatureHeader(req.headers);
  if (!sig || !verifyClickUpSignature(raw, sig, env.CLICKUP_WEBHOOK_SECRET)) {
    return new Response("invalid signature", { status: 401 });
  }

  // 3. Parse; an unusable body is still a 200 ACK (nothing to do).
  const payload = parseWebhookPayload(raw);
  if (!payload) {
    return new Response("ok", { status: 200 });
  }

  // 4. ACK fast, process in the background (CONTEXT > ACK fast then process).
  waitUntil(processClickUpWebhook(getDeps(), payload));
  return new Response("ok", { status: 200 });
};

export default POST;
