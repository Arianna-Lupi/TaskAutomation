import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createConfigProvider,
  buildClientesConfig,
  buildMembersConfig,
  staticClientesConfig,
  staticMembersConfig,
} from "./provider.js";
import { CLIENTS } from "./clients.js";
import { MEMBERS } from "./members.js";
import type { RedisLike } from "../store/redis.js";
import type { ClienteOption, ClickUpMember } from "../clickup/types.js";

const FELIPE = CLIENTS["Felipe Vergara"];
const INTERNO = CLIENTS.Interno;

/** Map-backed RedisLike mirroring the production helpers' string storage. */
function memRedis(): RedisLike {
  const store = new Map<string, unknown>();
  return {
    async set(key, value, opts) {
      if (opts?.nx && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async getdel(key) {
      if (!store.has(key)) return null;
      const v = store.get(key);
      store.delete(key);
      return v;
    },
    async del(...keys) {
      let removed = 0;
      for (const k of keys) if (store.delete(k)) removed += 1;
      return removed;
    },
  };
}

const liveOptions: ClienteOption[] = [
  { id: "live-felipe", name: "Felipe Vergara" },
  { id: "live-interno", name: "Interno" },
  { id: "live-newclient", name: "Nuevo Cliente SA" },
];

const liveMembers: ClickUpMember[] = [
  { id: 111, name: "Veronica Romero", email: "vero@arianna.com" },
  { id: 222, name: "Nuevo Miembro", email: "Nuevo@Arianna.com" },
  { id: 333, name: "Sin Email", email: null },
];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildClientesConfig (alias overlay)", () => {
  it("builds byName lowercased and merges curated aliases on top of live names", () => {
    const cfg = buildClientesConfig(liveOptions);
    expect(cfg.byName["felipe vergara"]).toBe("live-felipe");
    expect(cfg.byName["nuevo cliente sa"]).toBe("live-newclient");
    // curated alias resolves to the LIVE uuid for that name
    expect(cfg.aliases["feli"]).toBe("live-felipe");
    // aprendoseo → Interno, resolved to the live Interno uuid
    expect(cfg.aliases["aprendoseo"]).toBe("live-interno");
  });

  it("keeps the static uuid for an alias whose canonical name isn't live", () => {
    // No "Children Chic" in liveOptions → its aliases keep the static uuid.
    const cfg = buildClientesConfig(liveOptions);
    expect(cfg.aliases["children"]).toBe(CLIENTS["Children Chic"]);
  });
});

describe("buildMembersConfig", () => {
  it("populates byEmail (lowercased) from live members and merges aliases", () => {
    const cfg = buildMembersConfig(liveMembers);
    expect(cfg.byName["veronica romero"]).toBe(111);
    expect(cfg.byEmail["vero@arianna.com"]).toBe(111);
    expect(cfg.byEmail["nuevo@arianna.com"]).toBe(222); // lowercased
    expect(cfg.aliases["vero"]).toBe(111); // live id
  });

  it("skips a null email and never throws", () => {
    const cfg = buildMembersConfig(liveMembers);
    expect(Object.values(cfg.byEmail)).not.toContain(333);
  });
});

describe("staticClientesConfig / staticMembersConfig", () => {
  it("clientes static fallback resolves canonical names + curated aliases to static uuids", () => {
    const cfg = staticClientesConfig();
    expect(cfg.byName["felipe vergara"]).toBe(FELIPE);
    expect(cfg.aliases["feli"]).toBe(FELIPE);
    expect(cfg.aliases["aprendoseo"]).toBe(INTERNO);
  });

  it("members static fallback has byEmail empty", () => {
    const cfg = staticMembersConfig();
    expect(cfg.byEmail).toEqual({});
    expect(cfg.byName["veronica romero"]).toBe(MEMBERS["Veronica Romero"]);
  });
});

