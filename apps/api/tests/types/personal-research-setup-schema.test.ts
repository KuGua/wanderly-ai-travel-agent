import { describe, expect, it } from "vitest";

import { personalResearchSetupAnswerSchema } from "../../src/types/schemas.js";

describe("personalResearchSetupAnswerSchema", () => {
  it("accepts a complete ordered date range as one patch", () => {
    const result = personalResearchSetupAnswerSchema.safeParse({
      field: "travelDates",
      value: { start: "2026-10-12", end: "2026-10-15" },
    });

    expect(result.success).toBe(true);
  });

  it("rejects an unordered date range", () => {
    const result = personalResearchSetupAnswerSchema.safeParse({
      field: "travelDates",
      value: { start: "2026-10-15", end: "2026-10-12" },
    });

    expect(result.success).toBe(false);
  });

  it("rejects legacy single-date patches that violate the date-pair invariant", () => {
    const result = personalResearchSetupAnswerSchema.safeParse({
      field: "travelDateStart",
      value: "2026-10-12",
    });

    expect(result.success).toBe(false);
  });
});
