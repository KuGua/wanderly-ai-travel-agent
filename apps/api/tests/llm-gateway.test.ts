import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/database.js";
import { agentRuns } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { LLMGateway, ModelGatewayError } from "../src/providers/llm-gateway.js";
import { __setModelGatewayForTests, createModelGateway } from "../src/providers/gateway-factory.js";
import { createRequestContext } from "../src/utils/context.js";

vi.mock("openai", () => ({
  default: class FakeOpenAI {
    chat = {
      completions: {
        parse: async () => ({
          choices: [{ message: { parsed: { plan: { destination: "Tokyo", flights: [], stays: [], generatedAt: "2026-08-23T00:00:00.000Z" } } } }],
        }),
      },
    };
  },
}));

interface FakeClient {
  chat: {
    completions: {
      parse: (req: Record<string, unknown>) => Promise<{
        choices: Array<{ message: { parsed: { plan: Record<string, unknown> } | null } }>;
        usage?: { prompt: number; completion: number; total: number };
      }>;
    };
  };
}

function buildClient(behavior: "ok" | "bad" | "abort" | "slow"): FakeClient {
  return {
    chat: {
      completions: {
        parse: async () => {
          if (behavior === "ok") {
            return {
              choices: [{ message: { parsed: { plan: { destination: "Tokyo", flights: [], stays: [], generatedAt: "2026-08-23T00:00:00.000Z" } } } }],
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
      provider: "openai",
      modelName: "gpt-4o-mini",
      promptVersion: "1.0.0",
      ctx: createRequestContext(),
      client: buildClient("ok"),
      maxRetries: 0,
    });

    const result = await gateway.generateStructuredPlan({
      destination: "Tokyo",
      flights: [],
      stays: [],
      memberPreferences: {},
    });

    expect(result.destination).toBe("Tokyo");
    const runs = await db.select().from(agentRuns);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].status).toBe("SUCCESS");
    expect(runs[0].tokens).toEqual({ prompt: 12, completion: 5, total: 17 });
  });

  it("loads the configured OpenAI client when no test client is injected", async () => {
    const gateway = new LLMGateway({
      apiKey: "test",
      provider: "openai",
      modelName: "gpt-4o-mini",
      promptVersion: "1.0.0",
      ctx: createRequestContext(),
      maxRetries: 0,
    });

    const result = await gateway.generateStructuredPlan({
      destination: "Tokyo",
      flights: [],
      stays: [],
      memberPreferences: {},
    });

    expect(result.destination).toBe("Tokyo");
    const runs = await db.select().from(agentRuns).where(eq(agentRuns.status, "SUCCESS"));
    expect(runs).toHaveLength(1);
  });

  it("fails closed when the client returns malformed output", async () => {
    const gateway = new LLMGateway({
      apiKey: "test",
      provider: "openai",
      modelName: "gpt-4o-mini",
      promptVersion: "1.0.0",
      ctx: createRequestContext(),
      client: buildClient("bad"),
      maxRetries: 1,
    });

    await expect(gateway.generateStructuredPlan({
      destination: "Tokyo",
      flights: [],
      stays: [],
      memberPreferences: {},
    })).rejects.toMatchObject({ code: "SCHEMA_PARSE" });

    const runs = await db.select().from(agentRuns).where(eq(agentRuns.status, "ERROR"));
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].errorCode).toBe("SCHEMA_PARSE");
  });

  it("records TIMEOUT and fails closed when the client aborts", async () => {
    const gateway = new LLMGateway({
      apiKey: "test",
      provider: "openai",
      modelName: "gpt-4o-mini",
      promptVersion: "1.0.0",
      ctx: createRequestContext(),
      client: buildClient("abort"),
      maxRetries: 0,
    });

    await expect(gateway.generateStructuredPlan({
      destination: "Tokyo",
      flights: [],
      stays: [],
      memberPreferences: {},
    })).rejects.toBeInstanceOf(ModelGatewayError);

    const runs = await db.select().from(agentRuns);
    expect(runs.some(r => r.errorCode === "TIMEOUT")).toBe(true);
  });

  it("factory fails closed when the configured provider has no API key", () => {
    const previous = {
      provider: process.env.MODEL_GATEWAY_PROVIDER,
      key: process.env.MODEL_GATEWAY_API_KEY,
    };
    delete process.env.MODEL_GATEWAY_API_KEY;
    process.env.MODEL_GATEWAY_PROVIDER = "openai";

    expect(() => createModelGateway()).toThrow("Model gateway openai is not fully configured");

    if (previous.provider !== undefined) process.env.MODEL_GATEWAY_PROVIDER = previous.provider;
    else delete process.env.MODEL_GATEWAY_PROVIDER;
    if (previous.key !== undefined) process.env.MODEL_GATEWAY_API_KEY = previous.key;
    else delete process.env.MODEL_GATEWAY_API_KEY;
  });

  it("factory fails closed when Gemini has no explicit model", () => {
    const previous = {
      provider: process.env.MODEL_GATEWAY_PROVIDER,
      key: process.env.MODEL_GATEWAY_API_KEY,
      model: process.env.MODEL_GATEWAY_MODEL,
    };
    process.env.MODEL_GATEWAY_PROVIDER = "gemini";
    process.env.MODEL_GATEWAY_API_KEY = "test-gemini-key";
    delete process.env.MODEL_GATEWAY_MODEL;

    expect(() => createModelGateway()).toThrow("Model gateway gemini is not fully configured");

    if (previous.provider !== undefined) process.env.MODEL_GATEWAY_PROVIDER = previous.provider;
    else delete process.env.MODEL_GATEWAY_PROVIDER;
    if (previous.key !== undefined) process.env.MODEL_GATEWAY_API_KEY = previous.key;
    else delete process.env.MODEL_GATEWAY_API_KEY;
    if (previous.model !== undefined) process.env.MODEL_GATEWAY_MODEL = previous.model;
    else delete process.env.MODEL_GATEWAY_MODEL;
  });

  it("factory uses an explicitly configured Gemini model", () => {
    const previous = {
      provider: process.env.MODEL_GATEWAY_PROVIDER,
      key: process.env.MODEL_GATEWAY_API_KEY,
      model: process.env.MODEL_GATEWAY_MODEL,
    };
    process.env.MODEL_GATEWAY_PROVIDER = "gemini";
    process.env.MODEL_GATEWAY_API_KEY = "test-gemini-key";
    process.env.MODEL_GATEWAY_MODEL = "gemini-3.1-flash-lite";

    const gateway = createModelGateway();
    expect((gateway as unknown as { options: { modelName: string } }).options.modelName).toBe("gemini-3.1-flash-lite");

    if (previous.provider !== undefined) process.env.MODEL_GATEWAY_PROVIDER = previous.provider;
    else delete process.env.MODEL_GATEWAY_PROVIDER;
    if (previous.key !== undefined) process.env.MODEL_GATEWAY_API_KEY = previous.key;
    else delete process.env.MODEL_GATEWAY_API_KEY;
    if (previous.model !== undefined) process.env.MODEL_GATEWAY_MODEL = previous.model;
    else delete process.env.MODEL_GATEWAY_MODEL;
  });

  it("factory configures an OpenAI-compatible provider only with a URL, key, and model", () => {
    const previous = {
      provider: process.env.MODEL_GATEWAY_PROVIDER,
      key: process.env.MODEL_GATEWAY_API_KEY,
      url: process.env.MODEL_GATEWAY_BASE_URL,
      model: process.env.MODEL_GATEWAY_MODEL,
    };
    process.env.MODEL_GATEWAY_PROVIDER = "openai-compatible";
    process.env.MODEL_GATEWAY_API_KEY = "test-provider-key";
    process.env.MODEL_GATEWAY_BASE_URL = "https://llm.example.test/v1";
    process.env.MODEL_GATEWAY_MODEL = "provider-model";

    expect(createModelGateway()).toBeInstanceOf(LLMGateway);

    if (previous.provider !== undefined) process.env.MODEL_GATEWAY_PROVIDER = previous.provider;
    else delete process.env.MODEL_GATEWAY_PROVIDER;
    if (previous.key !== undefined) process.env.MODEL_GATEWAY_API_KEY = previous.key;
    else delete process.env.MODEL_GATEWAY_API_KEY;
    if (previous.url !== undefined) process.env.MODEL_GATEWAY_BASE_URL = previous.url;
    else delete process.env.MODEL_GATEWAY_BASE_URL;
    if (previous.model !== undefined) process.env.MODEL_GATEWAY_MODEL = previous.model;
    else delete process.env.MODEL_GATEWAY_MODEL;
  });
});

