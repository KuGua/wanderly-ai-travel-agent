import { describe, expect, it } from "vitest";

import {
  buildDeterministicDestinationCueDecision,
  destinationCuePreflight,
} from "../src/skills/personal/destination-cue-decision-skill.js";
import { evaluateDestinationCueSuppression } from "../src/services/destination-cue-service.js";
import { destinationCueDecisionSchema } from "../src/providers/llm-gateway.js";

describe("destination cue preflight", () => {
  it("does not cue from a plain flight or hotel search", () => {
    expect(destinationCuePreflight("帮我查一下北京到东京的机票")).toBe("SKIP_FLIGHT_OR_HOTEL");
    expect(destinationCuePreflight("北京到东京的机票多少钱")).toBe("SKIP_FLIGHT_OR_HOTEL");
    expect(destinationCuePreflight("find hotels in Kyoto for next week")).toBe("SKIP_FLIGHT_OR_HOTEL");
  });

  it("lets an explicit destination command override search wording", () => {
    expect(destinationCuePreflight("把东京设为目的地，然后帮我查机票")).toBe("MODEL");
    expect(destinationCuePreflight("Set Kyoto as the destination and find a hotel")).toBe("MODEL");
  });

  it("sends a genuine travel mention to the model", () => {
    expect(destinationCuePreflight("我这次想去北京、成都和杭州")).toBe("MODEL");
  });
});

describe("deterministic destination-cue fallback", () => {
  it("keeps an already resolved city reviewable when the model cue is unavailable", () => {
    expect(buildDeterministicDestinationCueDecision({
      candidates: ["Shanghai"],
      currentDestinations: [],
    })).toMatchObject({
      candidates: [{ canonicalCityName: "Shanghai", countryCode: "CN", ordinal: 0 }],
      modelVersion: "deterministic-brief-parser",
      promptVersion: "destination-cue-fallback-v1",
    });
  });

  it("does not re-prompt for a city already confirmed on the trip", () => {
    expect(buildDeterministicDestinationCueDecision({
      candidates: ["Shanghai"],
      currentDestinations: ["Shanghai"],
    })).toBeNull();
  });
});

describe("destination cue dismissal recovery", () => {
  const dismissedAt = new Date("2026-09-04T00:00:00.000Z");

  it("requires both thirty minutes and two subsequent mentions", () => {
    expect(evaluateDestinationCueSuppression({
      dismissedAt,
      lastQualifiedMentionAt: dismissedAt,
      qualifiedMentionCount: 0,
      now: new Date("2026-09-04T00:31:00.000Z"),
    })).toMatchObject({ eligible: false, nextMentionCount: 1 });
    expect(evaluateDestinationCueSuppression({
      dismissedAt,
      lastQualifiedMentionAt: new Date("2026-09-04T00:31:00.000Z"),
      qualifiedMentionCount: 1,
      now: new Date("2026-09-04T00:32:00.000Z"),
    })).toMatchObject({ eligible: true, nextMentionCount: 2 });
  });

  it("resets after twenty-four hours of silence and cues on the next mention", () => {
    expect(evaluateDestinationCueSuppression({
      dismissedAt,
      lastQualifiedMentionAt: dismissedAt,
      qualifiedMentionCount: 1,
      now: new Date("2026-09-05T00:00:00.000Z"),
    })).toEqual({ eligible: true, nextMentionCount: 0, reset: true });
  });
});

/**
 * The decision the model actually returns has to parse.
 *
 * The prompt named the three top-level keys and mentioned ordinals but never
 * said a candidate is an object, and the model answered
 * `{"candidates": ["东京"], ...}`. The strict schema rejected it and the
 * gateway's only failure mode was `return null`, so the cue produced nothing
 * for any city, in any turn, with no log, no metric and no error — the trip
 * simply never got a destination and the readiness card kept asking for one.
 *
 * The prompt now spells the object out. This pins the tolerance underneath it,
 * because a prompt is a request and a schema is the contract.
 */
describe("destination cue decision parsing", () => {
  it("reads the bare-string candidates the model actually produced", () => {
    const parsed = destinationCueDecisionSchema.safeParse({
      disposition: "PROPOSE",
      candidates: ["东京"],
      reasonCode: "EXPLICIT_DESTINATION_COMMAND",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.candidates).toEqual([{ mentionedText: "东京", ordinal: 0 }]);
  });

  it("takes position as the ordinal when the strings carry none", () => {
    const parsed = destinationCueDecisionSchema.safeParse({
      disposition: "PROPOSE",
      candidates: ["京都", "大阪"],
      reasonCode: "QUALIFIED_DESTINATION_MENTION",
    });

    expect(parsed.success && parsed.data.candidates).toEqual([
      { mentionedText: "京都", ordinal: 0 },
      { mentionedText: "大阪", ordinal: 1 },
    ]);
  });

  it("still reads the documented object form", () => {
    const parsed = destinationCueDecisionSchema.safeParse({
      disposition: "PROPOSE",
      candidates: [{ mentionedText: "Tokyo", ordinal: 0 }],
      reasonCode: "EXPLICIT_DESTINATION_COMMAND",
    });

    expect(parsed.success && parsed.data.candidates).toEqual([{ mentionedText: "Tokyo", ordinal: 0 }]);
  });

  it("keeps rejecting a decision that contradicts itself", () => {
    // Tolerating the candidate shape must not loosen the disposition rules.
    expect(destinationCueDecisionSchema.safeParse({
      disposition: "DO_NOT_PROPOSE",
      candidates: ["东京"],
      reasonCode: "NO_DESTINATION",
    }).success).toBe(false);
    expect(destinationCueDecisionSchema.safeParse({
      disposition: "PROPOSE",
      candidates: [],
      reasonCode: "EXPLICIT_DESTINATION_COMMAND",
    }).success).toBe(false);
  });

  it("rejects entries that are neither a string nor a candidate", () => {
    expect(destinationCueDecisionSchema.safeParse({
      disposition: "PROPOSE",
      candidates: [{ city: "Tokyo" }],
      reasonCode: "EXPLICIT_DESTINATION_COMMAND",
    }).success).toBe(false);
  });
});
