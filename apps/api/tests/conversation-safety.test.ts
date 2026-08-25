import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelGateway } from "../src/providers/model-gateway.js";
import {
  resolveConversationPlace,
} from "../src/policy/conversation-safety.js";
import { __setModelGatewayForTests } from "../src/providers/gateway-factory.js";
import { travelConversationSkill } from "../src/skills/personal/travel-conversation-skill.js";
import { createRequestContext } from "../src/utils/context.js";
import { DefaultPolicyGate } from "../src/agents/policy-gate.js";

afterEach(() => {
  __setModelGatewayForTests(null);
});

describe("conversation place provenance", () => {
  it("re-resolves client-supplied coordinates through the server location reference", () => {
    expect(resolveConversationPlace({
      sourceId: "untrusted-client-id",
      name: "Forged place name",
      latitude: 35.6895,
      longitude: 139.6917,
      sourceType: "REFERENCE",
    })).toMatchObject({ name: "Tokyo", sourceType: "REFERENCE" });
  });

  it("keeps coordinates outside the reference dataset as private inspiration", () => {
    expect(resolveConversationPlace({
      name: "Private pin",
      latitude: 0,
      longitude: 0,
      sourceType: "INSPIRATION",
    })).toMatchObject({ sourceType: "INSPIRATION" });
  });
});

describe("conversation operational fact boundary", () => {
  it.each([
    ["visa ordinary phrasing", "What visa do Chinese citizens need for Japan?"],
    ["visa direct phrasing", "Do Chinese citizens need a visa for Japan?"],
    ["entry conclusion", "Can I enter Japan without a visa?"],
    ["live price", "How much is a flight to Tokyo right now?"],
    ["inventory", "Are there hotel rooms available tonight?"],
    ["booking", "Can I book this hotel now?"],
    ["flight status", "Is flight SQ12 delayed?"],
    ["plural visa", "Which visas are required for Japan?"],
    ["implicit inventory", "Are there seats on SQ12?"],
    ["ordinary flight-status wording", "Is SQ12 late?"],
  ])("returns a deterministic SAFE_REFUSAL before calling the model for a %s question", async (_label, question) => {
    const generateConversationReply = vi.fn();
    __setModelGatewayForTests(buildGateway(generateConversationReply));

    const result = await invokeConversation(question);

    expect(result.responseMode).toBe("SAFE_REFUSAL");
    expect(result.content).toContain("cannot verify current prices");
    expect(generateConversationReply).not.toHaveBeenCalled();
  });

  it.each([
    ["visa", "Japan requires Chinese tourists to obtain a visa."],
    ["live price", "The flight currently costs $820."],
    ["inventory", "There are rooms available tonight."],
    ["booking", "Your booking is confirmed."],
    ["flight status", "SQ12 is delayed by 45 minutes."],
    ["visa paraphrase", "Chinese citizens have to get a visa."],
    ["bare numeric fare", "The current fare is 820."],
  ])("replaces an unsupported %s model claim with a deterministic SAFE_REFUSAL", async (_label, unsafeContent) => {
    const generateConversationReply = vi.fn().mockResolvedValue({
      content: unsafeContent,
      responseMode: "MODEL",
    });
    __setModelGatewayForTests(buildGateway(generateConversationReply));

    const result = await invokeConversation("Tell me about Tokyo");

    expect(generateConversationReply).toHaveBeenCalledOnce();
    expect(result.responseMode).toBe("SAFE_REFUSAL");
    expect(result.content).not.toBe(unsafeContent);
  });

  it.each([
    "Tell me about Tokyo.",
    "What is Tokyo known for?",
    "What neighborhoods are interesting for art and food?",
    "Would Tokyo or Lisbon feel more relaxed?",
  ])("allows an ordinary destination-inspiration model answer: %s", async question => {
    const generateConversationReply = vi.fn().mockResolvedValue({
      content: "Tokyo is known for distinct neighborhoods, food culture, design, and museums.",
      responseMode: "MODEL",
    });
    __setModelGatewayForTests(buildGateway(generateConversationReply));

    await expect(invokeConversation(question)).resolves.toEqual({
      content: "Tokyo is known for distinct neighborhoods, food culture, design, and museums.",
      responseMode: "MODEL",
    });
    expect(generateConversationReply).toHaveBeenCalledOnce();
  });
});

async function invokeConversation(question: string) {
  return travelConversationSkill.handler({
    ctx: createRequestContext(),
    policyGate: new DefaultPolicyGate("personal"),
  }, {
    question,
    history: [],
  }, new AbortController().signal);
}

function buildGateway(generateConversationReply: ReturnType<typeof vi.fn>): ModelGateway {
  return {
    generateConversationReply,
    async generateStructuredPlan() {
      throw new Error("not used");
    },
    async explainPlanDiff() {
      throw new Error("not used");
    },
  };
}
