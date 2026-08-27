import { describe, expect, it } from "vitest";

import { buildTripTitlePreview } from "./trip-title";

describe("buildTripTitlePreview", () => {
  it("matches the structured title rules", () => {
    expect(buildTripTitlePreview({
      destinationCandidates: ["Tokyo", "Bangkok"], travelDateStart: "2026-10-01", travelDateEnd: "2026-10-07", locale: "en",
    })).toBe("Tokyo · Bangkok Trip Planner｜7 Days");
    expect(buildTripTitlePreview({ destinationCandidates: ["东京"], locale: "zh" })).toBe("东京行程规划");
  });
});
