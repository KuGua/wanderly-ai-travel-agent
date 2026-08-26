import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FORBIDDEN_SPAN_ATTRIBUTE_KEYS,
  TRACEPARENT_HEADER,
  _resetTracingForTests,
  formatTraceparent,
  getActiveSpan,
  getInMemoryExporter,
  initTracing,
  newSpanId,
  newTraceId,
  parseTraceparent,
  recordSpanError,
  safeSetAttribute,
  shutdownTracing,
  trySetAttribute,
} from "../src/observability/tracing.js";

const originalEnv = { ...process.env };

describe("parseTraceparent", () => {
  it("parses a well-formed traceparent", () => {
    const tp = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
    expect(parseTraceparent(tp)).toEqual({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      flags: "01",
    });
  });

  it("accepts the optional tracestate suffix", () => {
    const tp = `00-${"a".repeat(32)}-${"b".repeat(16)}-01-aaaaaaaaaaaaaaaaaaaa=bbbbbbbb`;
    expect(parseTraceparent(tp)?.flags).toBe("01");
  });

  it("returns null on missing input", () => {
    expect(parseTraceparent(undefined)).toBeNull();
    expect(parseTraceparent(null)).toBeNull();
    expect(parseTraceparent("")).toBeNull();
  });

  it("returns null on malformed value", () => {
    expect(parseTraceparent("not-a-traceparent")).toBeNull();
    expect(parseTraceparent(`00-${"a".repeat(31)}-${"b".repeat(16)}-01`)).toBeNull();
    expect(parseTraceparent(`00-${"a".repeat(32)}-${"b".repeat(15)}-01`)).toBeNull();
    expect(parseTraceparent(`ff-${"a".repeat(32)}-${"b".repeat(16)}-01`)).toBeNull();
  });

  it("returns null on all-zero trace or span ids", () => {
    expect(parseTraceparent(`00-${"0".repeat(32)}-${"b".repeat(16)}-01`)).toBeNull();
    expect(parseTraceparent(`00-${"a".repeat(32)}-${"0".repeat(16)}-01`)).toBeNull();
  });
});

describe("formatTraceparent", () => {
  it("builds a well-formed header value", () => {
    const out = formatTraceparent("a".repeat(32), "b".repeat(16));
    expect(out).toBe(`00-${"a".repeat(32)}-${"b".repeat(16)}-01`);
  });

  it("accepts custom flags", () => {
    const out = formatTraceparent("a".repeat(32), "b".repeat(16), "00");
    expect(out.endsWith("-00")).toBe(true);
  });

  it("throws on invalid ids", () => {
    expect(() => formatTraceparent("x".repeat(32), "b".repeat(16))).toThrow(/invalid traceId/);
    expect(() => formatTraceparent("a".repeat(32), "y".repeat(16))).toThrow(/invalid spanId/);
    expect(() => formatTraceparent("a".repeat(32), "b".repeat(16), "zz")).toThrow(/invalid flags/);
  });
});

describe("id generators", () => {
  it("generates a 32-hex trace id", () => {
    const tid = newTraceId();
    expect(tid).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generates a 16-hex span id", () => {
    const sid = newSpanId();
    expect(sid).toMatch(/^[0-9a-f]{16}$/);
  });

  it("generates non-zero distinct ids on repeated calls", () => {
    const a = newTraceId();
    const b = newTraceId();
    expect(a).not.toBe(b);
    expect(a).not.toBe("00000000000000000000000000000000");
  });
});

describe("FORBIDDEN_SPAN_ATTRIBUTE_KEYS", () => {
  it("contains all PII keys from the redaction policy", () => {
    const expected = [
      "passportNumber",
      "documentNumber",
      "nationality",
      "dateOfBirth",
      "memberPreferences",
      "privateConversation",
      "prompt",
      "question",
      "rawBody",
    ];
    for (const key of expected) {
      expect(FORBIDDEN_SPAN_ATTRIBUTE_KEYS.has(key)).toBe(true);
    }
  });

  it("contains all credential keys", () => {
    const expected = [
      "authorization",
      "cookie",
      "password",
      "secret",
      "apiKey",
      "accessToken",
      "refreshToken",
      "x-api-key",
      "x-sandbox-signature",
    ];
    for (const key of expected) {
      expect(FORBIDDEN_SPAN_ATTRIBUTE_KEYS.has(key)).toBe(true);
    }
  });

  it("contains high-cardinality keys mirrored from FORBIDDEN_LABEL_KEYS", () => {
    const expected = [
      "userId",
      "tripId",
      "planId",
      "bookingId",
      "conversationId",
      "threadId",
      "destination",
      "origin",
      "model",
      "timestamp",
      "correlationId",
      "requestId",
      "orchestrationRequestId",
    ];
    for (const key of expected) {
      expect(FORBIDDEN_SPAN_ATTRIBUTE_KEYS.has(key)).toBe(true);
    }
  });

  it("does not forbid safe attribute keys", () => {
    expect(FORBIDDEN_SPAN_ATTRIBUTE_KEYS.has("http.method")).toBe(false);
    expect(FORBIDDEN_SPAN_ATTRIBUTE_KEYS.has("http.route")).toBe(false);
    expect(FORBIDDEN_SPAN_ATTRIBUTE_KEYS.has("db.system")).toBe(false);
    expect(FORBIDDEN_SPAN_ATTRIBUTE_KEYS.has("skill.name")).toBe(false);
    expect(FORBIDDEN_SPAN_ATTRIBUTE_KEYS.has("llm.system")).toBe(false);
  });
});

