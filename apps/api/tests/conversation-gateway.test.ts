import { beforeEach, describe, expect, it, vi } from "vitest";

const recordAgentRun = vi.hoisted(() => vi.fn());
vi.mock("../src/observability/agent-runs.js", () => ({ recordAgentRun }));

import { LLMGateway } from "../src/providers/llm-gateway.js";
import { MockModelGateway } from "../src/providers/model-gateway.js";
import { createRequestContext } from "../src/utils/context.js";

beforeEach(() => {
  recordAgentRun.mockReset();
});

describe("conversational ModelGateway", () => {
  it("returns deterministic, place-aware demo fallback from MockModelGateway", async () => {
    const gateway = new MockModelGateway();
    const result = await gateway.generateConversationReply({
      question: "What is this place?",
      place: {
        sourceId: "pin-1",
        name: "Pinned place 1",
        latitude: 35.69,
        longitude: 139.692,
        sourceType: "INSPIRATION",
      },
      history: [],
    });

    expect(result.responseMode).toBe("DEMO_FALLBACK");
    expect(result.content).toContain("unverified inspiration");
    expect(result.content).toContain("does not claim live prices");
  });

  it("validates and returns a structured live-model reply", async () => {
    const client = {
      beta: { chat: { completions: { parse: vi.fn().mockResolvedValue({
        choices: [{ message: { parsed: { reply: { content: "A bounded model answer." } } } }],
        usage: { prompt: 10, completion: 5, total: 15 },
      }) } } },
    };
    const gateway = buildGateway(client);

    await expect(gateway.generateConversationReply({
      question: "Tell me about Tokyo",
      history: [],
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
  });

  it("uses an explicit deterministic fallback when model output is malformed", async () => {
    const client = {
      beta: { chat: { completions: { parse: vi.fn().mockResolvedValue({
        choices: [{ message: { parsed: { unexpected: true } } }],
      }) } } },
    };
    const gateway = buildGateway(client);

    const result = await gateway.generateConversationReply({
      question: "Tell me about Tokyo",
      place: {
        sourceId: "tokyo",
        name: "Tokyo",
        latitude: 35.6895,
        longitude: 139.6917,
        sourceType: "FIXTURE",
      },
      history: [],
    });

    expect(result.responseMode).toBe("DEMO_FALLBACK");
    expect(result.content).toContain("fixture-backed demo destination");
    expect(recordAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      skillName: "travel.conversation",
      status: "FALLBACK",
      errorCode: "SCHEMA_PARSE",
    }));
  });
});

function buildGateway(client: unknown) {
  return new LLMGateway({
    apiKey: "test-key",
    provider: "openai",
    modelName: "test-model",
    promptVersion: "chat-test-v1",
    mock: new MockModelGateway(),
    ctx: createRequestContext(),
    client,
    maxRetries: 0,
  });
}
