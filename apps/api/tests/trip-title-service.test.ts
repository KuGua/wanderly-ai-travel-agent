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

  // Spec §D4 / §6.1: titleDestinationLabel is a display-only fallback for
  // country-only briefs. It never reaches the planner and is byte-identical
  // to today when null/empty.
  describe("titleDestinationLabel fallback", () => {
    it("byte-identical output when label is null", () => {
      expect(buildTripTitle({ destinationCandidates: [], locale: "en" })).toBe("Trip Planner");
      expect(buildTripTitle({ destinationCandidates: [], locale: "zh" })).toBe("行程规划");
      expect(buildTripTitle({ destinationCandidates: [], titleDestinationLabel: null, locale: "en" })).toBe("Trip Planner");
      expect(buildTripTitle({ destinationCandidates: [], titleDestinationLabel: null, locale: "zh" })).toBe("行程规划");
    });

    it("byte-identical output when label is empty or whitespace", () => {
      expect(buildTripTitle({ destinationCandidates: [], titleDestinationLabel: "", locale: "en" })).toBe("Trip Planner");
      expect(buildTripTitle({ destinationCandidates: [], titleDestinationLabel: "   ", locale: "zh" })).toBe("行程规划");
    });

    it("uses the label when explicit cities are empty", () => {
      expect(buildTripTitle({ destinationCandidates: [], titleDestinationLabel: "法国", locale: "zh" })).toBe("法国行程规划");
      expect(buildTripTitle({ destinationCandidates: [], titleDestinationLabel: "France", locale: "en" })).toBe("France Trip Planner");
    });

    it("explicit cities always win over the label (D4 priority)", () => {
      expect(buildTripTitle({
        destinationCandidates: ["Paris"],
        titleDestinationLabel: "France",
        locale: "en",
      })).toBe("Paris Trip Planner");
      expect(buildTripTitle({
        destinationCandidates: ["巴黎"],
        titleDestinationLabel: "法国",
        locale: "zh",
      })).toBe("巴黎行程规划");
    });

    it("label combines with dates when explicit cities are empty", () => {
      expect(buildTripTitle({
        destinationCandidates: [],
        titleDestinationLabel: "France",
        travelDateStart: "2026-10-01",
        travelDateEnd: "2026-10-07",
        locale: "en",
      })).toBe("France Trip Planner｜7 Days");
    });

    it("trims whitespace around the label", () => {
      expect(buildTripTitle({
        destinationCandidates: [],
        titleDestinationLabel: "  France  ",
        locale: "en",
      })).toBe("France Trip Planner");
    });
  });
});
