import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
 * Pure unit test asserting that pino JSON lines emitted by the production
 * `correlationChild` carry a `trace_id` field. This is the property that
 * makes the dev shell snippet `docker logs app 2>&1 | jq 'select(.trace_id)'`
 * work without standing up Loki.
 */
function captureLogs(): { logger: pino.Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write: (chunk, _enc, cb) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      for (const raw of text.split("\n")) {
        if (!raw.trim()) continue;
        lines.push(JSON.parse(raw));
      }
      cb();
    },
  });
  const logger = pino(
    { level: "info", redact: LOGGER_REDACTION },
    stream,
  );
  return { logger, lines };
}

describe("pino stdout line carries trace_id for local `docker logs | jq`", () => {
  beforeEach(() => {
    _resetTracingForTests();
    process.env = { ...originalEnv, NODE_ENV: "test" };
  });

  afterEach(async () => {
    await shutdownTracing();
    _resetTracingForTests();
    process.env = { ...originalEnv };
  });

  it("emits a 32-hex trace_id under an active span", async () => {
    await initTracing();
    const { trace, context } = await import("@opentelemetry/api");
    const { logger, lines } = captureLogs();
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("docker-logs-test");
    const ctx = trace.setSpan(context.active(), span);
    await context.with(ctx, () => {
      const child = correlationChild(
        logger,
        "00000000-0000-4000-8000-000000000001",
      );
      child.info("dev log");
    });
    span.end();
    await new Promise((resolve) => setImmediate(resolve));
    const line = lines.find((l) => l.msg === "dev log");
    expect(line).toBeDefined();
    expect(line?.trace_id).toBe(span.spanContext().traceId);
    expect(line?.trace_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("omits trace_id when no active span (so background logs stay searchable)", async () => {
    await initTracing();
    const { logger, lines } = captureLogs();
    const child = correlationChild(
      logger,
      "00000000-0000-4000-8000-000000000002",
    );
    child.info("background log");
    await new Promise((resolve) => setImmediate(resolve));
    const line = lines.find((l) => l.msg === "background log");
    expect(line).toBeDefined();
    expect(line?.trace_id).toBeUndefined();
    expect(line?.correlationId).toBe("00000000-0000-4000-8000-000000000002");
  });

  it("a `docker logs | jq 'select(.trace_id)'` shell snippet filters cleanly", async () => {
    await initTracing();
    const { trace, context } = await import("@opentelemetry/api");
    const { logger, lines } = captureLogs();
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("grep-demo");
    const ctx = trace.setSpan(context.active(), span);
    await context.with(ctx, () => {
      const child = correlationChild(logger, "00000000-0000-4000-8000-000000000003");
      child.info("with trace");
      child.info("with trace again");
    });
    span.end();
    await new Promise((resolve) => setImmediate(resolve));
    const matches = lines.filter((l) => typeof l.trace_id === "string");
    expect(matches.length).toBe(2);
    for (const match of matches) {
      expect(match?.trace_id).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("pino redact still applies — PII paths never leak through the stdout line", async () => {
    await initTracing();
    const { trace, context } = await import("@opentelemetry/api");
    const { logger, lines } = captureLogs();
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("redact-demo");
    const ctx = trace.setSpan(context.active(), span);
    await context.with(ctx, () => {
      const child = correlationChild(logger, "00000000-0000-4000-8000-000000000004");
      child.info({
        req: { body: { passportNumber: "ABC123", nationality: "DE" } },
      }, "redact check");
    });
    span.end();
    await new Promise((resolve) => setImmediate(resolve));
    const line = lines.find((l) => l.msg === "redact check");
    expect(line).toBeDefined();
    const req = line?.req as { body: { passportNumber?: string; nationality?: string } };
    expect(req.body.passportNumber).toBe("[REDACTED]");
    expect(req.body.nationality).toBe("[REDACTED]");
  });
});