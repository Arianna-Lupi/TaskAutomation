import { CLIENTS, CLIENT_ALIASES, type ClientName } from "../config/clients.js";

/**
 * Map a raw cliente string (the LLM's `clienteRaw`) to a ClickUp dropdown option
 * UUID — or null when there is no confident match. Pure: never invents an id
 * (Pitfall 4). Matching is case-insensitive and trimmed, against canonical
 * CLIENTS names first, then the CLIENT_ALIASES table.
 */
export function resolveCliente(raw: string | null): string | null {
  if (!raw) return null;
  const norm = raw.trim().toLowerCase();
  if (norm.length === 0) return null;

  // Exact canonical-name match (case-insensitive).
  for (const name of Object.keys(CLIENTS) as ClientName[]) {
    if (name.toLowerCase() === norm) return CLIENTS[name];
  }

  // Alias match.
  const aliased = (CLIENT_ALIASES as Record<string, ClientName>)[norm];
  if (aliased) return CLIENTS[aliased];

  return null;
}
