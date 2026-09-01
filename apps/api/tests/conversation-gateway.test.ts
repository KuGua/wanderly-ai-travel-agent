import { beforeEach, describe, expect, it, vi } from "vitest";

const recordAgentRun = vi.hoisted(() => vi.fn());
vi.mock("../src/observability/agent-runs.js", () => ({ recordAgentRun }));

import { LLMGateway } from "../src/providers/llm-gateway.js";
import { createRequestContext } from "../src/utils/context.js";

beforeEach(() => {
  recordAgentRun.mockReset();
});

describe("conversational ModelGateway", () => {
  it("streams OpenAI-compatible deltas in order and records only safe telemetry", async () => {
    const create = vi.fn().mockResolvedValue((async function* () {
      yield { choices: [{ delta: { content: "A bounded " } }] };
      yield {
        choices: [{ delta: { content: "streamed answer." } }],
        usage: { prompt: 10, completion: 4, total: 14 },
      };
    })());
    const gateway = buildGateway({ chat: { completions: { create } } });
    const deltas: string[] = [];

    await expect(gateway.streamConversationReply!({
      question: "Tell me about Tokyo",
      threadContext: [],
      onDelta: async (delta) => { deltas.push(delta); },
    })).resolves.toEqual({ content: "A bounded streamed answer.", responseMode: "MODEL" });

    expect(deltas).toEqual(["A bounded ", "streamed answer."]);
    expect(create.mock.calls[0][0]).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(recordAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      skillName: "travel.conversation",
      status: "SUCCESS",
      tokens: { prompt: 10, completion: 4, total: 14 },
    }));
    expect(JSON.stringify(recordAgentRun.mock.calls)).not.toContain("Tell me about Tokyo");
    expect(JSON.stringify(recordAgentRun.mock.calls)).not.toContain("streamed answer");
  });

  it("validates and returns a structured real-model reply", async () => {
    const parse = vi.fn().mockResolvedValue({
      choices: [{ message: {
        parsed: null,
        content: JSON.stringify({ reply: { content: "A bounded model answer." } }),
      } }],
      usage: { prompt: 10, completion: 5, total: 15 },
    });
    const client = {
      chat: { completions: { parse } },
    };
    const gateway = buildGateway(client);

    await expect(gateway.generateConversationReply({
      question: "Tell me about Tokyo",
      threadContext: [],
    })).resolves.toEqual({
      content: "A bounded model answer.",
      responseMode: "MODEL",
    });
    expect(recordAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      skillName: "travel.conversation",
      agentName: "personal",
      status: "SUCCESS",
    }));
    expect(JSON.stringify(recordAgentRun.mock.calls)).not.toContain("Tell me about Tokyo");
    expect(JSON.stringify(recordAgentRun.mock.calls)).not.toContain("A bounded model answer.");
    expect(parse.mock.calls[0][0]).not.toHaveProperty("signal");
    expect(parse.mock.calls[0][1]).toHaveProperty("signal");
  });

  it("adds Skill-selected hotel readiness guidance without placing it in user content", async () => {
    const parse = vi.fn().mockResolvedValue({
      choices: [{ message: {
        parsed: null,
        content: JSON.stringify({ reply: { content: "请告诉我入住日期。" } }),
      } }],
    });
    const gateway = buildGateway({ chat: { completions: { parse } } });

    await gateway.generateConversationReply({
      question: "请帮我找西门町附近的酒店",
      threadContext: [],
      responseConstraints: ["HOTEL_SEARCH_READINESS"],
    });

    const messages = parse.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages[0]?.content).toContain("住宿/酒店搜索约束");
    expect(messages[1]?.content).not.toContain("HOTEL_SEARCH_READINESS");
  });

  it("normalizes Gemini's root-level content response", async () => {
    const client = {
      chat: { completions: { parse: vi.fn().mockResolvedValue({
        choices: [{ message: {
          parsed: null,
          content: JSON.stringify({ content: "A Gemini-compatible answer." }),
        } }],
      }) } },
    };
    const gateway = new LLMGateway({
      apiKey: "test-key",
      provider: "gemini",
      modelName: "gemini-test-model",
      promptVersion: "chat-test-v1",
      ctx: createRequestContext(),
      client,
      maxRetries: 0,
    });

    await expect(gateway.generateConversationReply({
      question: "Tell me about Tokyo",
      threadContext: [],
    })).resolves.toEqual({
      content: "A Gemini-compatible answer.",
      responseMode: "MODEL",
    });
  });

  it("returns a FALLBACK reply when the model produces malformed output instead of synthesizing one", async () => {
    const client = {
      chat: { completions: { parse: vi.fn().mockResolvedValue({
        choices: [{ message: { parsed: { unexpected: true } } }],
      }) } },
    };
    const gateway = buildGateway(client);

    await expect(gateway.generateConversationReply({
      question: "Tell me about Tokyo",
      threadContext: [],
    })).resolves.toMatchObject({
      responseMode: "FALLBACK",
    });
    expect(recordAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      skillName: "travel.conversation",
      status: "ERROR",
      errorCode: "SCHEMA_PARSE",
    }));
  });

  it("returns a FALLBACK reply on timeout without throwing — the SSE channel closes cleanly", async () => {
    const aborted = new Error("request aborted");
    aborted.name = "AbortError";
    const client = {
      chat: { completions: { parse: vi.fn().mockRejectedValue(aborted) } },
    };
    const gateway = buildGateway(client);

    await expect(gateway.generateConversationReply({
      question: "Tell me about Tokyo",
      threadContext: [],
    })).resolves.toMatchObject({
      responseMode: "FALLBACK",
    });
    expect(recordAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      status: "TIMEOUT",
      errorCode: "TIMEOUT",
    }));
  });
});

function buildGateway(client: unknown) {
  return new LLMGateway({
    apiKey: "test-key",
    provider: "openai",
    modelName: "test-model",
    promptVersion: "chat-test-v1",
    ctx: createRequestContext(),
    client,
    maxRetries: 0,
  });
}
