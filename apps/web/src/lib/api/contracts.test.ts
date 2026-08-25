import { describe, expect, it } from "vitest";

import { profileResponseSchema, tripsResponseSchema } from "./contracts";
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
});
