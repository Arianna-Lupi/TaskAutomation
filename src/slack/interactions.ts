import {
  claimPending,
  deletePending,
  putPending,
  mapTaskToThread,
  type RedisLike,
} from "../store/redis.js";
import {
  buildConfirmedBlocks,
  buildCanceledBlocks,
  type Block,
} from "./blocks.js";
import type { ClickUpClient } from "../clickup/client.js";

/**
 * Structural Slack client for the interaction handlers — only the methods we
 * call. Injected so the handlers are fully offline-testable.
 */
export type SlackInteractionClient = {
  chat: {
    update(args: {
      channel: string;
      ts: string;
      text: string;
      blocks?: Block[];
    }): Promise<unknown>;
    postMessage(args: {
      channel: string;
      thread_ts?: string;
      text: string;
      blocks?: Block[];
    }): Promise<unknown>;
  };
};

export type InteractionDeps = {
  redis: RedisLike;
  clickup: ClickUpClient;
  slack: SlackInteractionClient;
  timezone: string;
};

export type ActionRef = {
  pendingId: string;
  channel: string;
  messageTs: string;
};

/**
 * Confirmar: idempotently create the ClickUp task and finalize the preview.
 *
 * claimPending (GETDEL) is the idempotency guard — the first click claims the
 * pending and creates exactly one task; a double-click / Slack redelivery gets
 * null and is a no-op (CREATE-01). On success: write the task↔thread map
 * (CREATE-04), update the preview message to the confirmed state (CONFIRM-05),
 * and post the task link back into the thread (CREATE-03).
 *
 * If createTask throws AFTER the claim, the pending is re-put so the human can
 * retry, and nothing destructive is updated (minimal recovery; full error UX is
 * Phase 5).
 */
export async function handleConfirm(
  deps: InteractionDeps,
  ref: ActionRef,
): Promise<void> {
  const pending = await claimPending(deps.redis, ref.pendingId);
  if (!pending) return; // already claimed (double-click) → exactly-once

  const { resolved } = pending;
  try {
    const result = await deps.clickup.createTask({
      name: resolved.title,
      description: resolved.description,
      assigneeIds: resolved.assigneeIds,
      startDateMs: resolved.startDateMs,
      dueDateMs: resolved.dueDateMs,
      clienteOptionId: resolved.clienteOptionId,
      link: resolved.links[0] ?? null,
    });

    await mapTaskToThread(deps.redis, result.id, {
      channel: pending.channel,
      thread_ts: pending.threadTs,
    });

    await deps.slack.chat.update({
      channel: ref.channel,
      ts: ref.messageTs,
      text: "✅ Tarea creada",
      blocks: buildConfirmedBlocks(result.url),
    });

    await deps.slack.chat.postMessage({
      channel: pending.channel,
      thread_ts: pending.threadTs,
      text: `✅ Tarea creada: ${result.url}`,
    });
  } catch (err) {
    // Create failed after the claim — re-arm the pending so the human can retry.
    console.error(
      "[slack] handleConfirm createTask failed (pending restored):",
      err instanceof Error ? err.message : String(err),
    );
    await putPending(deps.redis, ref.pendingId, pending);
  }
}

/**
 * Cancelar: discard the pending and update the preview to the canceled state,
 * removing the buttons (CONFIRM-05).
 */
export async function handleCancel(
  deps: InteractionDeps,
  ref: ActionRef,
): Promise<void> {
  await deletePending(deps.redis, ref.pendingId);
  await deps.slack.chat.update({
    channel: ref.channel,
    ts: ref.messageTs,
    text: "❌ Cancelado",
    blocks: buildCanceledBlocks(),
  });
}