describe("LLMGateway streamConversationReply tool calling (Phase 4)", () => {
  // Builds a fake client whose `create` returns the supplied async iterables
  // one after the other (one stream request → one iterable).
  function buildStreamingClient(iterables: Array<AsyncIterable<unknown>>): {
    chat: {
      completions: {
        parse: () => Promise<unknown>;
        create: (req: Record<string, unknown>) => Promise<unknown>;
      };
    };
  } {
    const requests: Array<Record<string, unknown>> = [];
    return {
      chat: {
        completions: {
          parse: async () => ({ choices: [{ message: { parsed: null } }] }),
          create: async (req) => {
            requests.push(req);
            const next = iterables.shift();
            if (!next) throw new Error("Unexpected extra stream request");
            return next;
          },
        },
      },
      __requests: requests,
    } as unknown as {
      chat: {
        completions: {
          parse: () => Promise<unknown>;
          create: (req: Record<string, unknown>) => Promise<unknown>;
        };
      };
    };
  }

  async function* chunks(items: Array<unknown>): AsyncIterable<unknown> {
    for (const item of items) yield item;
  }

  it("dispatches `hotel.search` and re-streams the tool result into a follow-up turn", async () => {
    // Build a chunked JSON arguments string — fragments arrive across two
    // chunks exactly like a real OpenAI-compatible stream. The head ends
    // after the first property's value, and the tail starts with a comma
    // so the concatenated string parses as a single object.
    const argsHead = `${JSON.stringify({ cityCode: "TPE" }).slice(0, -1)},`; // {"cityCode":"TPE",
    const argsTail = JSON.stringify({
      checkIn: "2026-09-15",
      checkOut: "2026-09-20",
      occupancy: { adults: 3, rooms: 2 },
      currency: "CNY",
    }).slice(1); // ,"checkIn":...
    const fullArgs = `${argsHead}${argsTail}`;
    const firstChunks = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "hotel.search", arguments: argsHead } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argsTail } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    const secondChunks = [
      { choices: [{ delta: { content: "Hotel A " } }] },
      { choices: [{ delta: { content: "starts at CNY 800." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];
    const fakeClient = buildStreamingClient([
      chunks(firstChunks),
      chunks(secondChunks),
    ]);
    const dispatchTool = vi.fn().mockResolvedValue({
      outcome: "AVAILABLE",
      hotel: { propertyCount: 2, currency: "CNY", minNightlyPrice: 800, maxNightlyPrice: 1500 },
      draftHash: "abc",
      deduped: false,
    });
    const gateway = new LLMGateway({
      apiKey: "test",
      provider: "openai",
      modelName: "gpt-4o-mini",
      promptVersion: "1.0.0",
      ctx: createRequestContext(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: fakeClient as any,
      maxRetries: 0,
    });

    const deltas: string[] = [];
    const reply = await gateway.streamConversationReply!({
      question: "确认搜索",
      threadContext: [],
      onDelta: async (delta) => { deltas.push(delta); },
      tools: [{ name: "hotel.search", description: "stub", parameters: { type: "object" } }],
      dispatchTool,
    });
    void fullArgs;

    expect(reply.content).toBe("Hotel A starts at CNY 800.");
    expect(deltas).toEqual(["Hotel A ", "starts at CNY 800."]);
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(dispatchTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "hotel.search",
      arguments: expect.objectContaining({
        cityCode: "TPE",
        checkIn: "2026-09-15",
        checkOut: "2026-09-20",
        occupancy: { adults: 3, rooms: 2 },
        currency: "CNY",
      }),
    }));

    const reqs = (fakeClient as unknown as { __requests: Array<Record<string, unknown>> }).__requests;
    expect(reqs).toHaveLength(2);
    // First call: tool definition attached, no response_format.
    expect(reqs[0].tools).toEqual([{ type: "function", function: { name: "hotel.search", description: "stub", parameters: { type: "object" } } }]);
    expect(reqs[0]).not.toHaveProperty("response_format");
    // Second call: assistant(tool_calls) + tool(result) message shape.
    const messages = reqs[1].messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(4);
    expect(messages[2]).toMatchObject({
      role: "assistant",
      tool_calls: [expect.objectContaining({
        id: "call_1",
        function: expect.objectContaining({ name: "hotel.search" }),
      })],
    });
    expect(messages[3]).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
    });
    // The tool result is JSON-stringified by the gateway. Parse it back
    // to assert the bounded summary shape (NOT raw provider payload).
    expect(JSON.parse(messages[3].content as string)).toMatchObject({
      outcome: "AVAILABLE",
      hotel: expect.objectContaining({ currency: "CNY" }),
    });
    expect(messages[3].content).not.toContain("rateKey");
    expect(messages[3].content).not.toContain("secret");
  });

  it("flips markSent (no retry) when the first stream emits a tool call, then re-streams", async () => {
    const args = JSON.stringify({
      cityCode: "TPE",
      checkIn: "2026-09-15",
      checkOut: "2026-09-20",
      occupancy: { adults: 2, rooms: 1 },
      currency: "CNY",
    });
    const firstChunks = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_x", function: { name: "hotel.search", arguments: args } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    const secondChunks = [
      { choices: [{ delta: { content: "Grounded reply." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];
    const fakeClient = buildStreamingClient([chunks(firstChunks), chunks(secondChunks)]);
    const dispatchTool = vi.fn().mockResolvedValue({ outcome: "AVAILABLE", hotel: { currency: "CNY" } });
    const gateway = new LLMGateway({
      apiKey: "test",
      provider: "openai",
      modelName: "gpt-4o-mini",
      promptVersion: "1.0.0",
      ctx: createRequestContext(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: fakeClient as any,
      maxRetries: 0,
    });

    await gateway.streamConversationReply!({
      question: "确认搜索",
      threadContext: [],
      onDelta: async () => {},
      tools: [{ name: "hotel.search", description: "stub", parameters: { type: "object" } }],
      dispatchTool,
    });
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    const reqs = (fakeClient as unknown as { __requests: Array<Record<string, unknown>> }).__requests;
    expect(reqs).toHaveLength(2);
  });

  it("preserves Gemini thought-signature (extra_content.google) on the assistant tool message", async () => {
    const args = JSON.stringify({
      cityCode: "TPE",
      checkIn: "2026-09-15",
      checkOut: "2026-09-20",
      occupancy: { adults: 2, rooms: 1 },
      currency: "CNY",
    });
    const firstChunks = [
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_sig",
              function: { name: "hotel.search", arguments: args },
              extra_content: { google: { thought_signature: "sig_xyz" } },
            }],
          },
        }],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    const secondChunks = [
      { choices: [{ delta: { content: "Grounded." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];
    const fakeClient = buildStreamingClient([chunks(firstChunks), chunks(secondChunks)]);
    const dispatchTool = vi.fn().mockResolvedValue({ outcome: "AVAILABLE" });
    const gateway = new LLMGateway({
      apiKey: "test",
      provider: "openai",
      modelName: "gpt-4o-mini",
      promptVersion: "1.0.0",
      ctx: createRequestContext(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: fakeClient as any,
      maxRetries: 0,
    });

    await gateway.streamConversationReply!({
      question: "确认搜索",
      threadContext: [],
      onDelta: async () => {},
      tools: [{ name: "hotel.search", description: "stub", parameters: { type: "object" } }],
      dispatchTool,
    });
    const reqs = (fakeClient as unknown as { __requests: Array<Record<string, unknown>> }).__requests;
    const assistantMessage = (reqs[1].messages as Array<Record<string, unknown>>)[2];
    expect(assistantMessage).toMatchObject({
      role: "assistant",
      tool_calls: [expect.objectContaining({
        id: "call_sig",
        extra_content: { google: { thought_signature: "sig_xyz" } },
      })],
    });
  });

  it("dispatches a Gemini-compatible tool call even when it terminates with stop", async () => {
    const args = JSON.stringify({
      cityCode: "RMQ", checkIn: "2026-09-20", checkOut: "2026-09-25",
      occupancy: { adults: 3, rooms: 2 }, currency: "CNY",
    });
    const fakeClient = buildStreamingClient([
      chunks([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_stop", function: { name: "hotel.search", arguments: args } }] } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
      chunks([
        { choices: [{ delta: { content: "Grounded hotel result." } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    ]);
    const dispatchTool = vi.fn().mockResolvedValue({ outcome: "AVAILABLE" });
    const gateway = new LLMGateway({
      apiKey: "test", provider: "gemini", modelName: "gemini-test", promptVersion: "test",
      ctx: createRequestContext(), client: fakeClient, maxRetries: 0,
    });

    await expect(gateway.streamConversationReply!({
      question: "确认搜索", threadContext: [], onDelta: async () => {},
      tools: [{ name: "hotel.search", description: "stub", parameters: { type: "object" } }], dispatchTool,
    })).resolves.toMatchObject({ content: "Grounded hotel result." });
    expect(dispatchTool).toHaveBeenCalledOnce();
  });

  it("normalizes the legacy Gemini function_call stream envelope", async () => {
    const args = JSON.stringify({ cityCode: "RMQ" });
    const fakeClient = buildStreamingClient([
      chunks([{ choices: [{ delta: { function_call: { name: "hotel.search", arguments: args } } }] }]),
      chunks([
        { choices: [{ delta: { content: "Please confirm the saved query." } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    ]);
    const dispatchTool = vi.fn().mockResolvedValue({ outcome: "CONFIRMATION_REQUIRED" });
    const gateway = new LLMGateway({
      apiKey: "test", provider: "gemini", modelName: "gemini-test", promptVersion: "test",
      ctx: createRequestContext(), client: fakeClient, maxRetries: 0,
    });

    await gateway.streamConversationReply!({
      question: "CNY", threadContext: [], onDelta: async () => {},
      tools: [{ name: "hotel.search", description: "stub", parameters: { type: "object" } }], dispatchTool,
    });
    expect(dispatchTool).toHaveBeenCalledWith(expect.objectContaining({
      id: "legacy_function_call_0", name: "hotel.search", arguments: { cityCode: "RMQ" },
    }));
  });

  it("reports malformed streamed tool arguments as TOOL_PROTOCOL, never SCHEMA_PARSE", async () => {
    const fakeClient = buildStreamingClient([chunks([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_bad", function: { name: "hotel.search", arguments: "{" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ])]);
    const gateway = new LLMGateway({
      apiKey: "test", provider: "gemini", modelName: "gemini-test", promptVersion: "test",
      ctx: createRequestContext(), client: fakeClient, maxRetries: 0,
    });

    await expect(gateway.streamConversationReply!({
      question: "确认搜索", threadContext: [], onDelta: async () => {},
      tools: [{ name: "hotel.search", description: "stub", parameters: { type: "object" } }],
      dispatchTool: vi.fn(),
    })).rejects.toMatchObject({ code: "TOOL_PROTOCOL" });
  });

  it("falls through to the prose-only path when no tools are registered", async () => {
    const fakeClient = buildStreamingClient([chunks([
      { choices: [{ delta: { content: "Hello." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ])]);
    const dispatchTool = vi.fn();
    const gateway = new LLMGateway({
      apiKey: "test",
      provider: "openai",
      modelName: "gpt-4o-mini",
      promptVersion: "1.0.0",
      ctx: createRequestContext(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: fakeClient as any,
      maxRetries: 0,
    });

    const reply = await gateway.streamConversationReply!({
      question: "Hi",
      threadContext: [],
      onDelta: async () => {},
      // tools undefined — byte-identical to the prose-only path.
      dispatchTool,
    });
    expect(reply.content).toBe("Hello.");
    expect(dispatchTool).not.toHaveBeenCalled();
    const reqs = (fakeClient as unknown as { __requests: Array<Record<string, unknown>> }).__requests;
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).not.toHaveProperty("tools");
  });
});
