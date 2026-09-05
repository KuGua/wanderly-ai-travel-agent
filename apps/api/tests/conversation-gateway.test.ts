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
    const messages = create.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("User-visible language (higher priority than history)");
    expect(messages[0]?.content.match(/User-visible language \(higher priority than history\)/g)).toHaveLength(1);
    expect(messages[0]?.content).toContain("If the traveller explicitly requests a translation or another language");
    expect(messages[0]?.content).toContain("`threadContext`, `memoryContext`, destination country, and provider evidence");
    expect(messages[0]?.content).toContain("单独的城市名默认表示查看详情");
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
    const messages = parse.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("User-visible language (higher priority than history)");
    expect(messages[0]?.content.match(/User-visible language \(higher priority than history\)/g)).toHaveLength(1);
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
    expect(messages[0]?.content).toContain("当前住宿条件确认后会纳入完整行程方案");
    expect(messages[0]?.content).toContain("不要把这句话说成单独酒店搜索的推广");
    expect(messages[0]?.content).not.toContain("Shared Agent");
    expect(messages[1]?.content).not.toContain("HOTEL_SEARCH_READINESS");
  });

  it("asks for a city when the selected map place is a country", async () => {
    const parse = vi.fn().mockResolvedValue({
      choices: [{ message: {
        parsed: null,
        content: JSON.stringify({ reply: { content: "你想先去法国哪座城市？" } }),
      } }],
    });
    const gateway = buildGateway({ chat: { completions: { parse } } });

    await gateway.generateConversationReply({
      question: "法国",
      threadContext: [],
      responseConstraints: ["DESTINATION_CITY_REQUIRED"],
    });

    const messages = parse.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages[0]?.content).toContain("目的地澄清约束");
    expect(messages[0]?.content).toContain("不得默认首都");
    expect(messages[1]?.content).not.toContain("DESTINATION_CITY_REQUIRED");
  });

  it("positions complete trip orchestration as the primary conversation goal", async () => {
    const parse = vi.fn().mockResolvedValue({
      choices: [{ message: {
        parsed: null,
        content: JSON.stringify({ reply: { content: "我可以帮你逐步规划这次旅行。" } }),
      } }],
    });
    const gateway = buildGateway({ chat: { completions: { parse } } });

    await gateway.generateConversationReply({
      question: "帮我规划一次旅行",
      threadContext: [],
    });

    const messages = parse.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("澄清、归纳并确认本人的旅行意图与约束");
    expect(messages[0]?.content).toContain("完整行程编排优先级");
    expect(messages[0]?.content).toContain("不得把单独搜索包装成推荐路径");
    expect(messages[0]?.content).toContain("不要生成 Day 1–N");
    expect(messages[0]?.content).toContain("prompt 后注入的 DRAFT handoff 块是这里唯一权威信号");
    expect(messages[0]?.content).toContain("canStartSharedPlanning=true 才允许引导用户点击");
    expect(messages[0]?.content).not.toContain("Shared Agent");
    expect(messages[0]?.content).toContain("不得声称已经完成预订、支付、实时查询或任何外部操作");
    expect(messages[0]?.content).toContain("目的地介绍和一般旅行问答是辅助用户探索与决策的能力");
  });

  it("keeps internal orchestration names out of a flight-tool request", async () => {
    const parse = vi.fn().mockResolvedValue({
      choices: [{ message: {
        parsed: null,
        content: JSON.stringify({ reply: { content: "请告诉我出发日期。" } }),
      } }],
    });
    const gateway = buildGateway({ chat: { completions: { parse } } });

    await gateway.generateConversationReply({
      question: "帮我找上海到台北的航班",
      threadContext: [],
      responseConstraints: ["FLIGHT_SEARCH_READINESS"],
    });

    const messages = parse.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("当前航班条件确认后会纳入完整行程方案");
    expect(messages[0]?.content).toContain("不要把这句话说成单独机票搜索的推广");
    expect(messages[0]?.content).not.toContain("Shared Agent");
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

describe("a call aborted by our own deadline", () => {
  /** The shape the OpenAI SDK actually raises: a plain Error, not an AbortError. */
  function sdkAbortError() {
    const error = new Error("Request was aborted.");
    error.name = "Error";
    return error;
  }

  it("is reported as TIMEOUT and is not retried", async () => {
    // Regression for a turn cut by `createTurnDeadline`: the SDK hides the
    // abort behind its own Error, so the failure used to be classified
    // UPSTREAM_FAILURE — blaming the provider for our own budget — and then
    // retried three more times against the same settled signal.
    const controller = new AbortController();
    const parse = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw sdkAbortError();
    });
    const gateway = new LLMGateway({
      apiKey: "test-key", provider: "openai", modelName: "test-model",
      promptVersion: "chat-test-v1", ctx: createRequestContext(),
      client: { chat: { completions: { parse } } }, maxRetries: 3,
    });

    await expect(gateway.generateConversationReply({
      question: "Tell me about Tokyo",
      threadContext: [],
      signal: controller.signal,
    })).resolves.toMatchObject({ responseMode: "FALLBACK" });

    expect(parse).toHaveBeenCalledTimes(1);
    expect(recordAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      status: "TIMEOUT",
      errorCode: "TIMEOUT",
    }));
  });

  it("is reported as TIMEOUT on the streaming path too", async () => {
    const controller = new AbortController();
    const create = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw sdkAbortError();
    });
    const gateway = new LLMGateway({
      apiKey: "test-key", provider: "openai", modelName: "test-model",
      promptVersion: "chat-test-v1", ctx: createRequestContext(),
      client: { chat: { completions: { create } } }, maxRetries: 3,
    });

    await expect(gateway.streamConversationReply({
      question: "Tell me about Tokyo",
      threadContext: [],
      onDelta: () => {},
      signal: controller.signal,
    })).resolves.toMatchObject({ responseMode: "FALLBACK" });

    expect(create).toHaveBeenCalledTimes(1);
    expect(recordAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      status: "TIMEOUT",
      errorCode: "TIMEOUT",
    }));
  });

  it("classifies an SDK abort as TIMEOUT even with no signal in scope", async () => {
    // Backstop in `classifyError` for call sites that pass no signal.
    const parse = vi.fn().mockRejectedValue(sdkAbortError());
    const gateway = buildGateway({ chat: { completions: { parse } } });

    await expect(gateway.generateConversationReply({
      question: "Tell me about Tokyo",
      threadContext: [],
    })).resolves.toMatchObject({ responseMode: "FALLBACK" });

    expect(recordAgentRun).toHaveBeenCalledWith(expect.objectContaining({
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
