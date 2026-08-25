import { describe, expect, it } from "vitest";

import { locationReferenceResponseSchema, profileResponseSchema, tripsResponseSchema } from "./contracts";
import { testProfileResponse, testTripsResponse } from "@/test/api-fixtures";

describe("API contracts", () => {
  it("accepts the canonical nullable Profile and Trip fixture shapes", () => {
    expect(profileResponseSchema.parse(testProfileResponse)).toEqual(testProfileResponse);
    expect(tripsResponseSchema.parse(testTripsResponse)).toEqual(testTripsResponse);
  });

  it("rejects a Profile missing canonical fields", () => {
    expect(() => profileResponseSchema.parse({
      profile: { id: "not-enough-fields", displayName: "Traveler" },
    })).toThrow();
  });

  it("rejects unconfirmed Trip dashboard fields in place of the canonical contract", () => {
    expect(() => tripsResponseSchema.parse({
      trips: [{
        id: "44444444-4444-4444-8444-444444444444",
        name: "Asia Trip",
        status: "PLANNING",
        latestPlanStatus: "STALE",
        actionRequired: true,
      }],
    })).toThrow();
  });

  it("accepts only an explicitly non-authoritative location reference", () => {
    expect(locationReferenceResponseSchema.parse({
      outcome: "REFERENCE",
      country: "Portugal",
      countryCode: "PT",
      admin1: "Lisbon",
      admin1Code: "PT-11",
      nearestCity: "Lisbon",
      distanceKm: 0,
      source: "Natural Earth + GeoNames",
      datasetVersion: "2026-08-demo.1",
      checkedAt: "2026-08-25T00:00:00.000Z",
      isTravelFact: false,
    }).isTravelFact).toBe(false);
  });
});
