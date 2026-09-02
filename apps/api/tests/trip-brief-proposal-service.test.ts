import { describe, expect, it } from "vitest";
import { proposeTripBriefFromTurn } from "../src/services/trip-brief-proposal-service.js";

describe("proposeTripBriefFromTurn", () => {
  it("extracts explicit English destination and duration", () => {
    expect(proposeTripBriefFromTurn("I am going to Tokyo for 7 days")).toEqual({ destinationCandidates: ["Tokyo"], travelDays: 7 });
  });
  it("uses a selected map place without retaining the question", () => {
    expect(proposeTripBriefFromTurn("7 days", { name: "Kyoto", latitude: 35, longitude: 135, sourceType: "REFERENCE" })).toEqual({ destinationCandidates: ["Kyoto"], travelDays: 7 });
  });
  it("does not create a candidate from unrelated text", () => {
    expect(proposeTripBriefFromTurn("What food should I try?")).toBeNull();
  });
  it("extracts an explicit Chinese departure city without treating it as a route plan", () => {
    expect(proposeTripBriefFromTurn("从上海走")).toEqual({ departureCities: ["上海"] });
  });
  it("extracts an explicit Chinese month/day as a reviewable trip date", () => {
    const proposal = proposeTripBriefFromTurn("我从上海出发，12月10号左右吧");
    expect(proposal).toMatchObject({ departureCities: ["上海"], travelDateStart: expect.stringMatching(/^\d{4}-12-10$/) });
  });
});
