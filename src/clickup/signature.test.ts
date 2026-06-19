import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyClickUpSignature,
  getClickUpSignatureHeader,
} from "./signature.js";

const SECRET = "whsec_test_signing_secret";

/** Compute the expected X-Signature exactly as the verifier must (proves logic offline). */
function sign(rawBody: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

describe("verifyClickUpSignature", () => {
  it("accepts a signature that equals HMAC-SHA256(rawBody, secret) (lowercase hex)", () => {
    const raw = JSON.stringify({ event: "taskStatusUpdated", task_id: "abc" });
    expect(verifyClickUpSignature(raw, sign(raw), SECRET)).toBe(true);
  });

  it("rejects a tampered body (signature no longer matches)", () => {
    const raw = JSON.stringify({ event: "taskStatusUpdated", task_id: "abc" });
    const sig = sign(raw);
    const tampered = JSON.stringify({ event: "taskStatusUpdated", task_id: "EVIL" });
    expect(verifyClickUpSignature(tampered, sig, SECRET)).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const raw = JSON.stringify({ event: "x" });
    expect(verifyClickUpSignature(raw, sign(raw, "other-secret"), SECRET)).toBe(false);
  });

  it("rejects an empty / missing signature without throwing", () => {
    const raw = JSON.stringify({ event: "x" });
    expect(verifyClickUpSignature(raw, "", SECRET)).toBe(false);
  });

  it("rejects a wrong-length signature without throwing (length guard)", () => {
    const raw = JSON.stringify({ event: "x" });
    expect(verifyClickUpSignature(raw, "deadbeef", SECRET)).toBe(false);
  });

  it("rejects a non-hex signature of the right length without throwing", () => {
    const raw = JSON.stringify({ event: "x" });
    const garbage = "z".repeat(64);
    expect(verifyClickUpSignature(raw, garbage, SECRET)).toBe(false);
  });

  it("tolerates an optional 'sha256=' prefix on the incoming signature", () => {
    const raw = JSON.stringify({ event: "taskAssigneeUpdated", task_id: "t1" });
    expect(verifyClickUpSignature(raw, `sha256=${sign(raw)}`, SECRET)).toBe(true);
  });

  it("is case-insensitive on the incoming hex (uppercase still verifies)", () => {
    const raw = JSON.stringify({ event: "x" });
    expect(verifyClickUpSignature(raw, sign(raw).toUpperCase(), SECRET)).toBe(true);
  });

  it("never throws on undefined-ish inputs", () => {
    expect(() =>
      verifyClickUpSignature("", undefined as unknown as string, SECRET),
    ).not.toThrow();
    expect(verifyClickUpSignature("", undefined as unknown as string, SECRET)).toBe(false);
  });
});

describe("getClickUpSignatureHeader", () => {
  it("finds the value from a Headers object regardless of casing", () => {
    const h = new Headers();
    h.set("X-Signature", "sig-value");
    expect(getClickUpSignatureHeader(h)).toBe("sig-value");
  });

  it("finds the value from a plain record with exact 'X-Signature'", () => {
    expect(getClickUpSignatureHeader({ "X-Signature": "v1" })).toBe("v1");
  });

  it("finds the value from a plain record with lowercase 'x-signature'", () => {
    expect(getClickUpSignatureHeader({ "x-signature": "v2" })).toBe("v2");
  });

  it("finds the value from a plain record with uppercase 'X-SIGNATURE'", () => {
    expect(getClickUpSignatureHeader({ "X-SIGNATURE": "v3" })).toBe("v3");
  });

  it("returns null when the header is absent", () => {
    expect(getClickUpSignatureHeader({ "content-type": "application/json" })).toBeNull();
    expect(getClickUpSignatureHeader(new Headers())).toBeNull();
  });

  it("returns null for an undefined value in a record", () => {
    expect(getClickUpSignatureHeader({ "x-signature": undefined })).toBeNull();
  });
});
