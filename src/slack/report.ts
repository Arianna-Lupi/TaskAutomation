/**
 * Centralized in-thread error reporting (HARD-01). Both the capture path
 * (process.ts) and the confirm path (interactions.ts) post a clear, actionable
 * Spanish message back into the originating thread instead of failing silently.
 *
 * The helper is structurally typed and dependency-free so it works with both the
 * SlackClientLike (process.ts) and SlackInteractionClient (interactions.ts)
 * shapes, and it is strictly best-effort: a failed postMessage is logged and
 * swallowed so error reporting can NEVER throw into the ACK/waitUntil boundary.
 */

/** Spanish notice when parse/resolve fails — tells the human what to do. */
export const PARSE_ERROR_MESSAGE =
  "⚠️ No entendí bien el mensaje. Escríbelo de otra forma o crea la tarea a mano.";

/** Spanish notice for an unexpected capture-path failure (no dead silence). */
export const GENERIC_ERROR_MESSAGE =
  "⚠️ Hubo un problema al procesar el mensaje. Inténtalo de nuevo en un momento.";

/**
 * Build the ClickUp create-failure notice with the HTTP status interpolated. A
 * missing/unknown status renders a sensible "error" placeholder so the message
 * is always well-formed.
 */
export function createFailureMessage(
  status: string | number | undefined,
): string {
  const shown =
    status === undefined || status === null || status === "" ? "error" : status;
  return `⚠️ No se pudo crear la tarea en ClickUp (${shown}). Inténtalo de nuevo.`;
}

/** The minimal Slack surface both client shapes share. */
type ThreadPoster = {
  chat: {
    postMessage(args: {
      channel: string;
      thread_ts?: string;
      text: string;
    }): Promise<unknown>;
  };
};

/**
 * Post a single best-effort error message into the given thread. Mirrors the
 * existing `postThreadNotice` pattern: try → log on failure → never rethrow, so
 * it is safe to call from any catch on the ACK/waitUntil path (HARD-01).
 */
export async function reportErrorToThread(
  client: ThreadPoster,
  channel: string,
  threadTs: string,
  message: string,
): Promise<void> {
  try {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: message,
    });
  } catch (err) {
    console.error(
      "[slack] reportErrorToThread failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
