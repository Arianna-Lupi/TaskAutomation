import { App } from "@slack/bolt";
import { VercelReceiver, createHandler, type VercelHandler } from "@vercel/slack-bolt";
import type { Env } from "../config/env.js";
import { createRedis } from "../store/redis.js";
import { processMessageEvent } from "./process.js";
import type { IncomingMessage } from "./filter.js";

export type SlackApp = {
  app: App;
  receiver: VercelReceiver;
  handler: VercelHandler;
};

type AuthTestClient = {
  auth: { test(): Promise<{ user_id?: string }> };
};

/**
 * Resolve and cache the bot's own user id (one auth.test per warm instance) so
 * the echo-loop filter can drop the bot's own messages. Failures are swallowed
 * — the message filter still rejects bot_id/subtype messages without it.
 */
function makeBotUserIdResolver(): (
  client: AuthTestClient,
) => Promise<string | undefined> {
  let cached: Promise<string | undefined> | undefined;
  return (client) => {
    if (!cached) {
      cached = client.auth
        .test()
        .then((res) => {
          const userId = res.user_id ?? undefined;
          // A successful auth.test that returns no user_id is not a usable
          // result — don't cache it, so a later event can re-resolve instead of
          // being stuck with `undefined` forever.
          if (userId === undefined) cached = undefined;
          return userId;
        })
        .catch((err) => {
          console.error(
            "[slack] auth.test failed while resolving bot user id:",
            err instanceof Error ? err.message : String(err),
          );
          cached = undefined; // allow a later retry
          return undefined;
        });
    }
    return cached;
  };
}

/**
 * Build the Bolt App wired to the Vercel adapter. Signature verification and the
 * ACK<3s → background `waitUntil` pattern are handled by the receiver/adapter —
 * no hand-rolled HMAC (INGEST-01/02). The message listener delegates to
 * processMessageEvent (dedup + filter + receipt, INGEST-03/04).
 *
 * `tokenVerification: false` keeps construction/init network-free (offline
 * testable); the bot user id is resolved lazily on first event instead.
 */
export function createSlackApp(env: Env): SlackApp {
  const receiver = new VercelReceiver({
    signingSecret: env.SLACK_SIGNING_SECRET,
  });

  const app = new App({
    receiver,
    // Provide `authorize` (not `token`) so App.init() stays network-free and
    // offline-testable; the bot token is supplied per-event for the Web client.
    authorize: async () => ({ botToken: env.SLACK_BOT_TOKEN }),
    // The @vercel/slack-bolt adapter calls app.init() itself; deferred init is
    // what makes that supported (stores the authorize fn for init()).
    deferInitialization: true,
  });

  const resolveBotUserId = makeBotUserIdResolver();

  // Single Redis client per warm instance — env validation and client
  // construction run once (lazily, on first event) rather than per message.
  let redis: ReturnType<typeof createRedis> | undefined;
  const getRedis = () => (redis ??= createRedis(env));

  app.message(async ({ message, body, client }) => {
    const eventId =
      typeof (body as { event_id?: unknown }).event_id === "string"
        ? (body as { event_id: string }).event_id
        : "";
    const botUserId = await resolveBotUserId(client as unknown as AuthTestClient);

    await processMessageEvent(
      { redis: getRedis(), client, env, botUserId },
      { eventId, message: message as IncomingMessage },
    );
  });

  const handler = createHandler(app, receiver);
  return { app, receiver, handler };
}
