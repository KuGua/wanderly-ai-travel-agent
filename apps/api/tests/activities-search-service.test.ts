import { describe, expect, it } from "vitest";

import { validateSnapshotBoundActivitiesSearch } from "../src/services/activities-search-service.js";
import { activitiesMatrixToGaps } from "../src/services/activities-research-matrix-service.js";

const snapshot = {
  authorizedData: {},
  departureCities: ["SFO"],
  destinationCandidates: ["Paris", "Tokyo"],
  travelDateStart: "2026-09-15",
  travelDateEnd: "2026-09-17",
};

describe("validateSnapshotBoundActivitiesSearch", () => {
  it("accepts only exact snapshot destinations and server-bound authority", () => {
    expect(validateSnapshotBoundActivitiesSearch({
      input: {
        snapshotId: "00000000-0000-4000-8000-000000000010",
        destinationId: "Paris",
        theme: "CULTURE",
        locale: "en",
      },
      snapshotId: "00000000-0000-4000-8000-000000000010",
      snapshot,
    })).toMatchObject({ destinationId: "Paris", theme: "CULTURE" });
  });

  it("rejects destinations, dates and snapshot IDs outside server authority", () => {
    expect(() => validateSnapshotBoundActivitiesSearch({
      input: {
        snapshotId: "00000000-0000-4000-8000-000000000010",
        destinationId: "Berlin",
        locale: "en",
      },
      snapshotId: "00000000-0000-4000-8000-000000000010",
      snapshot,
    })).toThrow("not in snapshot candidates");

    expect(() => validateSnapshotBoundActivitiesSearch({
      input: {
        snapshotId: "00000000-0000-4000-8000-000000000011",
        destinationId: "Paris",
        locale: "en",
      },
      snapshotId: "00000000-0000-4000-8000-000000000010",
      snapshot,
    })).toThrow("does not match task snapshot");

    expect(() => validateSnapshotBoundActivitiesSearch({
      input: {
        snapshotId: "00000000-0000-4000-8000-000000000010",
        destinationId: "Paris",
        locale: "en",
      },
      snapshotId: "00000000-0000-4000-8000-000000000010",
      snapshot: { ...snapshot, travelDateEnd: undefined },
    })).toThrow("requires snapshot travel dates");
  });
});

describe("activitiesMatrixToGaps", () => {
  it("turns attempted UNAVAILABLE cells into bounded gaps without treating LIVE or MISSING as evidence", () => {
    expect(activitiesMatrixToGaps([
      { destinationId: "Paris", outcome: "LIVE" },
      { destinationId: "Tokyo", outcome: "UNAVAILABLE", code: "RATE_LIMITED" },
      { destinationId: "Seoul", outcome: "MISSING" },
    ])).toEqual([{ capability: "activities", code: "RATE_LIMITED", destinationId: "Tokyo" }]);
  });
});
