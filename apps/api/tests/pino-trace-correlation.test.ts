import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";

import { LOGGER_REDACTION, correlationChild } from "../src/observability/telemetry.js";
import {
  _resetTracingForTests,
  initTracing,
  shutdownTracing,
} from "../src/observability/tracing.js";

const originalEnv = { ...process.env };

/**
 * Pino writes the merged record to its destination stream. We attach a
 * memory stream so tests can assert that `trace_id` / `span_id` bindings
 * are emitted on every record. A new pino instance is created per test
 * because pino's `child()` does not accept a stream override.
 */
function captureLogs(): { logger: pino.Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      for (const raw of text.split("\n")) {
        if (!raw.trim()) continue;
        try {
          lines.push(JSON.parse(raw));
        } catch {
          // not JSON; ignore
        }
      }
      cb();
    },
  });
  const logger = pino(
    {
      level: "info",
      redact: LOGGER_REDACTION,
    },
    stream,
  );
  return { logger, lines };
}

describe("Pino ↔ active span correlation", () => {
  beforeEach(() => {
    _resetTracingForTests();
    process.env = { ...originalEnv, NODE_ENV: "test" };
  });

  afterEach(async () => {
    await shutdownTracing();
    _resetTracingForTests();
    process.env = { ...originalEnv };
  });

  it("correlationChild binds trace_id and span_id when an active span is present", async () => {
    await initTracing();
    const { trace, context } = await import("@opentelemetry/api");
    const { logger, lines } = captureLogs();
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("test.bind");
    const ctx = trace.setSpan(context.active(), span);
    await context.with(ctx, () => {
      const child = correlationChild(logger, "00000000-0000-4000-8000-000000000001");
      child.info({ hello: "world" }, "with span");
    });
    span.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines.length).toBeGreaterThan(0);
    const line = lines.find((l) => l.msg === "with span");
    expect(line).toBeDefined();
    expect(line?.trace_id).toBe(span.spanContext().traceId);
    expect(line?.span_id).toBe(span.spanContext().spanId);
    expect(line?.correlationId).toBe("00000000-0000-4000-8000-000000000001");
    expect(line?.hello).toBe("world");
  });

  it("correlationChild omits trace_id and span_id when no active span", async () => {
    await initTracing();
    const { logger, lines } = captureLogs();
    const child = correlationChild(logger, "00000000-0000-4000-8000-000000000002");
    child.info("no span");
    await new Promise((resolve) => setImmediate(resolve));
    const line = lines.find((l) => l.msg === "no span");
    expect(line).toBeDefined();
    expect(line?.correlationId).toBe("00000000-0000-4000-8000-000000000002");
    expect(line?.trace_id).toBeUndefined();
    expect(line?.span_id).toBeUndefined();
  });

  it("clientRequestId is bound when supplied", async () => {
    await initTracing();
    const { logger, lines } = captureLogs();
    const child = correlationChild(
      logger,
      "00000000-0000-4000-8000-000000000003",
      "abc-123-client-id",
    );
    child.info("with clientRequestId");
    await new Promise((resolve) => setImmediate(resolve));
    const line = lines.find((l) => l.msg === "with clientRequestId");
    expect(line).toBeDefined();
    expect(line?.clientRequestId).toBe("abc-123-client-id");
    expect(line?.correlationId).toBe("00000000-0000-4000-8000-000000000003");
  });

  it("all-zero trace/span ids are suppressed from bindings", async () => {
    await initTracing();
    // Easiest way to produce zero ids is to construct the binding check
    // directly: correlationChild filters them. We exercise it via a stubbed
    // spanContext.
    const { context, trace } = await import("@opentelemetry/api");
    const { logger, lines } = captureLogs();
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("zero-span");
    const original = span.spanContext.bind(span);
    vi.spyOn(span, "spanContext").mockReturnValue({
      traceId: "00000000000000000000000000000000",
      spanId: "0000000000000000",
      traceFlags: 1,
      isRemote: false,
    });
    try {
      const ctx = trace.setSpan(context.active(), span);
      await context.with(ctx, () => {
        const child = correlationChild(logger, "00000000-0000-4000-8000-000000000004");
        child.info("zero ids");
      });
      await new Promise((resolve) => setImmediate(resolve));
      const line = lines.find((l) => l.msg === "zero ids");
      expect(line).toBeDefined();
      expect(line?.trace_id).toBeUndefined();
      expect(line?.span_id).toBeUndefined();
    } finally {
      span.spanContext = original;
    }
  });

  it("pino redaction still applies with the new bindings", async () => {
    await initTracing();
    const { trace, context } = await import("@opentelemetry/api");
    const { logger, lines } = captureLogs();
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("redact");
    const ctx = trace.setSpan(context.active(), span);
    await context.with(ctx, () => {
      const child = correlationChild(logger, "00000000-0000-4000-8000-000000000005");
      child.info({
        req: {
          body: { passportNumber: "ABC123", nationality: "DE" },
        },
      }, "redact check");
    });
    span.end();
    await new Promise((resolve) => setImmediate(resolve));
    const line = lines.find((l) => l.msg === "redact check");
    expect(line).toBeDefined();
    const req = line?.req as { body: { passportNumber?: string; nationality?: string } } | undefined;
    expect(req?.body.passportNumber).toBe("[REDACTED]");
    expect(req?.body.nationality).toBe("[REDACTED]");
    expect(line?.trace_id).toBe(span.spanContext().traceId);
  });

  it("LOGGER_REDACTION exports the production redact config", () => {
    expect(LOGGER_REDACTION.censor).toBe("[REDACTED]");
    expect(LOGGER_REDACTION.paths.length).toBeGreaterThanOrEqual(38);
  });
});