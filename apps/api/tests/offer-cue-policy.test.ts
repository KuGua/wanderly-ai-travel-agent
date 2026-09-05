import { describe, expect, it } from "vitest";

import { evaluateOfferCuePromptPolicy } from "../src/services/offer-cue-prompt-policy.js";

const FIXED_NOW = new Date("2026-09-05T12:00:00Z");

describe("evaluateOfferCuePromptPolicy", () => {
  it("returns ELIGIBLE when no cooldown and no daily dismissals", () => {
    expect(evaluateOfferCuePromptPolicy({
      cooldownUntil: null,
      dismissalDay: null,
      dailyDismissalCount: 0,
      timeZone: "UTC",
      now: FIXED_NOW,
    })).toEqual({ eligible: true, reason: "ELIGIBLE" });
  });

  it("suppresses cues within the 30-minute cooldown after a dismissal", () => {
    const cooldownUntil = new Date(FIXED_NOW.getTime() + 29 * 60_000);
    expect(evaluateOfferCuePromptPolicy({
      cooldownUntil,
      dismissalDay: null,
      dailyDismissalCount: 0,
      timeZone: "UTC",
      now: FIXED_NOW,
    })).toEqual({ eligible: false, reason: "COOLDOWN" });
  });

  it("returns ELIGIBLE exactly at the cooldown boundary (>=)", () => {
    const cooldownUntil = new Date(FIXED_NOW.getTime());
    expect(evaluateOfferCuePromptPolicy({
      cooldownUntil,
      dismissalDay: null,
      dailyDismissalCount: 0,
      timeZone: "UTC",
      now: FIXED_NOW,
    })).toEqual({ eligible: true, reason: "ELIGIBLE" });
  });

  it("mutes cues on the third dismissal in the same local day", () => {
    expect(evaluateOfferCuePromptPolicy({
      cooldownUntil: null,
      dismissalDay: "2026-09-05",
      dailyDismissalCount: 3,
      timeZone: "UTC",
      now: FIXED_NOW,
    })).toEqual({ eligible: false, reason: "DAILY_LIMIT" });
  });

  it("two dismissals in the same day stay eligible (third is the cap)", () => {
    expect(evaluateOfferCuePromptPolicy({
      cooldownUntil: null,
      dismissalDay: "2026-09-05",
      dailyDismissalCount: 2,
      timeZone: "UTC",
      now: FIXED_NOW,
    })).toEqual({ eligible: true, reason: "ELIGIBLE" });
  });

  it("dismissals from a previous local day do not count toward today", () => {
    expect(evaluateOfferCuePromptPolicy({
      cooldownUntil: null,
      dismissalDay: "2026-09-04",
      dailyDismissalCount: 5,
      timeZone: "UTC",
      now: FIXED_NOW,
    })).toEqual({ eligible: true, reason: "ELIGIBLE" });
  });

  it("falls back to UTC when the timeZone string is invalid", () => {
    expect(evaluateOfferCuePromptPolicy({
      cooldownUntil: null,
      dismissalDay: "2026-09-05",
      dailyDismissalCount: 3,
      timeZone: "Not/AZone",
      now: FIXED_NOW,
    })).toEqual({ eligible: false, reason: "DAILY_LIMIT" });
  });
});
