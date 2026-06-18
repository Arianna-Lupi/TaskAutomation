import { createHandler } from "@vercel/slack-bolt";
import { loadEnv } from "../../src/config/env.js";
import { createSlackApp } from "../../src/slack/app.js";

// Construct the app once per (warm) instance. loadEnv fails fast if the
// environment is misconfigured. The adapter handles Slack signature
// verification over the raw body and the ACK<3s → background waitUntil pattern.
const { app, receiver } = createSlackApp(loadEnv());
const handler = createHandler(app, receiver);

export const POST = (req: Request): Promise<Response> => handler(req);

export default handler;
