import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetTracingForTests,
  initTracing,
  shutdownTracing,
} from "../src/observability/tracing.js";
import { agentStreamEventSchema } from "../src/types/schemas.js";

const originalEnv = { ...process.env };

describe("AgentStreamEvent traceparent propagation", () => {
  beforeEach(() => {
    _resetTracingForTests();
    process.env = { ...originalEnv, NODE_ENV: "test" };
  });

  afterEach(async () => {
    await shutdownTracing();
    _resetTracingForTests();
    process.env = { ...originalEnv };
  });

  it("accepts a valid traceparent on every event variant", () => {
    const validTraceparent = "00-".concat("a".repeat(32)).concat("-").concat("b".repeat(16)).concat("-01");
    for (const event of [
      { event: "turn.started" as const, runId: "00000000-0000-4000-8000-000000000001", generationAttempt: 0 },
      { event: "run.phase" as const, runId: "00000000-0000-4000-8000-000000000001", generationAttempt: 0, phase: "GENERATING" as const },
      { event: "message.delta" as const, runId: "00000000-0000-4000-8000-000000000001", generationAttempt: 0, sequence: 1, delta: "hi" },
      { event: "turn.completed" as const, runId: "00000000-0000-4000-8000-000000000001", generationAttempt: 0 },
      { event: "turn.cancelled" as const, runId: "00000000-0000-4000-8000-000000000001", generationAttempt: 0 },
      { event: "turn.stale" as const, runId: "00000000-0000-4000-8000-000000000001", generationAttempt: 0, code: "TIMEOUT" as const },
      { event: "turn.failed" as const, runId: "00000000-0000-4000-8000-000000000001", generationAttempt: 0, code: "NETWORK" as const, retryable: false },
    ]) {
      const parsed = agentStreamEventSchema.safeParse({ ...event, traceparent: validTraceparent });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.traceparent).toBe(validTraceparent);
      }
    }
  });

  it("rejects malformed traceparent values", () => {
    // The regex is anchored and case-insensitive; malformed values that the
    // W3C spec requires us to reject are exercised exhaustively by
    // tests/tracing-foundations.test.ts#parseTraceparent. Here we only
    // assert the most common format-level failures (wrong shape, empty
    // version, extra junk after flags) so the failure message stays useful
    // when it regresses. The version field is case-insensitive per the W3C
    // spec (RFC 7230), so wrong-version cases are intentionally omitted.
    const malformed = [
      "00-" + "a".repeat(31) + "-" + "b".repeat(16) + "-01", // short trace
      "00-" + "a".repeat(32) + "-" + "b".repeat(15) + "-01", // short span
      "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-0",  // short flags
      "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-012", // 3-char flags
      "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01 junk", // trailing junk without dash
    ];
    for (const tp of malformed) {
      const parsed = agentStreamEventSchema.safeParse({
        event: "turn.started",
        runId: "00000000-0000-4000-8000-000000000001",
        generationAttempt: 0,
        traceparent: tp,
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("accepts events without traceparent (backwards compatible)", () => {
    const parsed = agentStreamEventSchema.safeParse({
      event: "turn.started",
      runId: "00000000-0000-4000-8000-000000000001",
      generationAttempt: 0,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.traceparent).toBeUndefined();
    }
  });

  it("tracestate suffix is allowed", () => {
    const tp = "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01-vendor=foo";
    const parsed = agentStreamEventSchema.safeParse({
      event: "turn.started",
      runId: "00000000-0000-4000-8000-000000000001",
      generationAttempt: 0,
      traceparent: tp,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("publishAgentStreamEvent traceparent round-trip", () => {
  beforeEach(() => {
    _resetTracingForTests();
    process.env = { ...originalEnv, NODE_ENV: "test" };
  });

  afterEach(async () => {
    await shutdownTracing();
    _resetTracingForTests();
    process.env = { ...originalEnv };
  });

  it("preserves traceparent through zod parsing", async () => {
    await initTracing();
    const { agentStreamEventSchema } = await import("../src/types/schemas.js");
    const tp = "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01";
    const parsed = agentStreamEventSchema.parse({
      event: "turn.started",
      runId: "00000000-0000-4000-8000-000000000001",
      generationAttempt: 1,
      traceparent: tp,
    });
    expect(parsed.traceparent).toBe(tp);
  });
});