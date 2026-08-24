import { describe, expect, it } from "vitest";
import {
  AuditSummaryValidationError,
  whitelistSummary,
} from "../src/services/audit-service.js";

describe("audit summary whitelist", () => {
  it("accepts primitive values, null, arrays, and plain nested summaries", () => {
    expect(whitelistSummary({
      stringValue: "processed",
      numberValue: 3,
      booleanValue: true,
      nullValue: null,
      items: ["flight", 2, false, null],
      outcome: { callback: { status: "duplicate" } },
    })).toEqual({
      stringValue: "processed",
      numberValue: 3,
      booleanValue: true,
      nullValue: null,
      items: ["flight", 2, false, null],
      outcome: { callback: { status: "duplicate" } },
    });
  });

  it("accepts structures through depth three", () => {
    expect(whitelistSummary({ a: { b: { c: { value: "ok" } } } }))
      .toEqual({ a: { b: { c: { value: "ok" } } } });
  });

  it("rejects structures deeper than three", () => {
    expect(() => whitelistSummary({ a: { b: { c: { d: { value: "too deep" } } } } }))
      .toThrow(AuditSummaryValidationError);
  });

  it.each([
    undefined,
    () => "unsafe",
    Symbol("unsafe"),
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects unsupported value %s", value => {
    expect(() => whitelistSummary({ value })).toThrow(AuditSummaryValidationError);
  });

  it.each([
    Buffer.from("secret"),
    new Date(),
    new (class Dangerous { value = "unsafe"; })(),
    Object.create({ inherited: "unsafe" }) as object,
  ])("rejects dangerous object shape %#", value => {
    expect(() => whitelistSummary({ value })).toThrow(AuditSummaryValidationError);
  });

  it("rejects cycles and sensitive or raw-payload keys", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => whitelistSummary(cyclic)).toThrow(AuditSummaryValidationError);
    expect(() => whitelistSummary({ apiSecret: "do-not-store" })).toThrow(AuditSummaryValidationError);
    expect(() => whitelistSummary({ payload: { arbitrary: "request body" } })).toThrow(AuditSummaryValidationError);
  });
});
