import { describe, expect, it } from "vitest";
import { whitelistSummary } from "../src/services/audit-service.js";
import { redact } from "../src/observability/redaction.js";

describe("audit whitelist summary", () => {
  it("strips sensitive keys at any depth", () => {
    const result = whitelistSummary({
      ok: true,
      payload: { user: { passportNumber: "AB1234567", displayName: "Alice" } },
    });
    expect(result).toMatchObject({
      ok: true,
      payload: { user: { passportNumber: "[REDACTED]", displayName: "Alice" } },
    });
  });

  it("clamps to depth 3 by default", () => {
    const deep = { a: { b: { c: { d: { e: "leaf" } } } } };
    const result = whitelistSummary(deep);
    expect(result).toMatchObject({ a: { b: { c: "[REDACTED]" } } });
  });

  it("allows custom depth", () => {
    const deep = { a: { b: { c: { d: { e: "leaf" } } } } };
    const result = whitelistSummary(deep, 5);
    expect(result).toMatchObject({ a: { b: { c: { d: { e: "leaf" } } } } });
  });

  it("keeps arrays with depth budget", () => {
    const result = whitelistSummary({ items: [{ a: 1 }, { b: 2 }] });
    expect(result).toEqual({ items: [{ a: 1 }, { b: 2 }] });
  });

  it("redact handles null and primitives", () => {
    expect(redact(null)).toBeNull();
    expect(redact(42)).toBe(42);
    expect(redact("hello")).toBe("hello");
    expect(redact(true)).toBe(true);
  });
});