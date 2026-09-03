import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LLMGateway, ModelGatewayError } from "../src/providers/llm-gateway.js";
import { createRequestContext } from "../src/utils/context.js";

const OLD_ENV = { ...process.env };

interface CapturingClient {
  chat: {
    completions: {
      parse: (...args: unknown[]) => Promise<unknown>;
      create: (...args: unknown[]) => Promise<unknown>;
    };
  };
  parseCalls: number;
  createCalls: number;
}

function buildClient(behavior: "ok" | "schema-bad" | "5xx" | "5xx-then-ok" | "parse-then-ok"): CapturingClient {
  const client: CapturingClient = {
    parseCalls: 0,
    createCalls: 0,
    chat: {
      completions: {
        parse: async () => {
          client.parseCalls += 1;
          if (behavior === "5xx" || (behavior === "5xx-then-ok" && client.parseCalls === 1)) {
            // Carries `status`, the way the SDK's own errors do. The classifier
            // used to accept a "502" anywhere in the message, which also read a
            // 429 whose body quoted a 5xx back as a server error; it now trusts
            // `status` first. A stub without one was testing the loose path.
            throw Object.assign(new Error("upstream returned 502 Bad Gateway"), { status: 502 });
          }
          if (behavior === "parse-then-ok") {
            if (client.parseCalls === 1) {
              throw new Error("failed to parse upstream response: schema mismatch");
            }
          }
          if (behavior === "schema-bad") {
            throw new Error("response schema validation failed");
          }
          return {
            choices: [{ message: { parsed: { plan: { destination: "tokyo", flights: [], stays: [], generatedAt: "2026-08-23T00:00:00.000Z" } } } }],
            usage: { prompt: 1, completion: 1, total: 2 },
          };
        },
        create: async () => {
          client.createCalls += 1;
          throw new Error("not used in parse-mode tests");
        },
      },
    },
  };
  return client;
}

describe("LLMGateway retry policy", () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, NODE_ENV: "test", MODEL_GATEWAY_BASE_BACKOFF_MS: "10", MODEL_GATEWAY_MAX_BACKOFF_MS: "30" };
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("retries transient UPSTREAM_5XX with exponential backoff until success", async () => {
    const client = buildClient("5xx-then-ok");
    const gateway = new LLMGateway({
      apiKey: "test",
      provider: "openai",
      modelName: "gpt-4",
      promptVersion: "1.0.0",
      ctx: createRequestContext(),
      client,
    });
    const start = Date.now();
    const result = await gateway.generateStructuredPlan({
      destination: "tokyo",
      flights: [],
      stays: [],
      memberPreferences: {},
    });
    const elapsed = Date.now() - start;
    expect(result.destination).toBe("tokyo");
    expect(client.parseCalls).toBeGreaterThanOrEqual(2);
    // Backoff between attempt 0 and 1 is `min(10 * 2^0, 30) + jitter(0..10)`.
    // The first attempt fails immediately, so elapsed should comfortably
    // exceed the floor (10ms) and stay under a generous upper bound.
    expect(elapsed).toBeGreaterThanOrEqual(5);
  });

  it("does NOT retry SCHEMA_PARSE — fails fast after one attempt", async () => {
    const client = buildClient("parse-then-ok");
    const gateway = new LLMGateway({
      apiKey: "test",
      provider: "openai",
      modelName: "gpt-4",
      promptVersion: "1.0.0",
      ctx: createRequestContext(),
      client,
    });
    await expect(gateway.generateStructuredPlan({
      destination: "tokyo",
      flights: [],
      stays: [],
      memberPreferences: {},
    })).rejects.toBeInstanceOf(ModelGatewayError);
    expect(client.parseCalls).toBe(1);
  });

  it("stops retrying once the budget is exhausted and surfaces a ModelGatewayError", async () => {
    const client = buildClient("5xx");
    const gateway = new LLMGateway({
      apiKey: "test",
      provider: "openai",
      modelName: "gpt-4",
      promptVersion: "1.0.0",
      ctx: createRequestContext(),
      client,
      maxRetries: 2,
    });
    await expect(gateway.generateStructuredPlan({
      destination: "tokyo",
      flights: [],
      stays: [],
      memberPreferences: {},
    })).rejects.toMatchObject({ code: "UPSTREAM_5XX" });
    // 1 initial attempt + 2 retries = 3 parse calls.
    expect(client.parseCalls).toBe(3);
  });
});