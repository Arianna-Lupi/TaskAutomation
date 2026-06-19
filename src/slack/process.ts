import { isProcessableMessage, type IncomingMessage } from "./filter.js";
import {
  markEventOnce,
  clearEvent,
  putPending,
  type RedisLike,
  type PendingTask,
} from "../store/redis.js";
import { buildPreviewBlocks, type Block } from "./blocks.js";
import { parseAndResolve, type ParseAndResolveDeps } from "../parseAndResolve.js";
import {
  reportErrorToThread,
  PARSE_ERROR_MESSAGE,
  GENERIC_ERROR_MESSAGE,
} from "./report.js";
import type { Env } from "../config/env.js";

/**
 * The Phase 1 in-thread receipt text. Phase 3 replaces the placeholder with the
 * real parse→preview, but the constant is kept (as the postMessage fallback text
 * that accompanies the preview blocks for notifications/accessibility).
 */
export const RECEIPT_TEXT = "🆕 Nueva tarea — revisá el preview";

/** Minimal structural type for the bit of the Slack Web client we use. */
export type SlackClientLike = {
  chat: {
    postMessage(args: {
      channel: string;
      thread_ts?: string;
      text: string;
      blocks?: Block[];
    }): Promise<unknown>;
  };
};

export type ProcessDeps = {
  redis: RedisLike;
  client: SlackClientLike;
  env: Pick<Env, "SLACK_TASK_CHANNEL_ID" | "TEAM_TIMEZONE">;
  /** Deps for parseAndResolve (OpenAI client + model + timezone + slack map). */
  parseDeps: ParseAndResolveDeps;
  /** Short random id generator for the pending key (app.ts → crypto.randomUUID). */
  genPendingId: () => string;
  /** Injectable clock for deterministic relative-date resolution. */
  now?: () => number;
  botUserId?: string;
};

export type ProcessEvent = {
  eventId: string;
  message: IncomingMessage;
};

/**
 * Core ingress side-effect: dedup → filter → parse+resolve → persist pending →
 * post the Block Kit preview in the message's thread.
 *
 * Ordering (INGEST-03/04, Pitfalls 1 & 3):
 *  1. markEventOnce — drop Slack retries before doing anything observable.
 *  2. isProcessableMessage — ignore other channels/bots/own/non-root messages.
 *  3. parseAndResolve(text, now) — LLM extraction + deterministic resolution.
 *  4. putPending — persist the ResolvedTask + Slack context under pending:<id>.
 *  5. chat.postMessage — threaded preview with Confirmar/Editar/Cancelar.
 *
 * Failure policy (Pitfall 1):
 *  - A parse/resolve rejection is logged and the dedup key is LEFT SET — a
 *    deterministic LLM re-parse on a Slack retry would just waste spend with the
 *    same failure (rich in-thread error UX is Phase 5 / HARD-01).
 *  - A failure in the side-effect tail (putPending / postMessage) DOES release
 *    the dedup key so a Slack redelivery can re-attempt the persist+preview.
 *
 * Never throws into the ack path — all paths resolve.
 */
export async function processMessageEvent(
  deps: ProcessDeps,
  event: ProcessEvent,
): Promise<void> {
  let marked = false;
  try {
    if (!event.eventId) return;

    const first = await markEventOnce(deps.redis, event.eventId);
    if (!first) return; // duplicate / Slack retry — already handled
    marked = true;

    const { message } = event;
    if (
      !isProcessableMessage(message, {
        taskChannelId: deps.env.SLACK_TASK_CHANNEL_ID,
        botUserId: deps.botUserId,
      })
    ) {
      return;
    }

    const channel = message.channel;
    const messageTs = message.ts;
    if (!channel || !messageTs) return;

    const text = message.text?.trim();
    if (!text) {
      // Nothing to parse — leave the dedup key set (no retry would help).
      console.error("[slack] skipping message with empty text");
      return;
    }

    const threadTs = message.thread_ts ?? messageTs;

    // Parse+resolve. A failure here must NOT clear the dedup key.
    let resolved;
    try {
      const now = deps.now ? deps.now() : Date.now();
      resolved = await parseAndResolve(text, now, deps.parseDeps);
    } catch (parseErr) {
      console.error(
        "[slack] parseAndResolve failed (dedup key kept):",
        parseErr instanceof Error ? parseErr.message : String(parseErr),
      );
      // HARD-01: surface the parse failure in-thread instead of dead silence.
      // Best-effort — never throws — and the dedup key stays SET (no re-parse).
      await reportErrorToThread(deps.client, channel, threadTs, PARSE_ERROR_MESSAGE);
      return; // leave `marked` true → no redelivery re-parse
    }

    // Side-effect tail: a failure here SHOULD release the dedup key (handled by
    // the outer catch) so a Slack redelivery re-attempts persist + preview.
    const pendingId = deps.genPendingId();
    const pending: PendingTask = {
      resolved,
      channel,
      messageTs,
      threadTs,
      rawText: text,
    };
    await putPending(deps.redis, pendingId, pending);

    await deps.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: RECEIPT_TEXT,
      blocks: buildPreviewBlocks(pendingId, resolved, {
        timezone: deps.env.TEAM_TIMEZONE,
      }),
    });
  } catch (err) {
    console.error(
      "[slack] processMessageEvent failed:",
      err instanceof Error ? err.message : String(err),
    );
    // A side-effect failed after we claimed the event — release the dedup key so
    // a Slack redelivery retries rather than being dropped.
    if (marked) {
      try {
        await clearEvent(deps.redis, event.eventId);
      } catch (clearErr) {
        console.error(
          "[slack] failed to clear dedup key after downstream failure:",
          clearErr instanceof Error ? clearErr.message : String(clearErr),
        );
      }
    }
    // HARD-01: a generic capture-path failure also gets a short in-thread notice
    // so the user never sees dead silence. Derive channel/thread defensively —
    // the outer catch must still never throw.
    const channel = event.message?.channel;
    const messageTs = event.message?.ts;
    if (channel && messageTs) {
      const threadTs = event.message?.thread_ts ?? messageTs;
      await reportErrorToThread(deps.client, channel, threadTs, GENERIC_ERROR_MESSAGE);
    }
  }
}
