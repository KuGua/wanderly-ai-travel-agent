import { describe, expect, it } from "vitest";

import { currentDateRule } from "../src/providers/llm-gateway.js";
import { explainToolFailure } from "../src/agents/personal-research-tools.js";

describe("the date the conversation is happening on", () => {
  it("states today, so a bare 月日 is not read as a past year", () => {
    // Without this the model answered from training data, believed it was
    // 2024, and stored a check-in of 2024-12-20 for "12月20到25号".
    const rule = currentDateRule(new Date("2026-09-02T04:31:00Z"));
    expect(rule).toContain("2026-09-02 04:31 UTC");
  });

  it("names the hour, because a UTC date alone is the wrong day for hours at a time", () => {
    // 23:10Z is already the next morning in Beijing. Without the time the
    // model would have told a traveller there that today was yesterday.
    expect(currentDateRule(new Date("2026-09-02T23:10:00Z"))).toContain("2026-09-02 23:10 UTC");
  });

  it("defers to the traveller on 今天 and 明天 rather than correcting them", () => {
    expect(currentDateRule(new Date("2026-09-02T00:00:00Z"))).toContain("以用户的说法为准");
  });

  it("rules out the date-range excuse the model invented for itself", () => {
    const rule = currentDateRule(new Date("2026-09-02T00:00:00Z"));
    expect(rule).toContain("不存在「日期太远因此查不了」");
  });
});

describe("what a failed tool tells the model", () => {
  it("says a missing precondition is not about dates or cities", () => {
    const explained = explainToolFailure({
      outcome: "UNAVAILABLE",
      summary: { errorCode: "SEARCH_CONSTRAINTS_INCOMPLETE" },
    }) as { reason: string; reasonCode: string };
    // The bare code left the model to supply a cause, and it chose one that
    // does not exist: that the supplier could not quote 2026.
    expect(explained.reason).toContain("授权");
    expect(explained.reason).toContain("与日期或城市无关");
    expect(explained.reasonCode).toBe("SEARCH_CONSTRAINTS_INCOMPLETE");
  });

  it("leaves a successful result untouched", () => {
    const result = { outcome: "AVAILABLE", capability: "places.search", places: { items: [] } };
    expect(explainToolFailure(result)).toBe(result);
  });

  it("passes through a code it has no words for, rather than inventing some", () => {
    const passthrough = { outcome: "UNAVAILABLE", reason: "SOMETHING_NEW" };
    expect(explainToolFailure(passthrough)).toBe(passthrough);
  });
});
