#!/usr/bin/env node
/**
 * Per-channel kill switch (Phase 5, HARD-03) — disable/enable the bot for a
 * channel with NO redeploy.
 *
 * The bot checks `killswitch:<channelId>` (and the global `killswitch:all`) at
 * the very top of its capture path. A present key disables the bot for that
 * channel; an absent key is the default (enabled). This script flips that key
 * via the Upstash REST API so an operator can stop a misbehaving bot instantly.
 *
 * Dependency-free: uses only global `fetch` against the Upstash REST endpoint
 * (no @upstash/redis import needed — the REST API is a plain HTTP GET/POST).
 *
 * Usage:
 *   node scripts/killswitch.mjs <channelId> on|off
 *   node scripts/killswitch.mjs C0123ABC on     # disable the bot in C0123ABC
 *   node scripts/killswitch.mjs C0123ABC off    # re-enable it
 *   node scripts/killswitch.mjs all on          # disable EVERY channel (global)
 *   node scripts/killswitch.mjs all off         # clear the global override
 *
 * Env (same vars the app uses):
 *   UPSTASH_REDIS_REST_URL    (required)
 *   UPSTASH_REDIS_REST_TOKEN  (required)
 */

function usage(msg) {
  if (msg) console.error(`ERROR: ${msg}`);
  console.error("Usage: node scripts/killswitch.mjs <channelId> on|off");
  console.error("  <channelId>  Slack channel id, or `all` for the global switch");
  console.error("  on           disable the bot for that channel (SET killswitch:<id>)");
  console.error("  off          re-enable the bot (DEL killswitch:<id>)");
  console.error("");
  console.error("Examples:");
  console.error("  node scripts/killswitch.mjs C0123ABC on");
  console.error("  node scripts/killswitch.mjs C0123ABC off");
  console.error("  node scripts/killswitch.mjs all on");
}

async function main() {
  const channelId = process.argv[2];
  const action = process.argv[3];

  if (!channelId || !action) {
    usage("both <channelId> and on|off are required.");
    process.exit(2);
  }
  if (action !== "on" && action !== "off") {
    usage(`action must be "on" or "off" (got "${action}").`);
    process.exit(2);
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    const missing = [
      !url ? "UPSTASH_REDIS_REST_URL" : null,
      !token ? "UPSTASH_REDIS_REST_TOKEN" : null,
    ]
      .filter(Boolean)
      .join(", ");
    console.error(`ERROR: missing env: ${missing}`);
    process.exit(2);
  }

  const key = `killswitch:${channelId}`;
  // Upstash REST path-style command: /SET/<key>/<value> or /DEL/<key>.
  const command =
    action === "on"
      ? ["SET", key, "1"]
      : ["DEL", key];
  const endpoint = `${url.replace(/\/$/, "")}/${command.map(encodeURIComponent).join("/")}`;

  let res;
  try {
    res = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    console.error(`ERROR: request to Upstash failed — ${err?.message ?? err}`);
    process.exit(1);
  }

  const text = await res.text();
  if (!res.ok) {
    console.error(`ERROR: Upstash responded ${res.status}: ${text}`);
    process.exit(1);
  }

  if (action === "on") {
    console.log(`✅ Kill switch ON — bot DISABLED for "${channelId}" (key ${key} set).`);
    console.log("   Captured messages in this channel are now a no-op (no parse, no preview).");
  } else {
    console.log(`✅ Kill switch OFF — bot ENABLED for "${channelId}" (key ${key} cleared).`);
  }
  console.log(`   Upstash response: ${text}`);
}

main();
