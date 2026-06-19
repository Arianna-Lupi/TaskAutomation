import { App } from "@slack/bolt";
import { VercelReceiver, createHandler, type VercelHandler } from "@vercel/slack-bolt";
import crypto from "node:crypto";
import type { Env } from "../config/env.js";
import { createRedis } from "../store/redis.js";
import { processMessageEvent } from "./process.js";
import {
  handleConfirm,
  handleCancel,
  handleEditOpen,
  handleEditSubmit,
  type InteractionDeps,
  type SlackInteractionClient,
} from "./interactions.js";
import { createClickUpClient } from "../clickup/client.js";
import { createOpenAIClient } from "../llm/openai.js";
import { SLACK_TO_MEMBER } from "../config/members.js";
import type { ParseAndResolveDeps } from "../parseAndResolve.js";
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

/** Narrow the Bolt Web client to the SlackInteractionClient shape we inject. */
function asInteractionClient(client: unknown): SlackInteractionClient {
  return client as SlackInteractionClient;
}

/**
 * Build the Bolt App wired to the Vercel adapter. Signature verification and the
 * ACK<3s → background `waitUntil` pattern are handled by the receiver/adapter —
 * no hand-rolled HMAC (INGEST-01/02). The message listener delegates to
 * processMessageEvent (dedup + filter + parse + preview); button clicks route to
 * app.action handlers which ack() first, then create/cancel in the background.
 *
 * `tokenVerification: false` keeps construction/init network-free (offline
 * testable); the bot user id is resolved lazily on first event instead. Heavy
 * clients (Redis / OpenAI / ClickUp) are constructed lazily, once per warm
 * instance, on first use.
 */
export function createSlackApp(env: Env): SlackApp {
  const receiver = new VercelReceiver({
    signingSecret: env.SLACK_SIGNING_SECRET,
  });

  const app = new App({
    receiver,
    authorize: async () => ({ botToken: env.SLACK_BOT_TOKEN }),
    deferInitialization: true,
  });

  const resolveBotUserId = makeBotUserIdResolver();

  // Single instance of each heavy client per warm instance (lazy on first use).
  let redis: ReturnType<typeof createRedis> | undefined;
  const getRedis = () => (redis ??= createRedis(env));

  let clickup: ReturnType<typeof createClickUpClient> | undefined;
  const getClickup = () =>
    (clickup ??= createClickUpClient({
      token: env.CLICKUP_API_TOKEN,
      listId: env.CLICKUP_LIST_ID,
      // HARD-02: the client routes every createTask/getTask call through
      // createRetryingFetch internally (429 Retry-After + 5xx backoff), using a
      // real setTimeout-based sleep by default — nothing to wrap here.
      fetch: globalThis.fetch as unknown as Parameters<
        typeof createClickUpClient
      >[0]["fetch"],
    }));

  let parseDeps: ParseAndResolveDeps | undefined;
  const getParseDeps = (): ParseAndResolveDeps =>
    (parseDeps ??= {
      client: createOpenAIClient({ OPENAI_API_KEY: env.OPENAI_API_KEY }),
      model: env.OPENAI_MODEL,
      timezone: env.TEAM_TIMEZONE,
      slackToMember: SLACK_TO_MEMBER,
    });

  const interactionDeps = (client: unknown): InteractionDeps => ({
    redis: getRedis(),
    clickup: getClickup(),
    slack: asInteractionClient(client),
    timezone: env.TEAM_TIMEZONE,
  });

  app.message(async ({ message, body, client }) => {
    const eventId =
      typeof (body as { event_id?: unknown }).event_id === "string"
        ? (body as { event_id: string }).event_id
        : "";
    const botUserId = await resolveBotUserId(client as unknown as AuthTestClient);

    await processMessageEvent(
      {
        redis: getRedis(),
        client,
        env,
        parseDeps: getParseDeps(),
        genPendingId: () => crypto.randomUUID(),
        botUserId,
      },
      { eventId, message: message as IncomingMessage },
    );
  });

  // Extract pendingId from the clicked button's value, and channel/messageTs
  // from the interaction container.
  const refFrom = (body: unknown, action: unknown) => {
    const container = (body as { container?: { channel_id?: string; message_ts?: string } })
      .container ?? {};
    return {
      pendingId: String((action as { value?: string }).value ?? ""),
      channel: container.channel_id ?? "",
      messageTs: container.message_ts ?? "",
    };
  };

  app.action("confirm_task", async ({ ack, body, action, client }) => {
    await ack(); // ACK<3s; the ClickUp create runs after in the adapter waitUntil
    await handleConfirm(interactionDeps(client), refFrom(body, action));
  });

  app.action("cancel_task", async ({ ack, body, action, client }) => {
    await ack();
    await handleCancel(interactionDeps(client), refFrom(body, action));
  });

  app.action("edit_task", async ({ ack, body, action, client }) => {
    await ack(); // ack first, then open the modal while trigger_id is valid (<3s)
    const ref = refFrom(body, action);
    const triggerId = String((body as { trigger_id?: string }).trigger_id ?? "");
    await handleEditOpen(interactionDeps(client), { ...ref, triggerId });
  });

  app.view("edit_modal_submit", async ({ ack, body, client }) => {
    await ack();
    await handleEditSubmit(interactionDeps(client), body.view);
  });

  const handler = createHandler(app, receiver);
  return { app, receiver, handler };
}
