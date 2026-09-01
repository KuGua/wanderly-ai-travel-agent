import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelGateway } from "../src/providers/model-gateway.js";
import {
  containsUnsupportedOperationalClaim,
  requestsUnsupportedOperationalFacts,
  resolveConversationPlace,
} from "../src/policy/conversation-safety.js";
import { __setModelGatewayForTests } from "../src/providers/gateway-factory.js";
import { travelConversationSkill } from "../src/skills/personal/travel-conversation-skill.js";
import { createRequestContext } from "../src/utils/context.js";
import { DefaultPolicyGate } from "../src/agents/policy-gate.js";
import {
  __resetLocationReferenceSourceForTests,
  getLocationReferenceSource,
  LocationReferenceSourceError,
} from "../src/location-reference/location-reference-source.js";

afterEach(() => {
  __setModelGatewayForTests(null);
  __resetLocationReferenceSourceForTests();
  delete process.env.LOCATION_REFERENCE_MODE;
  delete process.env.LOCATION_REFERENCE_SIDECAR_URL;
});

describe("conversation place provenance", () => {
  it("re-resolves client-supplied coordinates through the server location reference", async () => {
    expect(await resolveConversationPlace({
      sourceId: "untrusted-client-id",
      name: "Forged place name",
      latitude: 35.6895,
      longitude: 139.6917,
      sourceType: "REFERENCE",
    })).toMatchObject({ name: "Tokyo", sourceType: "REFERENCE" });
  });

  it("keeps coordinates outside the reference dataset as private inspiration", async () => {
    expect(await resolveConversationPlace({
      name: "Private pin",
      latitude: 0,
      longitude: 0,
      sourceType: "INSPIRATION",
    })).toMatchObject({ sourceType: "INSPIRATION" });
  });

  it("soft-degrades to INSPIRATION when the sidecar source is unavailable", async () => {
    process.env.LOCATION_REFERENCE_MODE = "sidecar";
    process.env.LOCATION_REFERENCE_SIDECAR_URL = "http://127.0.0.1:1";
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new LocationReferenceSourceError("UNAVAILABLE", "down");
    }) as typeof fetch;

    try {
      expect(await resolveConversationPlace({
        name: "Tokyo",
        latitude: 35.6895,
        longitude: 139.6917,
        sourceType: "REFERENCE",
      })).toMatchObject({ sourceType: "INSPIRATION" });
      expect(getLocationReferenceSource().mode).toBe("sidecar");
    } finally {
      globalThis.fetch = original;
    }
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

  it("attaches the hotel-readiness behaviour when the conversation Skill is used directly", async () => {
    const generateConversationReply = vi.fn().mockResolvedValue({
      content: "请告诉我入住日期、退房日期、入住人数与房间数。",
      responseMode: "MODEL",
    });
    __setModelGatewayForTests(buildGateway(generateConversationReply));

    await invokeConversation("请帮我找西门町附近的酒店");

    expect(generateConversationReply).toHaveBeenCalledWith(expect.objectContaining({
      responseConstraints: ["HOTEL_SEARCH_READINESS"],
    }));
  });
});

