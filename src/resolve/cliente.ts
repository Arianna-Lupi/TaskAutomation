import { staticClientesConfig, type ClientesConfig } from "../config/provider.js";

/**
 * Map a raw cliente string (the LLM's `clienteRaw`) to a ClickUp dropdown option
 * UUID — or null when there is no confident match. Pure/sync: never invents an
 * id (Pitfall 4). Matching is case-insensitive and trimmed, against the config's
 * canonical names first, then its alias overlay.
 *
 * `config` is injected (the live provider data from plan 02). When absent it
 * defaults to the static maps via staticClientesConfig(), so existing callers
 * and tests see identical behavior to v1.0.
 */
export function resolveCliente(
  raw: string | null,
  config: ClientesConfig = staticClientesConfig(),
): string | null {
  if (!raw) return null;
  const norm = raw.trim().toLowerCase();
  if (norm.length === 0) return null;

  // Canonical-name match (config.byName is keyed by lowercased name). Guard with
  // Object.hasOwn so inherited Object.prototype keys (e.g. "constructor",
  // "toString") can never resolve to a prototype member (Pitfall 4).
  if (Object.hasOwn(config.byName, norm)) {
    const id = config.byName[norm];
    if (id != null) return id;
  }

  // Alias overlay — same own-key guard. Always returns null (not undefined) on
  // no match, honoring the `string | null` contract.
  if (Object.hasOwn(config.aliases, norm)) {
    const id = config.aliases[norm];
    if (id != null) return id;
  }

  return null;
}
