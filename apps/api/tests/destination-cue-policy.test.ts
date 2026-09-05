import { describe, expect, it } from "vitest";

import { destinationCuePreflight } from "../src/skills/personal/destination-cue-decision-skill.js";
import { evaluateDestinationCuePromptPolicy } from "../src/services/destination-cue-service.js";
import { destinationCueDecisionSchema } from "../src/providers/llm-gateway.js";

describe("destination cue preflight", () => {
  it("sends flight, hotel, and bare-city language to the classifier", () => {
    expect(destinationCuePreflight("帮我查一下北京到东京的机票")).toBe("MODEL");
    expect(destinationCuePreflight("find hotels in Kyoto for next week")).toBe("MODEL");
    expect(destinationCuePreflight("北京")).toBe("MODEL");
  });

  it("lets an explicit destination command override search wording", () => {
    expect(destinationCuePreflight("把东京设为目的地，然后帮我查机票")).toBe("MODEL");
    expect(destinationCuePreflight("Set Kyoto as the destination and find a hotel")).toBe("MODEL");
  });

  it("sends a genuine travel mention to the model", () => {
    expect(destinationCuePreflight("我这次想去北京、成都和杭州")).toBe("MODEL");
  });

  it("also sends a multi-city list to the language classifier", () => {
    expect(destinationCuePreflight("北京、成都和杭州")).toBe("MODEL");
  });
});

describe("destination cue prompt policy", () => {
  it("suppresses automatic cues during the thirty-minute cooldown", () => {
    expect(evaluateDestinationCuePromptPolicy({
      cooldownUntil: new Date("2026-09-04T00:30:00.000Z"),
      dismissalDay: "2026-09-04",
      dailyDismissalCount: 1,
      timeZone: "UTC",
      now: new Date("2026-09-04T00:29:59.000Z"),
    })).toEqual({ eligible: false, reason: "COOLDOWN" });
    expect(evaluateDestinationCuePromptPolicy({
      cooldownUntil: new Date("2026-09-04T00:30:00.000Z"),
      dismissalDay: "2026-09-04",
      dailyDismissalCount: 1,
      timeZone: "UTC",
      now: new Date("2026-09-04T00:30:00.000Z"),
    })).toEqual({ eligible: true, reason: "ELIGIBLE" });
  });

  it("applies the three-dismissal limit to the user's local calendar day", () => {
    expect(evaluateDestinationCuePromptPolicy({
      cooldownUntil: null,
      dismissalDay: "2026-09-04",
      dailyDismissalCount: 3,
      timeZone: "Asia/Shanghai",
      now: new Date("2026-09-04T15:59:59.000Z"),
    })).toEqual({ eligible: false, reason: "DAILY_LIMIT" });
    expect(evaluateDestinationCuePromptPolicy({
      cooldownUntil: null,
      dismissalDay: "2026-09-04",
      dailyDismissalCount: 3,
      timeZone: "Asia/Shanghai",
      now: new Date("2026-09-04T16:00:00.000Z"),
    })).toEqual({ eligible: true, reason: "ELIGIBLE" });
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
      candidates: ["东京"],
      isNeutralMultiCityList: false,
      reasonCode: "SINGLE_DESTINATION_INTEREST",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.candidates).toEqual([{
      mentionedText: "东京",
      ordinal: 0,
      intent: "DESTINATION_INTEREST",
      triggerContext: "CITY_EXPLORATION",
    }]);
  });

  it("takes position as the ordinal when the strings carry none", () => {
    const parsed = destinationCueDecisionSchema.safeParse({
      candidates: ["京都", "大阪"],
      isNeutralMultiCityList: false,
      reasonCode: "SINGLE_DESTINATION_INTEREST",
    });

    expect(parsed.success && parsed.data.candidates).toEqual([
      { mentionedText: "京都", ordinal: 0, intent: "DESTINATION_INTEREST", triggerContext: "CITY_EXPLORATION" },
      { mentionedText: "大阪", ordinal: 1, intent: "DESTINATION_INTEREST", triggerContext: "CITY_EXPLORATION" },
    ]);
  });

  it("still reads the documented object form", () => {
    const parsed = destinationCueDecisionSchema.safeParse({
      candidates: [{
        mentionedText: "Tokyo",
        ordinal: 0,
        intent: "EXPLICIT_SET_DESTINATION",
        triggerContext: "EXPLICIT_DESTINATION_COMMAND",
      }],
      isNeutralMultiCityList: false,
      reasonCode: "EXPLICIT_DESTINATION_COMMAND",
    });

    expect(parsed.success && parsed.data.candidates[0]).toMatchObject({
      mentionedText: "Tokyo",
      intent: "EXPLICIT_SET_DESTINATION",
      triggerContext: "EXPLICIT_DESTINATION_COMMAND",
    });
  });

  it("keeps explicit exclusion separate from a positive destination cue", () => {
    const parsed = destinationCueDecisionSchema.safeParse({
      candidates: [{
        mentionedText: "北京",
        ordinal: 0,
        intent: "EXPLICIT_EXCLUDE_DESTINATION",
        triggerContext: "EXPLICIT_EXCLUSION_COMMAND",
      }],
      isNeutralMultiCityList: false,
      reasonCode: "EXPLICIT_EXCLUSION_COMMAND",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a neutral multi-city decision that still carries candidates", () => {
    expect(destinationCueDecisionSchema.safeParse({
      candidates: ["北京", "上海"],
      isNeutralMultiCityList: true,
      reasonCode: "NEUTRAL_MULTI_CITY_LIST",
    }).success).toBe(false);
  });

  it("keeps rejecting a decision that contradicts itself", () => {
    // Tolerating the candidate shape must not loosen the disposition rules.
    expect(destinationCueDecisionSchema.safeParse({
      candidates: ["东京"],
      isNeutralMultiCityList: false,
      reasonCode: "NO_DESTINATION",
    }).success).toBe(false);
    expect(destinationCueDecisionSchema.safeParse({
      candidates: [],
      isNeutralMultiCityList: false,
      reasonCode: "EXPLICIT_DESTINATION_COMMAND",
    }).success).toBe(false);
  });

  it("rejects entries that are neither a string nor a candidate", () => {
    expect(destinationCueDecisionSchema.safeParse({
      candidates: [{ city: "Tokyo" }],
      isNeutralMultiCityList: false,
      reasonCode: "EXPLICIT_DESTINATION_COMMAND",
    }).success).toBe(false);
  });
});
