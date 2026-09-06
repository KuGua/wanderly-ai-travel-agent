import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelGateway } from "../src/providers/model-gateway.js";
import {
  containsUnbackedTripMutationClaim,
  containsUnsupportedOperationalClaim,
  pendingTripMutationReply,
  requestsUnsupportedOperationalFacts,
  resolveConversationPlace,
} from "../src/policy/conversation-safety.js";
import { __setModelGatewayForTests } from "../src/providers/gateway-factory.js";
import { executeTravelConversation, travelConversationSkill } from "../src/skills/personal/travel-conversation-skill.js";
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
    ["booking", "Can I book this hotel now?"],
    ["flight status", "Is flight SQ12 delayed?"],
    ["ordinary flight-status wording", "Is SQ12 late?"],
  ])("returns a deterministic SAFE_REFUSAL before calling the model for a %s question", async (_label, question) => {
    const generateConversationReply = vi.fn();
    __setModelGatewayForTests(buildGateway(generateConversationReply));

    const result = await invokeConversation(question);

    expect(result.responseMode).toBe("SAFE_REFUSAL");
    expect(generateConversationReply).not.toHaveBeenCalled();
  });

  // A visa question is a fair question. Refusing it before the model was even
  // called answered a traveller asking for help with a recital of what the
  // product will not do. The model answers now — under a prompt rule telling
  // it to say the requirement cannot be confirmed here and to point at the
  // official source — and the output gate below still stops it deciding.
  it.each([
    ["visa ordinary phrasing", "What visa do Chinese citizens need for Japan?"],
    ["visa direct phrasing", "Do Chinese citizens need a visa for Japan?"],
    ["entry conclusion", "Can I enter Japan without a visa?"],
    ["plural visa", "Which visas are required for Japan?"],
    ["Chinese visa question", "日本签证需要什么？"],
  ])("lets the model answer a %s question instead of refusing it up front", async (_label, question) => {
    const generateConversationReply = vi.fn().mockResolvedValue({
      content: "Entry rules are set by the destination — please confirm with the official consulate before you travel.",
      responseMode: "MODEL",
    });
    __setModelGatewayForTests(buildGateway(generateConversationReply));

    const result = await invokeConversation(question);

    expect(generateConversationReply).toHaveBeenCalledOnce();
    expect(result.responseMode).toBe("MODEL");
  });

  it("says it cannot confirm rather than reciting the policy, and localizes", async () => {
    const generateConversationReply = vi.fn().mockResolvedValue({
      content: "你需要办理签证。",
      responseMode: "MODEL",
    });
    __setModelGatewayForTests(buildGateway(generateConversationReply));

    const result = await invokeConversation("日本签证需要什么？");

    expect(result).toMatchObject({ responseMode: "SAFE_REFUSAL" });
    expect(result.content).not.toContain("Agent");
    // Speaks to the question asked; does not list what the product refuses to
    // claim, which read as an accusation to anyone who had not asked for it.
    expect(result.content).toContain("不一定准确");
    expect(result.content).toContain("核实");
    expect(result.content).not.toContain("签证结论");
    expect(result.content).not.toContain("查询条件已收到");
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

  it("attaches no search-readiness behaviour of its own", async () => {
    // The Skill used to hold both contracts in a module constant, so every
    // turn carried them whatever it was about. They are the worker's choice
    // now (`selectResponseConstraints`), and the registry path this exercises
    // hands the model no tools at all — so there is nothing for a contract
    // that is almost entirely tool-calling instructions to attach to.
    const generateConversationReply = vi.fn().mockResolvedValue({
      content: "请告诉我入住日期、退房日期、入住人数与房间数。",
      responseMode: "MODEL",
    });
    __setModelGatewayForTests(buildGateway(generateConversationReply));

    await invokeConversation("请帮我找西门町附近的酒店");

    expect(generateConversationReply).toHaveBeenCalledWith(expect.objectContaining({
      responseConstraints: [],
    }));
  });

  it("forwards exactly the contracts the worker chose for the turn", async () => {
    const generateConversationReply = vi.fn().mockResolvedValue({
      content: "请告诉我入住日期、退房日期、入住人数与房间数。",
      responseMode: "MODEL",
    });
    __setModelGatewayForTests(buildGateway(generateConversationReply));

    await executeTravelConversation({
      ctx: createRequestContext(),
      policyGate: new DefaultPolicyGate("personal"),
    }, {
      question: "请帮我找西门町附近的酒店",
      threadContext: [],
      memoryContext: [],
      researchEvidence: [],
    }, new AbortController().signal, undefined, {
      responseConstraints: ["HOTEL_SEARCH_READINESS"],
    });

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
  // Asking is allowed; the output gate governs what may be answered.
  describe("Chinese visa / entry questions reach the model", () => {
    it.each([
      "签证怎么办",
      "日本签证需要什么",
      "护照要求",
      "入境规则",
      "免签国家",
      "落地签材料",
    ])("does NOT flag %s as operational", (question) => {
      expect(requestsUnsupportedOperationalFacts(question)).toBe(false);
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

/**
 * The visa rule blocks a conclusion, not a mention.
 *
 * It used to reject any reply containing 签证/护照/入境/visa, which threw away
 * ordinary planning answers: a traveller who typed 「开始规划吧」 or 「10天」 got
 * a canned refusal listing "签证结论" among the things the product would not
 * claim — as though they had asked about visas. Travel preparation is part of
 * a plan, so the gate fired on the very turn where planning begins.
 *
 * These two lists are the boundary. Pointing at the official source is the
 * behaviour the product wants and must survive; deciding the traveller's own
 * eligibility must not.
 */
describe("visa gate — defers freely, decides never", () => {
  it.each([
    ["planning reply that mentions preparation", "好的，我们从东京开始。出发前记得提前确认签证要求并核对护照有效期。"],
    ["passport validity reminder", "出发前请检查护照有效期是否超过六个月。"],
    ["入境 as ordinary arrival language", "入境后可以先在市区休整一天。"],
    ["deferral to the official line", "具体签证要求请以目的地官方口径为准。"],
    ["English deferral", "Please confirm visa requirements with the official consulate before you go."],
    ["requirement named but left open", "签证要求各国不同，出发前需要你自行到官网核实。"],
  ])("admits %s", (_label, text) => {
    expect(containsUnsupportedOperationalClaim(text)).toBe(false);
  });

  it.each([
    ["visa-free conclusion", "中国公民前往泰国免签，你不需要办理签证。"],
    ["visa on arrival", "你可以办落地签。"],
    ["requirement stated as fact", "你需要签证才能入境。"],
    ["English visa-free", "You are visa-free for this trip."],
    ["English negative requirement", "You do not need a visa to enter."],
    ["eligibility via passport", "中国护照可以直接入境泰国。"],
  ])("strips %s", (_label, text) => {
    expect(containsUnsupportedOperationalClaim(text)).toBe(true);
  });

  it("strips a conclusion even when it also points at an official source", () => {
    // Deferral wording must not launder a decision that is already made.
    expect(containsUnsupportedOperationalClaim(
      "泰国对中国免签，具体请以官方口径为准。",
    )).toBe(true);
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

  it("no longer refuses 「确认搜索」 with US-visa phrasing up front", () => {
    expect(requestsUnsupportedOperationalFacts(
      "确认搜索 entry requires valid passport",
      { userConfirmed: true },
    )).toBe(false);
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

describe("a currency code is not a flight number", () => {
  // Found by an intermittent refusal: an evidence-backed hotel summary was
  // replaced by "this chat cannot claim live prices…" — after the supplier
  // call had already run and returned. The trigger was phrasing, not facts.
  const offers = (price: string) =>
    `Dotonbori Hotel：${price}，不可取消。RIHGA Royal Osaka：约 865 CNY/晚，可免费取消至 12 月 23 日。`;

  it("does not refuse a hotel summary because the price leads with the currency", () => {
    expect(containsUnsupportedOperationalClaim(offers("CNY 691/晚"), { evidenceBacked: true })).toBe(false);
  });

  it("gives the same verdict whichever way the model writes the amount", () => {
    expect(containsUnsupportedOperationalClaim(offers("CNY 691/晚"), { evidenceBacked: true }))
      .toBe(containsUnsupportedOperationalClaim(offers("约 691 CNY/晚"), { evidenceBacked: true }));
  });

  it("still refuses a real flight-status claim carrying a designator", () => {
    expect(containsUnsupportedOperationalClaim("NH 842 今天延误了。", { evidenceBacked: true })).toBe(true);
  });

  it("still refuses a flight-status claim that names flights in words", () => {
    expect(containsUnsupportedOperationalClaim("你的航班已取消。", { evidenceBacked: true })).toBe(true);
  });
});

describe("trip mutation completion claims", () => {
  it.each([
    "已为你将出发地更新为北京。",
    "已经把上海设为这次旅行的目的地。",
    "I have updated the trip origin to Beijing.",
    "Your destination has been set to Shanghai.",
  ])("rejects an ordinary model reply that claims a Trip write: %s", (content) => {
    expect(containsUnbackedTripMutationClaim(content)).toBe(true);
    expect(containsUnsupportedOperationalClaim(content)).toBe(true);
  });

  it("allows the server-triggered follow-up after a confirmed mutation", () => {
    const content = "已为你将出发地更新为北京。";
    expect(containsUnbackedTripMutationClaim(content, { tripMutationBacked: true })).toBe(false);
    expect(containsUnsupportedOperationalClaim(content, { tripMutationBacked: true })).toBe(false);
  });

  it.each([
    "我可以把上海列为这次旅行的目的地，请在下方确认。",
    "可以将出发地改为北京，确认后再保存。",
    "You can set Beijing as the destination using the card below.",
  ])("keeps a pending proposal truthful: %s", (content) => {
    expect(containsUnbackedTripMutationClaim(content)).toBe(false);
  });

  /**
   * `normalizePolicyText` strips apostrophes, so a pattern written with one
   * can never match: `I've` reaches the rule as `i ve`. The whole English
   * active-voice branch was dead, leaving only the passive form covered.
   */
  it.each([
    "I've updated your trip departure to Beijing.",
    "We've now saved your travel dates.",
    "I set your destination to Shanghai.",
  ])("rejects an English completion claim written with an apostrophe: %s", (content) => {
    expect(containsUnbackedTripMutationClaim(content)).toBe(true);
    expect(containsUnsupportedOperationalClaim(content)).toBe(true);
  });

  /**
   * The rule's own replacement text says 已经识别到这项行程修改 … 再保存到本次
   * 行程 — a completion marker, and two clauses later a verb. Matching across
   * that gap made the gate reject the answer it substitutes, and the streaming
   * gate shares the predicate, so the traveller saw the reply vanish rather
   * than be replaced.
   */
  it("does not flag its own pending-confirmation replacement", () => {
    expect(containsUnbackedTripMutationClaim(pendingTripMutationReply("出发地改为北京").content)).toBe(false);
    expect(containsUnbackedTripMutationClaim(pendingTripMutationReply("change my origin").content)).toBe(false);
  });

  it("never points to a confirmation card when no savable proposal exists", async () => {
    const generateConversationReply = vi.fn().mockResolvedValue({
      content: "I have updated your travel dates.",
      responseMode: "MODEL",
    });
    __setModelGatewayForTests(buildGateway(generateConversationReply));

    const result = await executeTravelConversation({
      ctx: createRequestContext(),
      policyGate: new DefaultPolicyGate("personal"),
    }, {
      question: "2026.12",
      threadContext: [],
      memoryContext: [],
      researchEvidence: [],
    }, new AbortController().signal, undefined, { hasPendingTripMutation: false });

    expect(result).toMatchObject({ responseMode: "SAFE_REFUSAL" });
    expect(result.content).toContain("state the city or date range clearly");
    expect(result.content).not.toContain("card below");
  });

  it("keeps the confirmation-card instruction when parsing found a proposal", async () => {
    const generateConversationReply = vi.fn().mockResolvedValue({
      content: "I have updated your travel dates.",
      responseMode: "MODEL",
    });
    __setModelGatewayForTests(buildGateway(generateConversationReply));

    const result = await executeTravelConversation({
      ctx: createRequestContext(),
      policyGate: new DefaultPolicyGate("personal"),
    }, {
      question: "2026.12.4-12.10",
      threadContext: [],
      memoryContext: [],
      researchEvidence: [],
    }, new AbortController().signal, undefined, { hasPendingTripMutation: true });

    expect(result.content).toContain("confirm the card below");
  });

  it("still reads a completion marker attached to its own verb", () => {
    expect(containsUnbackedTripMutationClaim("已更新你的行程出发地。")).toBe(true);
    expect(containsUnbackedTripMutationClaim("出发地已改为北京。")).toBe(true);
    expect(containsUnbackedTripMutationClaim("行程已经保存好了。")).toBe(true);
  });
});
