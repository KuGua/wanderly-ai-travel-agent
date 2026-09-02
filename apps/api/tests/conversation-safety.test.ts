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

// The price/live-data/inventory/availability gate was removed (demo-scope
// simplification): the model may now state prices, fares and availability
// in prose without a same-turn tool dispatch backing it. Visa/entry,
// booking-status and flight-status rules still fire unconditionally — they
// were never part of that removed gate.
describe("conversation operational fact boundary", () => {
  it.each([
    ["visa ordinary phrasing", "What visa do Chinese citizens need for Japan?"],
    ["visa direct phrasing", "Do Chinese citizens need a visa for Japan?"],
    ["entry conclusion", "Can I enter Japan without a visa?"],
    ["booking", "Can I book this hotel now?"],
    ["flight status", "Is flight SQ12 delayed?"],
    ["plural visa", "Which visas are required for Japan?"],
    ["ordinary flight-status wording", "Is SQ12 late?"],
  ])("returns a deterministic SAFE_REFUSAL before calling the model for a %s question", async (_label, question) => {
    const generateConversationReply = vi.fn();
    __setModelGatewayForTests(buildGateway(generateConversationReply));

    const result = await invokeConversation(question);

    expect(result.responseMode).toBe("SAFE_REFUSAL");
    expect(result.content).toContain("cannot claim live prices");
    expect(generateConversationReply).not.toHaveBeenCalled();
  });

  it("localizes a Chinese SAFE_REFUSAL without exposing internal role names", async () => {
    const generateConversationReply = vi.fn();
    __setModelGatewayForTests(buildGateway(generateConversationReply));

    const result = await invokeConversation("日本签证需要什么？");

    expect(result).toMatchObject({ responseMode: "SAFE_REFUSAL" });
    expect(result.content).toContain("确认行程信息后即可");
    expect(result.content).not.toContain("Agent");
    expect(result.content).toContain("查询条件已收到");
    expect(generateConversationReply).not.toHaveBeenCalled();
  });

  it.each([
    ["live price", "How much is a flight to Tokyo right now?"],
    ["inventory", "Are there hotel rooms available tonight?"],
    ["implicit inventory", "Are there seats on SQ12?"],
  ])("no longer refuses a %s question before calling the model", async (_label, question) => {
    const generateConversationReply = vi.fn().mockResolvedValue({
      content: "Here's some general context.",
      responseMode: "MODEL",
    });
    __setModelGatewayForTests(buildGateway(generateConversationReply));

    const result = await invokeConversation(question);

    expect(generateConversationReply).toHaveBeenCalledOnce();
    expect(result.responseMode).toBe("MODEL");
  });

  it.each([
    ["visa", "Japan requires Chinese tourists to obtain a visa."],
    ["flight status", "SQ12 is delayed by 45 minutes."],
    ["visa paraphrase", "Chinese citizens have to get a visa."],
    ["booking status", "Your booking is confirmed."],
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
    ["live price", "The flight currently costs $820."],
    ["inventory", "There are rooms available tonight."],
    ["bare numeric fare", "The current fare is 820."],
  ])("no longer replaces a %s model claim with a SAFE_REFUSAL", async (_label, content) => {
    const generateConversationReply = vi.fn().mockResolvedValue({
      content,
      responseMode: "MODEL",
    });
    __setModelGatewayForTests(buildGateway(generateConversationReply));

    const result = await invokeConversation("Tell me about Tokyo");

    expect(result.responseMode).toBe("MODEL");
    expect(result.content).toBe(content);
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
      responseConstraints: ["HOTEL_SEARCH_READINESS", "FLIGHT_SEARCH_READINESS"],
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

  describe("Chinese price / live-data / plain-availability terms no longer trigger refusal", () => {
    it.each([
      "酒店多少钱",
      "机票价格",
      "查一下酒店现在的价格",
      "今天航班几点的",
      "今晚酒店有房吗",
      "酒店还有空房吗",
    ])("does NOT flag %s", (question) => {
      expect(requestsUnsupportedOperationalFacts(question)).toBe(false);
    });
  });

  describe("Chinese booking-status terms still trigger refusal", () => {
    it.each([
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

  it("no longer strips a model response that introduces a Chinese price claim", () => {
    expect(containsUnsupportedOperationalClaim(
      "这家酒店今晚 ¥820 起，每晚约 800 元人民币。",
    )).toBe(false);
  });

  it("does NOT strip a general qualitative comparison", () => {
    expect(containsUnsupportedOperationalClaim(
      "两家酒店风格不同：A 更现代，B 更传统；按个人偏好选择。",
    )).toBe(false);
  });
});

// `evidenceBacked` no longer gates price/availability (that check was
// removed outright) but it still narrowly gates the cancellation-policy
// carve-out on the booking-status check: only an evidence-backed reply may
// describe a supplier's own cancellation terms without being read as a
// claim about the traveller's own reservation. `userConfirmed` remains a
// full no-op — nothing left consults it.
describe("containsUnsupportedOperationalClaim — evidenceBacked", () => {
  it("allows Chinese price + hotel claims regardless of evidenceBacked", () => {
    expect(containsUnsupportedOperationalClaim(
      "这家酒店今晚 ¥820 起，每晚约 800 元人民币。",
      { evidenceBacked: false },
    )).toBe(false);
  });

  it("still strips Chinese visa claims even when evidence-backed", () => {
    expect(containsUnsupportedOperationalClaim(
      "你需要办理签证才能入境日本，建议提前两周申请。",
      { evidenceBacked: true },
    )).toBe(true);
  });

  it("allows English price + hotel claims regardless of evidenceBacked", () => {
    expect(containsUnsupportedOperationalClaim(
      "Hotel A costs about $250 USD per night, hotel B from $320 USD.",
    )).toBe(false);
  });

  it("allows availability + hotel claims regardless of evidenceBacked", () => {
    expect(containsUnsupportedOperationalClaim(
      "Hotel A 还有房，今晚可订；Hotel B 已售罄。",
    )).toBe(false);
  });

  it("still strips a Chinese booking-status claim about the traveller's own reservation", () => {
    expect(containsUnsupportedOperationalClaim(
      "已确认酒店预订成功，今晚可以入住。",
    )).toBe(true);
  });

  it("admits a multi-offer summary's cancellation-policy wording when evidence-backed", () => {
    // This text has "预订" in one clause and "取消" in an unrelated one — the
    // exact shape that used to false-positive as a booking-status claim
    // before the cancellation-policy carve-out existed.
    expect(containsUnsupportedOperationalClaim(
      "台北君品酒店：每晚约 1,450 CNY，提供免费取消政策。福泰桔子商务旅馆：每晚约 620 CNY，预订政策为不可退款。",
      { evidenceBacked: true },
    )).toBe(false);
  });

  it("still strips that same cancellation-policy wording when nothing was searched", () => {
    expect(containsUnsupportedOperationalClaim(
      "台北君品酒店：每晚约 1,450 CNY，提供免费取消政策。福泰桔子商务旅馆：每晚约 620 CNY，预订政策为不可退款。",
    )).toBe(true);
  });
});

describe("requestsUnsupportedOperationalFacts — userConfirmed is now a no-op", () => {
  it("allows 「确认搜索 TWD」 regardless of userConfirmed", () => {
    expect(requestsUnsupportedOperationalFacts("确认搜索 TWD")).toBe(false);
  });

  it("still strips 「确认搜索」 with US-visa phrasing regardless of userConfirmed", () => {
    expect(requestsUnsupportedOperationalFacts(
      "确认搜索 entry requires valid passport",
      { userConfirmed: true },
    )).toBe(true);
  });

  it("allows an availability + hotel query regardless of userConfirmed", () => {
    expect(requestsUnsupportedOperationalFacts("还有房吗")).toBe(false);
  });
});

describe("cancellation terms are not booking status", () => {
  it("admits a supplier's cancellation policy in an evidence-backed reply", () => {
    // These come back on every hotel rate. Reading them as "your booking was
    // cancelled" threw away answers that were entirely grounded.
    for (const reply of [
      "Hilton Tokyo Hotel 548.69 USD 每晚，3 晚，不可退订。",
      "Hotel Mystays 157 USD 每晚，可免费取消至 2026-09-30。",
      "The rate is non-refundable but includes taxes.",
      "Free cancellation until 30 September on this booking rate.",
    ]) {
      expect(containsUnsupportedOperationalClaim(reply, { evidenceBacked: true }), reply).toBe(false);
    }
  });

  it("still refuses a claim about the traveller's own reservation", () => {
    for (const reply of [
      "你的预订已确认。",
      "Your booking is confirmed and the reservation status is pending.",
      "我已经帮你取消了这个预订。",
    ]) {
      expect(containsUnsupportedOperationalClaim(reply, { evidenceBacked: true }), reply).toBe(true);
    }
  });

  it("keeps refusing cancellation wording when nothing was searched", () => {
    // Without evidence the same sentence is the model inventing terms.
    expect(containsUnsupportedOperationalClaim(
      "Your booking is confirmed with free cancellation.", { evidenceBacked: false },
    )).toBe(true);
  });
});