describe("createConfigProvider.getClientes — 3-tier resolution", () => {
  it("cache HIT returns cached config WITHOUT a ClickUp fetch", async () => {
    const redis = memRedis();
    const cached = { byName: { foo: "uuid-foo" }, aliases: {} };
    await redis.set("cfg:clientes", JSON.stringify(cached));
    const getClienteOptions = vi.fn();
    const provider = createConfigProvider({
      clickup: { getClienteOptions, getMembers: vi.fn() },
      redis,
    });
    expect(await provider.getClientes()).toEqual(cached);
    expect(getClienteOptions).not.toHaveBeenCalled();
  });

  it("cache MISS fetches live, populates cache+last-good, returns live config", async () => {
    const redis = memRedis();
    const getClienteOptions = vi.fn(async () => liveOptions);
    const provider = createConfigProvider({
      clickup: { getClienteOptions, getMembers: vi.fn() },
      redis,
    });
    const cfg = await provider.getClientes();
    expect(getClienteOptions).toHaveBeenCalledTimes(1);
    expect(cfg.byName["nuevo cliente sa"]).toBe("live-newclient");
    // cache + last-good populated
    expect(await redis.get("cfg:clientes")).toBeTruthy();
    expect(await redis.get("cfg:clientes:lastgood")).toBeTruthy();
  });

  it("fetch FAILURE with last-good present serves last-good (no throw)", async () => {
    const redis = memRedis();
    const lastGood = { byName: { lg: "uuid-lg" }, aliases: {} };
    await redis.set("cfg:clientes:lastgood", JSON.stringify(lastGood));
    const provider = createConfigProvider({
      clickup: {
        getClienteOptions: vi.fn(async () => {
          throw new Error("ClickUp down");
        }),
        getMembers: vi.fn(),
      },
      redis,
    });
    expect(await provider.getClientes()).toEqual(lastGood);
  });

  it("fetch FAILURE with NO last-good falls back to STATIC maps (no throw)", async () => {
    const redis = memRedis();
    const provider = createConfigProvider({
      clickup: {
        getClienteOptions: vi.fn(async () => {
          throw new Error("ClickUp down");
        }),
        getMembers: vi.fn(),
      },
      redis,
    });
    const cfg = await provider.getClientes();
    expect(cfg.byName["felipe vergara"]).toBe(FELIPE);
    expect(cfg.aliases["feli"]).toBe(FELIPE);
  });

  it("Redis read throwing degrades to a live fetch, never throws", async () => {
    const redis: RedisLike = {
      get: vi.fn(async () => {
        throw new Error("redis exploded");
      }),
      set: vi.fn(async () => "OK"),
      getdel: vi.fn(),
      del: vi.fn(),
    };
    const provider = createConfigProvider({
      clickup: { getClienteOptions: vi.fn(async () => liveOptions), getMembers: vi.fn() },
      redis,
    });
    const cfg = await provider.getClientes();
    expect(cfg.byName["nuevo cliente sa"]).toBe("live-newclient");
  });

  it("curated aliases (feli/aprendoseo) still resolve after a live fetch", async () => {
    const redis = memRedis();
    const provider = createConfigProvider({
      clickup: { getClienteOptions: vi.fn(async () => liveOptions), getMembers: vi.fn() },
      redis,
    });
    const cfg = await provider.getClientes();
    expect(cfg.aliases["feli"]).toBe("live-felipe");
    expect(cfg.aliases["aprendoseo"]).toBe("live-interno");
  });
});

describe("createConfigProvider.getMembers — 3-tier resolution", () => {
  it("cache MISS fetches live and populates byEmail", async () => {
    const redis = memRedis();
    const getMembers = vi.fn(async () => liveMembers);
    const provider = createConfigProvider({
      clickup: { getClienteOptions: vi.fn(), getMembers },
      redis,
    });
    const cfg = await provider.getMembers();
    expect(getMembers).toHaveBeenCalledTimes(1);
    expect(cfg.byEmail["vero@arianna.com"]).toBe(111);
  });

  it("fetch FAILURE → static maps with byEmail empty", async () => {
    const redis = memRedis();
    const provider = createConfigProvider({
      clickup: {
        getClienteOptions: vi.fn(),
        getMembers: vi.fn(async () => {
          throw new Error("down");
        }),
      },
      redis,
    });
    const cfg = await provider.getMembers();
    expect(cfg.byEmail).toEqual({});
    expect(cfg.byName["veronica romero"]).toBe(MEMBERS["Veronica Romero"]);
  });
});
