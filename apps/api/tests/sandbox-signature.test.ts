import { describe, expect, it } from "vitest";
import {
  verifySandboxSignature,
  __buildSandboxSignature,
} from "../src/middleware/sandbox-signature.js";

const SECRET = "unit-test-secret";
const NOW = 1_800_000_000_000;
const WINDOW_MS = 5 * 60_000;

describe("sandbox signature verification", () => {
  it("accepts a valid signature within the time window", () => {
    const ts = NOW;
    const body = '{"eventId":"abc"}';
    const sig = __buildSandboxSignature(SECRET, ts, body);
    const result = verifySandboxSignature(
      { "x-sandbox-signature": sig, "x-sandbox-timestamp": String(ts) },
      body,
      SECRET,
      { now: () => NOW },
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an expired timestamp", () => {
    const ts = NOW - 10 * 60_000;
    const body = '{"x":1}';
    const sig = __buildSandboxSignature(SECRET, ts, body);
    const result = verifySandboxSignature(
      { "x-sandbox-signature": sig, "x-sandbox-timestamp": String(ts) },
      body,
      SECRET,
      { now: () => NOW },
    );
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects wrong signature", () => {
    const ts = NOW;
    const result = verifySandboxSignature(
      { "x-sandbox-signature": "deadbeef", "x-sandbox-timestamp": String(ts) },
      "body",
      SECRET,
      { now: () => NOW },
    );
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects missing headers", () => {
    const result = verifySandboxSignature({}, "body", SECRET);
    expect(result).toEqual({ ok: false, reason: "missing_header" });
  });

  it("rejects a signature after the signed body is tampered with", () => {
    const original = '{"eventId":"expected"}';
    const signature = __buildSandboxSignature(SECRET, NOW, original);
    expect(verifySandboxSignature(
      { "x-sandbox-signature": signature, "x-sandbox-timestamp": String(NOW) },
      '{"eventId":"tampered"}',
      SECRET,
      { now: () => NOW },
    )).toEqual({ ok: false, reason: "bad_signature" });
  });

  it.each(["not-a-time", "1e12", "-1", "1.5", "9007199254740992"])(
    "rejects malformed timestamp %s",
    timestamp => {
      expect(verifySandboxSignature(
        { "x-sandbox-signature": "a".repeat(64), "x-sandbox-timestamp": timestamp },
        "body",
        SECRET,
        { now: () => NOW },
      )).toEqual({ ok: false, reason: "malformed_timestamp" });
    },
  );

  it("accepts the exact timestamp-window boundary and rejects one millisecond beyond it", () => {
    const boundary = NOW - WINDOW_MS;
    const body = '{"eventId":"boundary"}';
    const boundarySignature = __buildSandboxSignature(SECRET, boundary, body);
    expect(verifySandboxSignature(
      { "x-sandbox-signature": boundarySignature, "x-sandbox-timestamp": String(boundary) },
      body,
      SECRET,
      { now: () => NOW, windowMs: WINDOW_MS },
    )).toEqual({ ok: true });

    const expired = boundary - 1;
    const expiredSignature = __buildSandboxSignature(SECRET, expired, body);
    expect(verifySandboxSignature(
      { "x-sandbox-signature": expiredSignature, "x-sandbox-timestamp": String(expired) },
      body,
      SECRET,
      { now: () => NOW, windowMs: WINDOW_MS },
    )).toEqual({ ok: false, reason: "expired" });
  });

  it("fails closed when the callback secret is not configured", () => {
    const signature = __buildSandboxSignature(SECRET, NOW, "body");
    expect(verifySandboxSignature(
      { "x-sandbox-signature": signature, "x-sandbox-timestamp": String(NOW) },
      "body",
      undefined,
      { now: () => NOW },
    )).toEqual({ ok: false, reason: "configuration_error" });
  });
});
