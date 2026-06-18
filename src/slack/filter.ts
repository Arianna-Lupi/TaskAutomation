/**
 * Shape of the subset of a Slack message event we inspect to decide whether it
 * is a task-worthy human message. All fields optional — real events vary.
 */
export type IncomingMessage = {
  channel?: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  ts?: string;
  thread_ts?: string;
};

/**
 * Pure predicate — no I/O. Returns true only for a root, plain, human message
 * posted in the designated task channel. This is the echo-loop / noise guard
 * (Pitfall 3 + INGEST-04):
 *
 *  - channel must equal the designated task channel
 *  - subtype must be undefined (plain user message, not edits/bot messages)
 *  - bot_id must be absent (ignore other bots)
 *  - user must not be the bot's own user id (ignore our own posts)
 *  - message must be root: thread_ts absent OR thread_ts === ts
 */
export function isProcessableMessage(
  msg: IncomingMessage,
  opts: { taskChannelId: string; botUserId?: string },
): boolean {
  if (!msg.channel || msg.channel !== opts.taskChannelId) return false;
  if (msg.subtype !== undefined) return false;
  if (msg.bot_id !== undefined) return false;
  if (opts.botUserId !== undefined && msg.user === opts.botUserId) return false;
  if (msg.thread_ts !== undefined && msg.thread_ts !== msg.ts) return false;
  return true;
}
