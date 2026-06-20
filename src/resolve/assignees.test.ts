import { describe, it, expect } from "vitest";
import { resolveAssignees } from "./assignees.js";

const VERO = 118065209;
const MIGUEL = 216158839;

describe("resolveAssignees (PARSE-03)", () => {
  it("matches member names case-insensitively", () => {
    expect(resolveAssignees(["Veronica Romero"])).toEqual({
      ids: [VERO],
      unresolved: [],
    });
    expect(resolveAssignees(["veronica romero"])).toEqual({
      ids: [VERO],
      unresolved: [],
    });
  });

  it("matches via the alias table", () => {
    expect(resolveAssignees(["vero"])).toEqual({ ids: [VERO], unresolved: [] });
  });

  it("resolves a Slack user id via the injected SLACK_TO_MEMBER override", () => {
    const slackToMember = { U123ABC: MIGUEL };
    expect(resolveAssignees(["U123ABC"], { slackToMember })).toEqual({
      ids: [MIGUEL],
      unresolved: [],
    });
  });

  it("drops unmatched names and surfaces them in unresolved", () => {
    expect(resolveAssignees(["Veronica Romero", "Pepe"])).toEqual({
      ids: [VERO],
      unresolved: ["Pepe"],
    });
  });

  it("dedups a member referenced twice (by name and alias)", () => {
    expect(resolveAssignees(["Veronica Romero", "vero"])).toEqual({
      ids: [VERO],
      unresolved: [],
    });
  });

  it("returns empty results for an empty input list", () => {
    expect(resolveAssignees([])).toEqual({ ids: [], unresolved: [] });
  });

  it("never resolves Object.prototype keys (prototype-pollution guard)", () => {
    // "constructor"/"toString"/etc. are inherited prototype members, NOT real
    // members — they must invent NO ids and surface as unresolved (Pitfall 4).
    const tokens = ["constructor", "toString", "valueOf", "hasOwnProperty"];
    const result = resolveAssignees(tokens);
    expect(result.ids).toEqual([]);
    expect(result.unresolved).toEqual(tokens);
  });

  it("does not let a prototype key in the Slack override map invent an id", () => {
    // A user-supplied token that collides with an Object.prototype key must
    // not resolve via the injected slackToMember map either.
    const slackToMember = { U123ABC: MIGUEL };
    expect(resolveAssignees(["constructor"], { slackToMember })).toEqual({
      ids: [],
      unresolved: ["constructor"],
    });
  });

  it("resolves a Slack mention <@U123> and a bare U123 via the slackToMember map", () => {
    const slackToMember = { U123ABC: MIGUEL };
    expect(resolveAssignees(["<@U123ABC>"], { slackToMember })).toEqual({
      ids: [MIGUEL],
      unresolved: [],
    });
    expect(resolveAssignees(["<@U123ABC|miguel>"], { slackToMember })).toEqual({
      ids: [MIGUEL],
      unresolved: [],
    });
    expect(resolveAssignees(["U123ABC"], { slackToMember })).toEqual({
      ids: [MIGUEL],
      unresolved: [],
    });
  });
});

describe("resolveAssignees — injected config (DYN-03)", () => {
  it("resolves a NEW member name present only in the injected config", () => {
    const config = { byName: { "nuevo miembro": 999 }, aliases: {}, byEmail: {} };
    expect(resolveAssignees(["Nuevo Miembro"], { config })).toEqual({
      ids: [999],
      unresolved: [],
    });
  });

  it("resolves a config alias to the live member id", () => {
    const config = { byName: { "veronica romero": 111 }, aliases: { vero: 111 }, byEmail: {} };
    expect(resolveAssignees(["vero"], { config })).toEqual({
      ids: [111],
      unresolved: [],
    });
  });

  it("keeps the Slack override tier first even with an injected config", () => {
    const config = { byName: { "nuevo miembro": 999 }, aliases: {}, byEmail: {} };
    const slackToMember = { U123ABC: MIGUEL };
    expect(resolveAssignees(["U123ABC", "Nuevo Miembro"], { slackToMember, config })).toEqual({
      ids: [MIGUEL, 999],
      unresolved: [],
    });
  });

  it("still guards prototype keys with an injected config", () => {
    const config = { byName: {}, aliases: {}, byEmail: {} };
    expect(resolveAssignees(["constructor", "toString"], { config })).toEqual({
      ids: [],
      unresolved: ["constructor", "toString"],
    });
  });
});
