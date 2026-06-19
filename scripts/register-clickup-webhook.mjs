#!/usr/bin/env node
/**
 * One-time ClickUp reverse-webhook registration (Phase 4, Flow B).
 *
 * Registers a webhook so ClickUp will POST taskStatusUpdated + taskAssigneeUpdated
 * events to the deployed /api/clickup/webhook endpoint, and prints the returned
 * signing secret — which you must store as CLICKUP_WEBHOOK_SECRET in Vercel so the
 * 04-01 verifier can authenticate each delivery.
 *
 * Run ONCE by a human after deploy (live-deferred — needs the public URL + token).
 * Dependency-free: uses only global fetch.
 *
 * Usage:
 *   CLICKUP_API_TOKEN=pk_xxx node scripts/register-clickup-webhook.mjs https://<deploy>/api/clickup/webhook
 *   # or:
 *   CLICKUP_API_TOKEN=pk_xxx ENDPOINT_URL=https://<deploy>/api/clickup/webhook node scripts/register-clickup-webhook.mjs
 *
 * Env:
 *   CLICKUP_API_TOKEN  (required)  ClickUp personal/OAuth token (raw, NOT "Bearer ").
 *   CLICKUP_TEAM_ID    (optional)  Workspace/team id; defaults to 90131720021 (Task-Seo).
 *   ENDPOINT_URL       (optional)  The webhook endpoint; can also be argv[2].
 */

const EVENTS = ["taskStatusUpdated", "taskAssigneeUpdated"];

async function main() {
  const token = process.env.CLICKUP_API_TOKEN;
  const teamId = process.env.CLICKUP_TEAM_ID || "90131720021";
  const endpoint = process.argv[2] || process.env.ENDPOINT_URL;

  if (!token) {
    console.error("ERROR: CLICKUP_API_TOKEN is required.");
    process.exit(2);
  }
  if (!endpoint) {
    console.error(
      "ERROR: endpoint URL is required (pass as the first argument or set ENDPOINT_URL).",
    );
    console.error(
      "Example: node scripts/register-clickup-webhook.mjs https://<deploy>/api/clickup/webhook",
    );
    process.exit(2);
  }

  const url = `https://api.clickup.com/api/v2/team/${teamId}/webhook`;
  const body = { endpoint, events: EVENTS };

  console.error(`Registering webhook for team ${teamId} → ${endpoint}`);
  console.error(`Events: ${EVENTS.join(", ")}`);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: token, // raw token — ClickUp tokens are NOT Bearer-prefixed
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`ERROR: request failed — ${err?.message ?? err}`);
    process.exit(1);
  }

  const text = await res.text();
  if (!res.ok) {
    // Surface status + body for diagnosis; never echo the token.
    console.error(`ERROR: ClickUp responded ${res.status}: ${text}`);
    process.exit(1);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error(`ERROR: could not parse ClickUp response: ${text}`);
    process.exit(1);
  }

  const webhook = json.webhook ?? json;
  console.log("✅ Webhook registered.");
  console.log(`   id:     ${webhook.id ?? "(unknown)"}`);
  console.log(`   secret: ${webhook.secret ?? "(not returned)"}`);
  console.log("");
  console.log(
    "Store the secret as CLICKUP_WEBHOOK_SECRET in Vercel (Project → Settings →",
  );
  console.log(
    "Environment Variables), then redeploy so the X-Signature verifier can use it.",
  );
}

main();
