import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/database.js";
import { agentRuns } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { LLMGateway } from "../src/providers/llm-gateway.js";
import { MockModelGateway } from "../src/providers/model-gateway.js";
import { __setModelGatewayForTests, createModelGateway } from "../src/providers/gateway-factory.js";
import { createRequestContext } from "../src/utils/context.js";

interface FakeClient {
  beta: {
    chat: {
      completions: {
        parse: (req: Record<string, unknown>) => Promise<{
          choices: Array<{ message: { parsed: { plan: Record<string, unknown> } | null } }>;
          usage?: { prompt: number; completion: number; total: number };
        }>;
      };
    };
  };
}

function buildClient(behavior: "ok" | "bad" | "abort" | "slow"): FakeClient {
  return {
    beta: {
      chat: {
        completions: {
          parse: async () => {
            if (behavior === "ok") {
              return {
                choices: [{ message: { parsed: { plan: { destination: "Tokyo", flights: [], stays: [], ground: [] } } } }],
                usage: { prompt: 12, completion: 5, total: 17 },
              };
            }
            if (behavior === "bad") return { choices: [{ message: { parsed: null } }] };
            if (behavior === "abort") {
              const err = new Error("aborted");
              err.name = "AbortError";
              throw err;
            }
            // slow
            await new Promise(resolve => setTimeout(resolve, 100));
            return { choices: [{ message: { parsed: { plan: { destination: "Tokyo" } } } }] };
          },
        },
      },
    },
  };
}

describe("LLM gateway", () => {
  beforeEach(async () => {
    await db.delete(agentRuns);
    __setModelGatewayForTests(null);
  });

  afterEach(() => {
    __setModelGatewayForTests(null);
  });

  it("returns parsed plan on success and records SUCCESS run", async () => {
    const gateway = new LLMGateway({
      apiKey: "test",
      modelName: "gpt-4o-mini",
      promptVersion: "1.0.0",
      mock: new MockModelGateway(),
      ctx: createRequestContext(),
      client: buildClient("ok"),
      maxRetries: 0,
    });

    const result = await gateway.generateStructuredPlan({
      destination: "Tokyo",
      flights: [],
      stays: [],
      ground: [],
      memberPreferences: {},
    });

    expect(result.destination).toBe("Tokyo");
    const runs = await db.select().from(agentRuns);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].status).toBe("SUCCESS");
    expect(runs[0].tokens).toEqual({ prompt: 12, completion: 5, total: 17 });
  });

  it("falls back to mock when client returns malformed output", async () => {
    const gateway = new LLMGateway({
      apiKey: "test",
      modelName: "gpt-4o-mini",
      promptVersion: "1.0.0",
      mock: new MockModelGateway(),
      ctx: createRequestContext(),
      client: buildClient("bad"),
      maxRetries: 1,
    });

    const result = await gateway.generateStructuredPlan({
      destination: "Tokyo",
      flights: [],
      stays: [],
      ground: [],
      memberPreferences: {},
    });

    expect(result.destination).toBe("Tokyo");
    const runs = await db.select().from(agentRuns).where(eq(agentRuns.status, "FALLBACK"));
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].errorCode).toBe("SCHEMA_PARSE");
  });

  it("records FALLBACK/TIMEOUT when client aborts", async () => {
    const gateway = new LLMGateway({
      apiKey: "test",
      modelName: "gpt-4o-mini",
      promptVersion: "1.0.0",
      mock: new MockModelGateway(),
      ctx: createRequestContext(),
      client: buildClient("abort"),
      maxRetries: 0,
    });

    await gateway.generateStructuredPlan({
      destination: "Tokyo",
      flights: [],
      stays: [],
      ground: [],
      memberPreferences: {},
    });

    const runs = await db.select().from(agentRuns);
    expect(runs.some(r => r.errorCode === "TIMEOUT")).toBe(true);
  });

  it("factory returns MockModelGateway when no OPENAI_API_KEY is set", () => {
    const previous = process.env.MODEL_GATEWAY_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    process.env.MODEL_GATEWAY_PROVIDER = "openai";

    const gateway = createModelGateway();
    expect(gateway).toBeInstanceOf(MockModelGateway);

    if (previous !== undefined) process.env.MODEL_GATEWAY_PROVIDER = previous;
    else delete process.env.MODEL_GATEWAY_PROVIDER;
  });
});
