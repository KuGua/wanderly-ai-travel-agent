import { describe, expect, it } from "vitest";

import { destinationCuePreflight } from "../src/skills/personal/destination-cue-decision-skill.js";
import { evaluateDestinationCueSuppression } from "../src/services/destination-cue-service.js";

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
