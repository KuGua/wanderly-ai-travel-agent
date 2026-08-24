import { describe, expect, it } from "vitest";
import {
  verifySandboxSignature,
  __buildSandboxSignature,
} from "../src/middleware/sandbox-signature.js";

const SECRET = "unit-test-secret";

describe("sandbox signature verification", () => {
  it("accepts a valid signature within the time window", () => {
    const ts = Date.now();
    const body = '{"eventId":"abc"}';
    const sig = __buildSandboxSignature(SECRET, ts, body);
    const result = verifySandboxSignature(
      { "x-sandbox-signature": sig, "x-sandbox-timestamp": String(ts) },
      body,
      SECRET,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an expired timestamp", () => {
    const ts = Date.now() - 10 * 60_000;
    const body = '{"x":1}';
    const sig = __buildSandboxSignature(SECRET, ts, body);
    const result = verifySandboxSignature(
      { "x-sandbox-signature": sig, "x-sandbox-timestamp": String(ts) },
      body,
      SECRET,
    );
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects wrong signature", () => {
    const ts = Date.now();
    const result = verifySandboxSignature(
      { "x-sandbox-signature": "deadbeef", "x-sandbox-timestamp": String(ts) },
      "body",
      SECRET,
    );
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects missing headers", () => {
    const result = verifySandboxSignature({}, "body", SECRET);
    expect(result).toEqual({ ok: false, reason: "missing_header" });
  });
});