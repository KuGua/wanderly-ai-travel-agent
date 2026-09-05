import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LLMGateway, ModelGatewayError } from "../src/providers/llm-gateway.js";
import { createRequestContext } from "../src/utils/context.js";
import { metrics } from "../src/observability/metrics.js";

const OLD_ENV = { ...process.env };

interface CapturingClient {
  chat: {
    completions: {
      parse: (...args: unknown[]) => Promise<unknown>;
      create: (...args: unknown[]) => Promise<unknown>;
    };
  };
  createCalls: number;
  /**
   * Stream plan: first call throws immediately (no delta yet) OR throws
   * after the first delta. Subsequent calls succeed.
   */
  scenario: "fail-before-delta" | "fail-after-delta" | "always-fail" | "429-before-delta" | "429-always";
}

function buildClient(scenario: CapturingClient["scenario"]): CapturingClient {
  const client: CapturingClient = {
    createCalls: 0,
    scenario,
    chat: {
      completions: {
        parse: async () => {
          throw new Error("not used in stream-mode tests");
        },
        create: async () => {
          client.createCalls += 1;
          if (scenario === "fail-before-delta" && client.createCalls === 1) {
            throw new Error("upstream returned 503 Service Unavailable");
          }
          if (scenario === "fail-after-delta" && client.createCalls === 1) {
            return (async function* () {
              yield { choices: [{ delta: { content: "partial " } }] };
              throw new Error("upstream returned 503 Service Unavailable");
            })();
          }
          if (scenario === "always-fail") {
            throw new Error("upstream returned 503 Service Unavailable");
          }
          if (scenario === "429-before-delta" && client.createCalls === 1) {
            throw Object.assign(new Error("upstream returned 429 Too Many Requests"), { status: 429 });
          }
          if (scenario === "429-always") {
            throw Object.assign(new Error("upstream returned 429 Too Many Requests"), { status: 429 });
          }
          return (async function* () {
            yield { choices: [{ delta: { content: "hello " } }] };
            yield { choices: [{ delta: { content: "world" } }] };
            yield { choices: [], usage: { prompt: 1, completion: 2, total: 3 } };
          })();
        },
      },
    },
  };
  return client;
}

describe("LLMGateway streamConversationReply retry policy", () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, NODE_ENV: "test", MODEL_GATEWAY_BASE_BACKOFF_MS: "10", MODEL_GATEWAY_MAX_BACKOFF_MS: "30", MODEL_GATEWAY_RATE_LIMIT_BACKOFF_MS: "10" };
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("retries a pre-delta UPSTREAM_5XX transparently and delivers the final stream", async () => {
    const client = buildClient("fail-before-delta");
    const gateway = new LLMGateway({
      apiKey: "test",
      provider: "openai",
      modelName: "gpt-4",
      promptVersion: "1.0.0",
      ctx: createRequestContext(),
      client,
    });
    const deltas: string[] = [];
    const reply = await gateway.streamConversationReply!({
      question: "hi",
      threadContext: [],
      onDelta: (delta) => { deltas.push(delta); },
    });
    expect(client.createCalls).toBe(2);
    expect(reply.content).toBe("hello world");
    expect(reply.responseMode).toBe("MODEL");
    expect(deltas.join("")).toBe("hello world");
  });

  it("does NOT retry once a delta has been delivered — rethrows so SSE closes", async () => {
    const client = buildClient("fail-after-delta");
    const gateway = new LLMGateway({
      apiKey: "test",
      provider: "openai",
      modelName: "gpt-4",
      promptVersion: "1.0.0",
      ctx: createRequestContext(),
      client,
      maxRetries: 5,
    });
    const deltas: string[] = [];
    await expect(gateway.streamConversationReply!({
      question: "hi",
      threadContext: [],
      onDelta: (delta) => { deltas.push(delta); },
    })).rejects.toBeInstanceOf(ModelGatewayError);
    // First (and only) attempt: emits "partial " then throws. No retry.
    expect(client.createCalls).toBe(1);
    expect(deltas.join("")).toBe("partial ");
  });

  it("returns a FALLBACK reply when the retry budget is exhausted before any streaming starts", async () => {
    const client = buildClient("always-fail");
    const gateway = new LLMGateway({
      apiKey: "test",
      provider: "openai",
      modelName: "gpt-4",
      promptVersion: "1.0.0",
      ctx: createRequestContext(),
      client,
      maxRetries: 1,
    });
    const deltas: string[] = [];
    const reply = await gateway.streamConversationReply!({
      question: "hi",
      threadContext: [],
      onDelta: (delta) => { deltas.push(delta); },
    });
    expect(client.createCalls).toBe(2); // 1 + 1 retry
    expect(reply.responseMode).toBe("FALLBACK");
    expect(reply.content.length).toBeGreaterThan(0);
    expect(deltas).toEqual([]); // no chunks were ever sent
  });

  it("retries a pre-delta RATE_LIMITED (HTTP 429) without MetricLabelError and labels the metric rate_limited", async () => {
    metrics.reset();
    const client = buildClient("429-before-delta");
    const gateway = new LLMGateway({
      apiKey: "test",
      provider: "openai",
      modelName: "gpt-4",
      promptVersion: "1.0.0",
      ctx: createRequestContext(),
      client,
    });
    const deltas: string[] = [];
    const reply = await gateway.streamConversationReply!({
      question: "hi",
      threadContext: [],
      onDelta: (delta) => { deltas.push(delta); },
    });
    expect(client.createCalls).toBe(2);
    expect(reply.responseMode).toBe("MODEL");
    expect(reply.content).toBe("hello world");
    expect(deltas.join("")).toBe("hello world");
    expect(metrics.render()).toContain('error_category="rate_limited"');
  });

  it("returns a FALLBACK reply when a sustained RATE_LIMITED exhausts the retry budget (no INTERNAL)", async () => {
    metrics.reset();
    const client = buildClient("429-always");
    const gateway = new LLMGateway({
      apiKey: "test",
      provider: "openai",
      modelName: "gpt-4",
      promptVersion: "1.0.0",
      ctx: createRequestContext(),
      client,
      maxRetries: 1,
    });
    const deltas: string[] = [];
    const reply = await gateway.streamConversationReply!({
      question: "hi",
      threadContext: [],
      onDelta: (delta) => { deltas.push(delta); },
    });
    expect(client.createCalls).toBe(2);
    expect(reply.responseMode).toBe("FALLBACK");
    expect(deltas).toEqual([]);
    expect(metrics.render()).toContain('error_category="rate_limited"');
  });
});