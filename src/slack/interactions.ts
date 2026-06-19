import {
  claimPending,
  deletePending,
  getPending,
  putPending,
  mapTaskToThread,
  type RedisLike,
} from "../store/redis.js";
import {
  buildPreviewBlocks,
  buildConfirmedBlocks,
  buildCanceledBlocks,
  type Block,
} from "./blocks.js";
import {
  buildEditModal,
  parseEditSubmission,
  type EditModalView,
} from "./modal.js";
import type { ClickUpClient } from "../clickup/client.js";
import { ClickUpRetryError } from "../clickup/retry.js";
import { reportErrorToThread, createFailureMessage } from "./report.js";

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
  views: {
    open(args: { trigger_id: string; view: EditModalView }): Promise<unknown>;
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

/** User-facing notice when a Confirm/Edit targets a pending that is gone. */
const PENDING_GONE_NOTICE =
  "⚠️ Esta tarea ya fue procesada o expiró. Reenviá el mensaje para volver a capturarla.";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Best-effort thread notice — never throws. Used to give the human feedback when
 * a pending has been claimed/expired so the interaction is no longer a silent
 * no-op (WR-01/WR-02). Failures here are logged, never propagated.
 */
async function postThreadNotice(
  deps: InteractionDeps,
  channel: string,
  threadTs: string,
  text: string,
): Promise<void> {
  try {
    await deps.slack.chat.postMessage({ channel, thread_ts: threadTs, text });
  } catch (err) {
    console.error("[slack] postThreadNotice failed:", errMsg(err));
  }
}

/**
 * Confirmar: idempotently create the ClickUp task and finalize the preview.
 *
 * claimPending (GETDEL) is the idempotency guard — the first click claims the
 * pending and creates exactly one task; a double-click / Slack redelivery gets
 * null and is surfaced with a notice (CREATE-01 / WR-01).
 *
 * Exactly-once correctness (CR-01): createTask is the *point of no return*. The
 * pending is restored for retry ONLY when the failure happens BEFORE createTask
 * runs (or createTask itself throws). Once createTask succeeds the task exists,
 * so every post-create step (task↔thread map, message update, thread link) is
 * best-effort — its failure is logged but NEVER restores the pending and NEVER
 * re-runs createTask, so a subsequent confirm cannot create a duplicate.
 */
export async function handleConfirm(
  deps: InteractionDeps,
  ref: ActionRef,
): Promise<void> {
  const pending = await claimPending(deps.redis, ref.pendingId);
  if (!pending) {
    // Already claimed (double-click) / expired → exactly-once. Surface feedback
    // in the preview thread instead of silently doing nothing (WR-01).
    await postThreadNotice(deps, ref.channel, ref.messageTs, PENDING_GONE_NOTICE);
    return;
  }

  const { resolved } = pending;

  // ── Point of no return ────────────────────────────────────────────────────
  // A failure HERE is the only case where the pending is restored: no task was
  // created yet, so the human can safely retry.
  let result: Awaited<ReturnType<ClickUpClient["createTask"]>>;
  try {
    result = await deps.clickup.createTask({
      name: resolved.title,
      description: resolved.description,
      assigneeIds: resolved.assigneeIds,
      startDateMs: resolved.startDateMs,
      dueDateMs: resolved.dueDateMs,
      clienteOptionId: resolved.clienteOptionId,
      link: resolved.links[0] ?? null,
    });
  } catch (err) {
    console.error(
      "[slack] handleConfirm createTask failed (pending restored for retry):",
      errMsg(err),
    );
    // CR-01: no task was created → restore the pending so the human can retry.
    await putPending(deps.redis, ref.pendingId, pending);
    // HARD-01: tell the human the create failed (with the ClickUp status when the
    // retry wrapper surfaced one) instead of leaving the thread silent. The
    // pending stays recoverable above; this report is best-effort, never throws.
    const status = err instanceof ClickUpRetryError ? err.status : undefined;
    await reportErrorToThread(
      deps.slack,
      ref.channel,
      ref.messageTs,
      createFailureMessage(status),
    );
    return;
  }

  // ── Past the point of no return ───────────────────────────────────────────
  // The ClickUp task now exists. From here we NEVER restore the pending and
  // NEVER recreate — every step below is independently best-effort so a single
  // failure cannot suppress the others or trigger a duplicate create.
  try {
    await mapTaskToThread(deps.redis, result.id, {
      channel: pending.channel,
      thread_ts: pending.threadTs,
    });
  } catch (err) {
    console.error(
      "[slack] handleConfirm mapTaskToThread failed (task already created, not restored):",
      errMsg(err),
    );
  }

  try {
    await deps.slack.chat.update({
      channel: ref.channel,
      ts: ref.messageTs,
      text: "✅ Tarea creada",
      blocks: buildConfirmedBlocks(result.url),
    });
  } catch (err) {
    console.error(
      "[slack] handleConfirm chat.update failed (task already created, not restored):",
      errMsg(err),
    );
  }

  try {
    await deps.slack.chat.postMessage({
      channel: pending.channel,
      thread_ts: pending.threadTs,
      text: `✅ Tarea creada: ${result.url}`,
    });
  } catch (err) {
    console.error(
      "[slack] handleConfirm postMessage failed (task already created, not restored):",
      errMsg(err),
    );
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

/**
 * Editar (open): load the pending and open a prefilled modal within Slack's ~3s
 * trigger window (CONFIRM-04). If the pending expired, no-op (the human re-sends
 * the message — low impact within the 1h TTL).
 */
export async function handleEditOpen(
  deps: InteractionDeps,
  ref: ActionRef & { triggerId: string },
): Promise<void> {
  const pending = await getPending(deps.redis, ref.pendingId);
  if (!pending) {
    // Expired between preview and Edit — tell the human instead of no-op (WR-02).
    await postThreadNotice(deps, ref.channel, ref.messageTs, PENDING_GONE_NOTICE);
    return;
  }

  await deps.slack.views.open({
    trigger_id: ref.triggerId,
    view: buildEditModal(pending.resolved, {
      pendingId: ref.pendingId,
      channel: ref.channel,
      messageTs: ref.messageTs,
      timezone: deps.timezone,
    }),
  });
}

/**
 * Editar (submit): merge the parsed patch over the stored ResolvedTask, persist
 * the corrected pending, and re-render the threaded preview so it reflects the
 * fixes (still showing Confirmar/Editar/Cancelar). No-op if the pending expired
 * between open and submit.
 */
export async function handleEditSubmit(
  deps: InteractionDeps,
  view: Parameters<typeof parseEditSubmission>[0],
): Promise<void> {
  let parsed: ReturnType<typeof parseEditSubmission>;
  try {
    parsed = parseEditSubmission(view, { timezone: deps.timezone });
  } catch (err) {
    // Malformed/tampered private_metadata — abort this interaction cleanly so it
    // never surfaces as an unhandled rejection (WR-04).
    console.error("[slack] handleEditSubmit: invalid private_metadata, aborting:", errMsg(err));
    return;
  }
  const { meta, patch } = parsed;

  const pending = await getPending(deps.redis, meta.pendingId);
  if (!pending) {
    // Expired between open and submit — surface feedback instead of no-op (WR-02).
    await postThreadNotice(deps, meta.channel, meta.messageTs, PENDING_GONE_NOTICE);
    return;
  }

  const updatedResolved = { ...pending.resolved, ...patch };
  await putPending(deps.redis, meta.pendingId, {
    ...pending,
    resolved: updatedResolved,
  });

  await deps.slack.chat.update({
    channel: meta.channel,
    ts: meta.messageTs,
    text: "🆕 Nueva tarea — revisá el preview",
    blocks: buildPreviewBlocks(meta.pendingId, updatedResolved, {
      timezone: deps.timezone,
    }),
  });
}
