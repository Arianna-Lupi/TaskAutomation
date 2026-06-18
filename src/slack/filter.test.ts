import { describe, it, expect } from "vitest";
import { isProcessableMessage, type IncomingMessage } from "./filter.js";

const CH = "C_TASK";
const BOT = "U_BOT";
const opts = { taskChannelId: CH, botUserId: BOT };

const base: IncomingMessage = {
  channel: CH,
  user: "U_HUMAN",
  ts: "1700000000.000100",
};

describe("isProcessableMessage", () => {
  it("accepts a root human message in the designated channel", () => {
    expect(isProcessableMessage(base, opts)).toBe(true);
  });

  it("accepts when thread_ts equals ts (root message)", () => {
    expect(isProcessableMessage({ ...base, thread_ts: base.ts }, opts)).toBe(true);
  });

  it("rejects messages from a different channel", () => {
    expect(isProcessableMessage({ ...base, channel: "C_OTHER" }, opts)).toBe(false);
  });

  it("rejects messages with a bot_id (other bots)", () => {
    expect(isProcessableMessage({ ...base, bot_id: "B123" }, opts)).toBe(false);
  });

  it("rejects the bot's own messages (echo loop)", () => {
    expect(isProcessableMessage({ ...base, user: BOT }, opts)).toBe(false);
  });

  it("rejects messages with a subtype (e.g. message_changed, bot_message)", () => {
    expect(isProcessableMessage({ ...base, subtype: "message_changed" }, opts)).toBe(false);
    expect(isProcessableMessage({ ...base, subtype: "bot_message" }, opts)).toBe(false);
  });

  it("rejects thread replies (thread_ts present and != ts)", () => {
    expect(
      isProcessableMessage({ ...base, thread_ts: "1699999999.000001" }, opts),
    ).toBe(false);
  });

  it("rejects when channel is missing", () => {
    expect(isProcessableMessage({ ...base, channel: undefined }, opts)).toBe(false);
  });

  it("works when botUserId is not provided (still applies other filters)", () => {
    expect(isProcessableMessage(base, { taskChannelId: CH })).toBe(true);
    expect(
      isProcessableMessage({ ...base, bot_id: "B1" }, { taskChannelId: CH }),
    ).toBe(false);
  });
});
