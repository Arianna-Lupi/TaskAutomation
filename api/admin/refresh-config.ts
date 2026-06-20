import { loadEnv } from "../../src/config/env.js";
import { createRedis } from "../../src/store/redis.js";
import { evaluateOpsAuth } from "../../src/ops/auth.js";

/**
 * Manual dynamic-config cache refresh (DYN-06), Phase 8 hardened.
 *
 *   POST /api/admin/refresh-config
 *     Authorization: Bearer <OPS_API_TOKEN>
 *     → deletes the hot cfg:* TTL cache keys (cfg:clientes, cfg:members,
 *       cfg:slackmap:*) so the next parse re-fetches live config from ClickUp.
 *       The cfg:*:lastgood keys are LEFT intact (the DYN-05 safety net).
 *
 * Gating (FIND-01/02/03):
 *   - Fail-closed: when OPS_API_TOKEN is unset the endpoint returns 404.
 *   - When set it requires `Authorization: Bearer <OPS_API_TOKEN>` (timing-safe).
 *   - State change requires POST; a GET returns 405.
 *   - The response is a count, not the cleared key names (reduced disclosure).
 *   - The token/secret is never logged or returned.
 */
const env = loadEnv();

async function clearHotConfigCache(): Promise<number> {
  const redis = createRedis(env);
  // List every dynamic-config key, then keep only the hot TTL keys (drop the
  // :lastgood safety-net copies). Guard the empty-list case so del() isn't
  // called with no args.
  const allKeys = (await redis.keys("cfg:*")) as string[];
  const toClear = allKeys.filter((k) => !k.endsWith(":lastgood"));
  if (toClear.length > 0) {
    await redis.del(...toClear);
  }
  return toClear.length;
}

export const POST = async (req: Request): Promise<Response> => {
  const gate = evaluateOpsAuth(env.OPS_API_TOKEN, req.headers.get("authorization"));
  if (gate === "disabled") return new Response("not found", { status: 404 });
  if (gate === "unauthorized") return new Response("unauthorized", { status: 401 });

  const clearedCount = await clearHotConfigCache();

  return new Response(JSON.stringify({ clearedCount }, null, 2), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

/** State change requires POST (FIND-02). A GET is method-not-allowed. */
export const GET = async (req: Request): Promise<Response> => {
  // Gate FIRST (WR-01), matching diag.ts order: an unauthenticated caller must
  // not learn the endpoint exists. Only an authenticated caller using the wrong
  // method gets a 405.
  const gate = evaluateOpsAuth(env.OPS_API_TOKEN, req.headers.get("authorization"));
  if (gate === "disabled") return new Response("not found", { status: 404 });
  if (gate === "unauthorized") return new Response("unauthorized", { status: 401 });
  return new Response(JSON.stringify({ allow: "POST" }, null, 2), {
    status: 405,
    headers: { "content-type": "application/json", allow: "POST" },
  });
};
