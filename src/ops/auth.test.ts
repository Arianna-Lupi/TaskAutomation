import { describe, it, expect } from "vitest";
import { evaluateOpsAuth } from "./auth.js";

describe("evaluateOpsAuth", () => {
  it("is disabled when the ops token is undefined", () => {
    expect(evaluateOpsAuth(undefined, "Bearer anything")).toBe("disabled");
  });

  it("is disabled when the ops token is an empty string", () => {
    expect(evaluateOpsAuth("", "Bearer anything")).toBe("disabled");
  });

  it("is disabled when the ops token is whitespace only", () => {
    expect(evaluateOpsAuth("   ", "Bearer anything")).toBe("disabled");
  });

  it("is unauthorized when no Authorization header is present", () => {
    expect(evaluateOpsAuth("tok", null)).toBe("unauthorized");
  });

  it("is unauthorized when the Bearer token is wrong", () => {
    expect(evaluateOpsAuth("tok", "Bearer wrong")).toBe("unauthorized");
  });

  it("is unauthorized when the token is sent without the Bearer scheme", () => {
    expect(evaluateOpsAuth("tok", "tok")).toBe("unauthorized");
  });

  it("is ok when the Bearer token matches exactly", () => {
    expect(evaluateOpsAuth("tok", "Bearer tok")).toBe("ok");
  });

  it("accepts a case-insensitive Bearer scheme", () => {
    expect(evaluateOpsAuth("tok", "bearer tok")).toBe("ok");
  });

  it("does not throw on mismatched lengths (timing-safe length guard)", () => {
    expect(() => evaluateOpsAuth("short", "Bearer muchlongertoken")).not.toThrow();
    expect(evaluateOpsAuth("short", "Bearer muchlongertoken")).toBe("unauthorized");
  });

  it("does not throw on a malformed header", () => {
    expect(() => evaluateOpsAuth("tok", "Bearer")).not.toThrow();
    expect(evaluateOpsAuth("tok", "Bearer")).toBe("unauthorized");
  });
});
