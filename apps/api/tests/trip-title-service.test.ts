import { describe, expect, it } from "vitest";

import { buildTripTitle, tripDays } from "../src/services/trip-title-service.js";

describe("trip titles", () => {
  it("uses only explicit destinations and inclusive calendar days", () => {
    expect(buildTripTitle({
      destinationCandidates: [" Tokyo ", "Bangkok"],
      travelDateStart: "2026-10-01",
      travelDateEnd: "2026-10-07",
      locale: "en",
    })).toBe("Tokyo · Bangkok Trip Planner｜7 Days");
    expect(buildTripTitle({
      destinationCandidates: ["东京", "曼谷"],
      travelDateStart: "2026-10-01",
      travelDateEnd: "2026-10-07",
      locale: "zh",
    })).toBe("东京 · 曼谷行程规划｜7天");
  });

  it("does not infer missing dates or destinations", () => {
    expect(buildTripTitle({ destinationCandidates: ["Tokyo"], locale: "en" })).toBe("Tokyo Trip Planner");
    expect(buildTripTitle({ destinationCandidates: [], travelDateStart: "2026-10-01", travelDateEnd: "2026-10-01", locale: "en" })).toBe("Trip Planner｜1 Days");
    expect(buildTripTitle({ destinationCandidates: [], locale: "zh" })).toBe("行程规划");
    expect(buildTripTitle({ destinationCandidates: ["Tokyo"], travelDays: 7, locale: "en" })).toBe("Tokyo Trip Planner｜7 Days");
  });

  it("rejects impossible and reverse date ranges", () => {
    expect(tripDays("2026-02-29", "2026-03-01")).toBeNull();
    expect(tripDays("2026-10-08", "2026-10-07")).toBeNull();
  });
});
