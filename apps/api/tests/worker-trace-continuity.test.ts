import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetTracingForTests,
  drainInMemorySpans,
  formatTraceparent,
  initTracing,
  parseTraceparent,
  shutdownTracing,
} from "../src/observability/tracing.js";

const originalEnv = { ...process.env };

describe("ctxFromRun / worker trace continuity", () => {
  beforeEach(() => {
    _resetTracingForTests();
    process.env = { ...originalEnv, NODE_ENV: "test" };
  });

  afterEach(async () => {
    await shutdownTracing();
    _resetTracingForTests();
    process.env = { ...originalEnv };
  });

  it("preserves the originating trace id from agent_task_runs.trace_context", async () => {
    await initTracing();
    const { ctxFromRun } = await import("../src/tasks/task-repository.js");

    const traceId = "a".repeat(32);
    const spanId = "b".repeat(16);
    const traceparent = formatTraceparent(traceId, spanId, "01");
    const run = {
      id: "00000000-0000-4000-8000-000000000001",
      createdByUserId: "00000000-0000-4000-8000-000000000002",
      requestId: "00000000-0000-4000-8000-000000000003",
      traceContext: {
        traceparent,
        correlationId: "00000000-0000-4000-8000-000000000004",
      },
    } as unknown as Parameters<typeof ctxFromRun>[0];

    const ctx = ctxFromRun(run);
    expect(ctx.traceparent).toBe(traceparent);
    expect(ctx.correlationId).toBe("00000000-0000-4000-8000-000000000004");
    const parsed = parseTraceparent(ctx.traceparent);
    expect(parsed?.traceId).toBe(traceId);
    expect(parsed?.spanId).toBe(spanId);
  });

  it("falls back to a fresh UUID when trace_context is missing", async () => {
    await initTracing();
    const { ctxFromRun } = await import("../src/tasks/task-repository.js");
    const run = {
      id: "00000000-0000-4000-8000-000000000001",
      createdByUserId: "00000000-0000-4000-8000-000000000002",
      requestId: "00000000-0000-4000-8000-000000000003",
      traceContext: null,
    } as unknown as Parameters<typeof ctxFromRun>[0];

    const ctx = ctxFromRun(run);
    expect(ctx.traceparent).toBeUndefined();
    expect(ctx.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("worker span links back to the originating HTTP span", async () => {
    await initTracing();
    const { trace } = await import("@opentelemetry/api");
    const { ctxFromRun } = await import("../src/tasks/task-repository.js");

    const traceId = "c".repeat(32);
    const spanId = "d".repeat(16);
    const traceparent = formatTraceparent(traceId, spanId, "01");
    const run = {
      id: "00000000-0000-4000-8000-000000000010",
      createdByUserId: "00000000-0000-4000-8000-000000000011",
      requestId: "00000000-0000-4000-8000-000000000012",
      generationAttempt: 1,
      traceContext: { traceparent, correlationId: "00000000-0000-4000-8000-000000000013" },
    } as unknown as Parameters<typeof ctxFromRun>[0];

    // Sanity: ctxFromRun reconstructs correctly.
    const ctx = ctxFromRun(run);
    expect(ctx.traceparent).toBe(traceparent);

    // Simulate the worker span: a CONSUMER span with a link back to the
    // originating HTTP trace.
    const tracer = trace.getTracer("test");
    const workerSpan = tracer.startSpan("agent_task_worker.run", {
      attributes: { "tasks.operation": "conversation" },
      links: [{
        context: {
          traceId,
          spanId,
          isRemote: true,
          traceFlags: 1,
        },
      }],
    });
    workerSpan.end();

    await new Promise((resolve) => setImmediate(resolve));
    const finished = drainInMemorySpans();
    const found = finished.find((s) => s.name === "agent_task_worker.run");
    expect(found).toBeDefined();
    // The link must reference the originating trace.
    expect(found?.links.length).toBeGreaterThan(0);
    expect(found?.links[0]?.context.traceId).toBe(traceId);
    expect(found?.links[0]?.context.spanId).toBe(spanId);
  });
});