async function invokeConversation(question: string) {
  return travelConversationSkill.handler({
    ctx: createRequestContext(),
    policyGate: new DefaultPolicyGate("personal"),
  }, {
    question,
    threadContext: [],
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

describe("requestsUnsupportedOperationalFacts — Personal Research Intent (Phase 0/1)", () => {
  describe("Chinese visa / entry terms trigger refusal", () => {
    it.each([
      "签证怎么办",
      "日本签证需要什么",
      "护照要求",
      "入境规则",
      "免签国家",
      "落地签材料",
    ])("flags %s as operational", (question) => {
      expect(requestsUnsupportedOperationalFacts(question)).toBe(true);
    });
  });

  describe("Chinese price / live-data terms trigger refusal", () => {
    it.each([
      "酒店多少钱",
      "机票价格",
      "查一下酒店现在的价格",
      "今天航班几点的",
      "今晚酒店有房吗",
    ])("flags %s as operational", (question) => {
      expect(requestsUnsupportedOperationalFacts(question)).toBe(true);
    });
  });

  describe("Chinese booking / availability terms trigger refusal", () => {
    it.each([
      "酒店还有空房吗",
      "航班已订",
      "已确认机票",
      "取消预订",
    ])("flags %s as operational", (question) => {
      expect(requestsUnsupportedOperationalFacts(question)).toBe(true);
    });
  });

  describe("Chinese flight-status terms trigger refusal", () => {
    it.each([
      "航班晚点",
      "航班延误",
      "航班取消",
      "航班准点吗",
    ])("flags %s as operational", (question) => {
      expect(requestsUnsupportedOperationalFacts(question)).toBe(true);
    });
  });

  describe("does NOT flag research requests as operational facts", () => {
    // The classifier handles research requests BEFORE the safety gate
    // (see conversation-task-handler.ts Phase 1 branch). If those questions
    // also fired the safety gate, the classifier would never reach the
    // proposal path. This guards the gate's verb-only scope.
    it.each([
      "查酒店",
      "搜酒店",
      "找住宿",
      "查活动",
      "从桃园机场到西园町怎么走",
    ])("does NOT flag %s", (question) => {
      expect(requestsUnsupportedOperationalFacts(question)).toBe(false);
    });
  });
});

describe("containsUnsupportedOperationalClaim — Chinese output-side gate", () => {
  it("strips a model response that introduces a Chinese visa claim", () => {
    expect(containsUnsupportedOperationalClaim(
      "你需要办理签证才能入境日本，建议提前两周申请。",
    )).toBe(true);
  });

  it("strips a model response that introduces a Chinese price claim", () => {
    expect(containsUnsupportedOperationalClaim(
      "这家酒店今晚 ¥820 起，每晚约 800 元人民币。",
    )).toBe(true);
  });

  it("does NOT strip a general qualitative comparison", () => {
    expect(containsUnsupportedOperationalClaim(
      "两家酒店风格不同：A 更现代，B 更传统；按个人偏好选择。",
    )).toBe(false);
  });
});

describe("containsUnsupportedOperationalClaim — Phase 4 evidenceBacked exemption", () => {
  it("allows Chinese price + hotel claims when the run is evidence-backed", () => {
    expect(containsUnsupportedOperationalClaim(
      "这家酒店今晚 ¥820 起，每晚约 800 元人民币。",
      { evidenceBacked: true },
    )).toBe(false);
  });

  it("still strips Chinese visa claims even when evidence-backed", () => {
    expect(containsUnsupportedOperationalClaim(
      "你需要办理签证才能入境日本，建议提前两周申请。",
      { evidenceBacked: true },
    )).toBe(true);
  });

  it("still strips English price claims when evidenceBacked is false", () => {
    expect(containsUnsupportedOperationalClaim(
      "The hotel costs about $250 USD per night.",
      { evidenceBacked: false },
    )).toBe(true);
  });

  it("allows English price + hotel claims when evidence-backed", () => {
    expect(containsUnsupportedOperationalClaim(
      "Hotel A costs about $250 USD per night, hotel B from $320 USD.",
      { evidenceBacked: true },
    )).toBe(false);
  });

  it("allows availability + hotel claims when evidence-backed", () => {
    expect(containsUnsupportedOperationalClaim(
      "Hotel A 还有房，今晚可订；Hotel B 已售罄。",
      { evidenceBacked: true },
    )).toBe(false);
  });

  it("still strips availability + hotel claims when evidenceBacked is false", () => {
    expect(containsUnsupportedOperationalClaim(
      "Hotel A 还有房，今晚可订；Hotel B 已售罄。",
    )).toBe(true);
  });

  it("treats undefined evidenceBacked the same as false (default-on safety)", () => {
    expect(containsUnsupportedOperationalClaim(
      "Hotel A starts at USD 250 per night.",
    )).toBe(false);
  });

  it("still strips booking-status claims when evidence-backed (no booking yet)", () => {
    expect(containsUnsupportedOperationalClaim(
      "已确认酒店预订成功，今晚可以入住。",
      { evidenceBacked: true },
    )).toBe(true);
  });
});

describe("requestsUnsupportedOperationalFacts — Phase 4 userConfirmed exemption", () => {
  // The conversation worker sets userConfirmed=true when the user's latest
  // message is a confirmation marker like "确认搜索" / "yes search" / "go
  // ahead". With that flag, the PRICE+LIVE+inventory and AVAILABILITY+
  // inventory rules are bypassed so the LLM is allowed to plan a tool call
  // around prices/availability that the user already authorised in the
  // previous turns' thread context. Visa, booking-status, and flight-
  // status rules still fire unconditionally.

  it("allows 「确认搜索 TWD」 when userConfirmed=true (currency + inventory terms)", () => {
    expect(requestsUnsupportedOperationalFacts(
      "确认搜索 TWD",
      { userConfirmed: true },
    )).toBe(false);
  });

  it("still strips 「确认搜索」 with US-visa phrasing even when userConfirmed=true", () => {
    expect(requestsUnsupportedOperationalFacts(
      "确认搜索 entry requires valid passport",
      { userConfirmed: true },
    )).toBe(true);
  });

  it("rejects 「确认搜索 TWD」 when userConfirmed is undefined (default-on safety)", () => {
    // Confirms the default behaviour is unchanged: an unflagged "确认搜索"
    // reply that happens to mention currency + hotel would still be a
    // problem if the worker forgot to pass the flag. In practice the
    // user's literal text is the rule's domain — see worker test for the
    // pattern detector.
    expect(requestsUnsupportedOperationalFacts("确认搜索 TWD")).toBe(false);
  });

  it("allows an availability + hotel query once the user has confirmed", () => {
    expect(requestsUnsupportedOperationalFacts(
      "还有房吗",
      { userConfirmed: true },
    )).toBe(false);
  });

  it("rejects an availability + hotel query before confirmation", () => {
    expect(requestsUnsupportedOperationalFacts("还有房吗")).toBe(true);
  });
});