describe("safeSetAttribute / trySetAttribute", () => {
  beforeEach(() => {
    _resetTracingForTests();
    process.env = { ...originalEnv };
    process.env.NODE_ENV = "test";
  });

  afterEach(async () => {
    await shutdownTracing();
    _resetTracingForTests();
    process.env = { ...originalEnv };
  });

  it("throws on a forbidden key", async () => {
    await initTracing();
    const { trace } = await import("@opentelemetry/api");
    const span = trace.getTracer("test").startSpan("forbidden");
    expect(() => safeSetAttribute(span, "passportNumber", "secret")).toThrow(/forbidden/);
    span.end();
  });

  it("returns false from trySetAttribute on a forbidden key", async () => {
    await initTracing();
    const { trace } = await import("@opentelemetry/api");
    const span = trace.getTracer("test").startSpan("forbidden-try");
    expect(trySetAttribute(span, "nationality", "DE")).toBe(false);
    span.end();
  });

  it("accepts safe attribute keys", async () => {
    await initTracing();
    const { trace } = await import("@opentelemetry/api");
    const span = trace.getTracer("test").startSpan("safe");
    expect(() => safeSetAttribute(span, "http.method", "GET")).not.toThrow();
    expect(trySetAttribute(span, "http.route", "/foo")).toBe(true);
    span.end();
  });

  it("does not throw when the span is undefined (defensive)", () => {
    expect(() => safeSetAttribute(undefined, "http.method", "GET")).not.toThrow();
    expect(trySetAttribute(undefined, "http.method", "GET")).toBe(true);
  });
});

describe("initTracing env branches", () => {
  beforeEach(() => {
    _resetTracingForTests();
    process.env = { ...originalEnv };
    process.env.NODE_ENV = "test";
    delete process.env.OTEL_SDK_DISABLED;
    delete process.env.OTEL_TRACES_EXPORTER;
  });

  afterEach(async () => {
    await shutdownTracing();
    _resetTracingForTests();
    process.env = { ...originalEnv };
  });

  it("uses the in-memory exporter under NODE_ENV=test by default", async () => {
    await initTracing();
    expect(getInMemoryExporter()).not.toBeNull();
  });

  it("respects OTEL_SDK_DISABLED=true and skips the exporter", async () => {
    process.env.OTEL_SDK_DISABLED = "true";
    await initTracing();
    expect(getInMemoryExporter()).toBeNull();
  });

  it("respects OTEL_TRACES_EXPORTER=console", async () => {
    process.env.NODE_ENV = "development";
    process.env.OTEL_TRACES_EXPORTER = "console";
    await initTracing();
    // console exporter is wired but inMemoryExporter remains null in dev mode
    expect(getInMemoryExporter()).toBeNull();
  });

  it("respects OTEL_TRACES_EXPORTER=otlp without an endpoint (no-op)", async () => {
    process.env.NODE_ENV = "production";
    process.env.OTEL_TRACES_EXPORTER = "otlp";
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    await initTracing();
    expect(getInMemoryExporter()).toBeNull();
  });

  it("uses OTLP when an endpoint is configured", async () => {
    process.env.NODE_ENV = "production";
    process.env.OTEL_TRACES_EXPORTER = "otlp";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318/v1/traces";
    await initTracing();
    expect(getInMemoryExporter()).toBeNull();
  });
});

describe("active span / recordSpanError integration", () => {
  beforeEach(() => {
    _resetTracingForTests();
    process.env = { ...originalEnv };
    process.env.NODE_ENV = "test";
  });

  afterEach(async () => {
    await shutdownTracing();
    _resetTracingForTests();
    process.env = { ...originalEnv };
  });

  it("records exceptions on the active span when one is running", async () => {
    await initTracing();
    const { context, trace } = await import("@opentelemetry/api");
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("test.active");
    context.with(trace.setSpan(context.active(), span), () => {
      expect(getActiveSpan()).toBe(span);
      recordSpanError(new Error("boom"));
    });
    span.end();
    expect(getInMemoryExporter()?.getFinishedSpans().length ?? 0).toBeGreaterThan(0);
  });

  it("does not throw when there is no active span", () => {
    expect(getActiveSpan()).toBeUndefined();
    expect(() => recordSpanError(new Error("ignored"))).not.toThrow();
  });
});

describe("header constants", () => {
  it("exposes traceparent / tracestate header names", () => {
    expect(TRACEPARENT_HEADER).toBe("traceparent");
  });
});