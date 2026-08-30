import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { context, trace } from "@opentelemetry/api";

import {
  _resetTracingForTests,
  drainInMemorySpans,
  formatTraceparent,
  initTracing,
  shutdownTracing,
  TRACEPARENT_HEADER,
} from "../src/observability/tracing.js";
import { LLMGateway } from "../src/providers/llm-gateway.js";
import { __setModelGatewayForTests } from "../src/providers/gateway-factory.js";
import { createRequestContext } from "../src/utils/context.js";

const originalEnv = { ...process.env };

interface CapturedCall {
  args: unknown;
  options: { signal?: AbortSignal; headers?: Record<string, string> };
}

function buildCapturingClient(behavior: "ok" | "schema-bad" = "ok"): {
  client: { chat: { completions: { parse: (...args: unknown[]) => Promise<unknown>; create: (...args: unknown[]) => Promise<unknown> } } };
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const respond = async (): Promise<unknown> => ({
    choices: [{
      message: behavior === "ok"
        ? { parsed: { plan: { destination: "Tokyo", flights: [], stays: [], generatedAt: "2026-08-23T00:00:00.000Z" } } }
        : { content: "{\"reply\":{\"content\":\"hi\"}}" },
    }],
    usage: { prompt: 12, completion: 5, total: 17 },
  });
  return {
    calls,
    client: {
      chat: {
        completions: {
          parse: async (...args: unknown[]) => {
            calls.push({ args: args[0], options: (args[1] as CapturedCall["options"]) ?? {} });
            return respond();
          },
          create: async (...args: unknown[]) => {
            calls.push({ args: args[0], options: (args[1] as CapturedCall["options"]) ?? {} });
            return (async function*() { yield { choices: [{ delta: { content: "hi" } }], usage: { prompt: 1, completion: 1, total: 2 } }; })();
          },
        },
      },
    },
  };
}

describe("LLM gateway tracing", () => {
  beforeEach(() => {
    _resetTracingForTests();
    process.env = { ...originalEnv, NODE_ENV: "test" };
    __setModelGatewayForTests(null);
  });

  afterEach(async () => {
    __setModelGatewayForTests(null);
    await shutdownTracing();
    _resetTracingForTests();
    process.env = { ...originalEnv };
  });

  it("forwards traceparent in SDK options for generateStructuredPlan", async () => {
    await initTracing();
    const { client, calls } = buildCapturingClient("ok");
    const gateway = new LLMGateway({
      apiKey: "test",
      provider: "openai",
      modelName: "gpt-4",
      promptVersion: "1.0.0",
      ctx: createRequestContext(),
      client,
    });

    await gateway.generateStructuredPlan({
      destination: "Tokyo",
      flights: [],
      stays: [],
      memberPreferences: {},
    });

    expect(calls.length).toBeGreaterThan(0);
    const headers = calls[0]?.options.headers ?? {};
    expect(headers[TRACEPARENT_HEADER]).toBeUndefined(); // no active span → no header
  });

  it("includes traceparent when an active span is present", async () => {
    await initTracing();
    const { client, calls } = buildCapturingClient("ok");
    const gateway = new LLMGateway({
      apiKey: "test",
      provider: "openai",
      modelName: "gpt-4",
      promptVersion: "1.0.0",
      ctx: createRequestContext(),
      client,
    });

    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("parent");
    const ctx = trace.setSpan(context.active(), span);
    await context.with(ctx, async () => {
      await gateway.generateStructuredPlan({
        destination: "Tokyo",
        flights: [],
        stays: [],
        memberPreferences: {},
      });
    });
    span.end();

    const headers = calls[0]?.options.headers ?? {};
    const tp = headers[TRACEPARENT_HEADER];
    expect(typeof tp).toBe("string");
    // The parsed trace id must match the active span's trace id.
    const parsed = /00-([0-9a-f]{32})-([0-9a-f]{16})-/.exec(tp ?? "");
    expect(parsed).not.toBeNull();
    expect(parsed?.[1]).toBe(span.spanContext().traceId);
  });

  it("emits an llm.openai.parse span with safe attributes", async () => {
    await initTracing();
    const { client } = buildCapturingClient("ok");
    const gateway = new LLMGateway({
      apiKey: "test",
      provider: "openai",
      modelName: "gpt-4",
      promptVersion: "1.0.0",
      ctx: createRequestContext(),
      client,
    });

    await gateway.generateStructuredPlan({
      destination: "Tokyo",
      flights: [],
      stays: [],
      memberPreferences: {},
    });

    // Give the SimpleSpanProcessor a microtask to flush.
    await new Promise((resolve) => setImmediate(resolve));
    const spans = drainInMemorySpans();
    const llmSpan = spans.find((s) => s.name === "llm.openai.parse");
    expect(llmSpan).toBeDefined();
    expect(llmSpan?.attributes["llm.system"]).toBe("openai-compatible");
    expect(llmSpan?.attributes["llm.provider"]).toBe("openai");
    expect(llmSpan?.attributes["llm.model.name"]).toBe("gpt-4");
    expect(llmSpan?.attributes["llm.outcome"]).toBe("success");
    expect(llmSpan?.attributes["llm.tokens.prompt"]).toBe(12);
  });

  it("does not include sensitive attribute keys on the llm span", async () => {
    await initTracing();
    const { client } = buildCapturingClient("ok");
    const gateway = new LLMGateway({
      apiKey: "test",
      provider: "openai",
      modelName: "gpt-4",
      promptVersion: "1.0.0",
      ctx: createRequestContext(),
      client,
    });

    await gateway.generateStructuredPlan({
      destination: "Tokyo",
      flights: [],
      stays: [],
      memberPreferences: { sensitiveKey: "value" },
    });

    await new Promise((resolve) => setImmediate(resolve));
    const spans = drainInMemorySpans();
    const llmSpan = spans.find((s) => s.name === "llm.openai.parse");
    expect(llmSpan).toBeDefined();
    const attrs = llmSpan?.attributes ?? {};
    // None of these forbidden keys should ever appear on a span attribute set.
    const forbidden = [
      "prompt",
      "question",
      "memberPreferences",
      "passportNumber",
      "nationality",
      "destination",
      "origin",
    ];
    for (const key of forbidden) {
      expect(Object.prototype.hasOwnProperty.call(attrs, key)).toBe(false);
    }
  });
});

describe("LLM gateway outbound headers when no span is active", () => {
  beforeEach(() => {
    _resetTracingForTests();
    process.env = { ...originalEnv, NODE_ENV: "test" };
    __setModelGatewayForTests(null);
  });

  afterEach(async () => {
    __setModelGatewayForTests(null);
    await shutdownTracing();
    _resetTracingForTests();
    process.env = { ...originalEnv };
  });

  it("falls back to ctx.traceparent when no active span", async () => {
    await initTracing();
    const { client, calls } = buildCapturingClient("ok");
    const ctx = createRequestContext(
      undefined,
      "00000000-0000-4000-8000-000000000001",
      "a".repeat(32),
      undefined,
      formatTraceparent("a".repeat(32), "b".repeat(16), "01"),
    );
    const gateway = new LLMGateway({
      apiKey: "test",
      provider: "openai",
      modelName: "gpt-4",
      promptVersion: "1.0.0",
      ctx,
      client,
    });

    await gateway.generateStructuredPlan({
      destination: "Tokyo",
      flights: [],
      stays: [],
      memberPreferences: {},
    });

    const headers = calls[0]?.options.headers ?? {};
    expect(headers[TRACEPARENT_HEADER]).toBe(formatTraceparent("a".repeat(32), "b".repeat(16), "01"));
  });
});