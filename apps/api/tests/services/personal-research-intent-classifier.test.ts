import { describe, expect, it } from "vitest";

import {
  RESEARCH_INTENT_CLASSIFIER_VERSION,
  classifyResearchIntent,
} from "../../src/services/personal-research-intent-classifier.js";

describe("personal-research-intent-classifier", () => {
  describe("classifierVersion constant", () => {
    it("is a non-empty string with a version suffix", () => {
      expect(typeof RESEARCH_INTENT_CLASSIFIER_VERSION).toBe("string");
      expect(RESEARCH_INTENT_CLASSIFIER_VERSION.length).toBeGreaterThan(0);
      expect(RESEARCH_INTENT_CLASSIFIER_VERSION).toMatch(/^research-intent\/v\d+$/);
    });
  });

  describe("hotel research — high confidence", () => {
    it.each([
      ["查酒店", "zh-CN"],
      ["搜酒店", "zh-CN"],
      ["找住宿", "zh-CN"],
      ["搜索饭店", "zh-CN"],
      ["查一下宾馆", "zh-CN"],
      ["search hotel", "en-US"],
      ["find stay", "en-US"],
      ["look up lodging", "en-US"],
      ["browse inn", "en-US"],
    ])("classifies %s as hotel RESEARCH_ONLY", (question, _locale) => {
      const result = classifyResearchIntent({ question });
      expect(result).toEqual({
        kind: "PROPOSED",
        intent: { kind: "RESEARCH_ONLY", requestedCapabilities: ["hotel"] },
      });
    });
  });

  describe("Traditional Chinese — high confidence", () => {
    it.each([
      "查飯店",
      "搜住宿",
      "找旅館",
      "查一下民宿",
    ])("zh-TW %s maps to hotel RESEARCH_ONLY", (question) => {
      const result = classifyResearchIntent({ question, locale: "zh-TW" });
      expect(result).toEqual({
        kind: "PROPOSED",
        intent: { kind: "RESEARCH_ONLY", requestedCapabilities: ["hotel"] },
      });
    });
  });

  describe("route research — high confidence", () => {
    it.each([
      "从桃园机场到西园町怎么走",
      "怎么走到酒店",
      "查路线",
      "导航",
      "directions to hotel",
      "navigate from airport",
    ])("classifies %s as navigation RESEARCH_ONLY", (question) => {
      const result = classifyResearchIntent({ question });
      expect(result).toEqual({
        kind: "PROPOSED",
        intent: { kind: "RESEARCH_ONLY", requestedCapabilities: ["navigation"] },
      });
    });
  });

  describe("full itinerary — high confidence", () => {
    it.each([
      "规划行程",
      "安排行程",
      "比较方案",
      "plan itinerary",
      "build trip plan",
    ])("classifies %s as PROPOSE_PLAN", (question) => {
      const result = classifyResearchIntent({ question });
      expect(result.kind).toBe("PROPOSED");
      if (result.kind === "PROPOSED") {
        expect(result.intent.kind).toBe("PROPOSE_PLAN");
        expect(result.intent.requestedCapabilities).toEqual(
          expect.arrayContaining(["flight", "hotel", "navigation"]),
        );
      }
    });
  });

  describe("activity / place research — high confidence", () => {
    it.each([
      ["查景点", "activities"],
      ["找餐厅", "places"],
      ["推荐美食", "places"],
      ["search attractions", "activities"],
      ["find restaurants", "places"],
    ])("classifies %s as %s", (question, capability) => {
      const result = classifyResearchIntent({ question });
      expect(result).toEqual({
        kind: "PROPOSED",
        intent: { kind: "RESEARCH_ONLY", requestedCapabilities: [capability] },
      });
    });
  });

  describe("CONVERSATION fallback — no travel verb+noun pair", () => {
    it.each([
      "桃园住宿区域推荐",   // recommendation / qualitative, no research verb
      "介绍下东京",
      "感觉如何",
      "哪里适合住",
      "推荐区域",
      "hello",
      "今天天气不错",
      "",
    ])("falls back to CONVERSATION for %s", (question) => {
      const result = classifyResearchIntent({ question });
      expect(result).toEqual({ kind: "CONVERSATION" });
    });
  });

  describe("CONVERSATION fallback — negation / hypothetical", () => {
    it.each([
      "不要查酒店",
      "我不想搜酒店",
      "算了",
      "不用了",
      "don't book hotels",
      "no need to search",
      "skip hotel",
    ])("falls back to CONVERSATION for negation %s", (question) => {
      const result = classifyResearchIntent({ question });
      expect(result).toEqual({ kind: "CONVERSATION" });
    });
  });

  describe("CONVERSATION fallback — conflicting intents", () => {
    it.each([
      "查酒店和查路线",         // both hotel + route verbs/nouns present
      "查活动和酒店",           // activities + hotel collision
      "搜景点和搜酒店",         // two distinct nouns in one request
      "find hotel and directions", // English multi-intent
      "search attractions and restaurants", // activities + places (overlap)
      "查酒店和查活动",         // hotel + activities
    ])("falls back to CONVERSATION for conflict %s", (question) => {
      const result = classifyResearchIntent({ question });
      expect(result).toEqual({ kind: "CONVERSATION" });
    });

    it("treats a hotel request with explicit route verb as a conflict", () => {
      // "查酒店怎么走" — hotel noun + route verb "怎么走" → conservative
      // conflict detection forces CONVERSATION. The LLM can clarify which
      // intent the owner actually wants before any provider call.
      const result = classifyResearchIntent({ question: "查酒店怎么走" });
      expect(result).toEqual({ kind: "CONVERSATION" });
    });
  });

  describe("CONVERSATION fallback — low confidence", () => {
    it.each([
      "可以",
      "能不能",
      "什么意思",
      "为什么",
      "how",
      "what is",
      "why",
    ])("falls back to CONVERSATION for question-only %s", (question) => {
      const result = classifyResearchIntent({ question });
      expect(result).toEqual({ kind: "CONVERSATION" });
    });

    it("does NOT block high-confidence research phrasings that contain a low-confidence marker", () => {
      // "查一下酒店可以么" — explicit research verb wins over question marker.
      const result = classifyResearchIntent({ question: "查一下酒店可以么" });
      expect(result.kind).toBe("PROPOSED");
      if (result.kind === "PROPOSED") {
        expect(result.intent.requestedCapabilities).toEqual(["hotel"]);
      }
    });
  });

  describe("invariant — never extracts destination candidates", () => {
    it("returns only closed-shape intent for classified input", () => {
      const result = classifyResearchIntent({ question: "查桃园酒店" });
      if (result.kind === "PROPOSED") {
        // The classifier never carries destinationCandidates in its output
        // shape — that's the orchestrator's responsibility at acceptance.
        expect("destinationCandidates" in result.intent).toBe(false);
      }
    });
  });

  describe("invariant — locale does not affect the result for ambiguous inputs", () => {
    it("returns CONVERSATION consistently across locales", () => {
      const samples = ["你好", "hello", "推荐", "介绍一下"];
      for (const q of samples) {
        for (const locale of ["zh-CN", "zh-TW", "en-US"] as const) {
          expect(classifyResearchIntent({ question: q, locale })).toEqual({ kind: "CONVERSATION" });
        }
      }
    });
  });
});
