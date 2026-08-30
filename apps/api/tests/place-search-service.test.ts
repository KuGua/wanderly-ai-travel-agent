import { describe, expect, it } from "vitest";
import {
  PLACE_SEARCH_MAX_PER_RUN,
  PLACE_SEARCH_MAX_RESULTS,
  placeSearchInputSchema,
  placeSearchModelArgumentsSchema,
  placeSearchOutputSchema,
  validateSnapshotBoundPlaceSearch,
} from "../src/services/place-search-service.js";

const SNAPSHOT_ID = "11111111-1111-4111-8111-111111111111";
const TOKYO_ID = "22222222-2222-4222-8222-222222222222";
const OSAKA_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_SNAPSHOT_ID = "99999999-9999-4999-8999-999999999999";

describe("place-search-service schemas", () => {
  it("rejects coordinates / provider fields in model input", () => {
    const bad = placeSearchModelArgumentsSchema.safeParse({
      destinationId: "tokyo",
      keyword: "sushi",
      category: "RESTAURANT",
      latitude: 35.68,
      longitude: 139.69,
    });
    expect(bad.success).toBe(false);
  });

  it("strips snapshotId from model arguments", () => {
    const parsed = placeSearchModelArgumentsSchema.parse({
      destinationId: "tokyo",
      keyword: "sushi",
      category: "RESTAURANT",
    });
    expect("snapshotId" in parsed).toBe(false);
  });

  it("rejects keyword over the 160-char budget", () => {
    const bad = placeSearchInputSchema.safeParse({
      snapshotId: SNAPSHOT_ID,
      destinationId: "tokyo",
      keyword: "x".repeat(161),
      category: "ATTRACTION",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects categories outside the allow-list", () => {
    const bad = placeSearchInputSchema.safeParse({
      snapshotId: SNAPSHOT_ID,
      destinationId: "tokyo",
      keyword: "sushi",
      category: "BUSINESS",
    });
    expect(bad.success).toBe(false);
  });

  it("output schema bounds LIVE candidates to 5 and rejects empty", () => {
    expect(PLACE_SEARCH_MAX_RESULTS).toBe(5);
    const valid = placeSearchOutputSchema.safeParse({
      outcome: "LIVE",
      queryId: TOKYO_ID,
      candidates: [{
        candidateId: OSAKA_ID,
        displayName: "Sushi place",
        kind: "RESTAURANT",
        countryCode: "JP",
        cityName: "Tokyo",
        longitude: 139.69,
        latitude: 35.68,
        confidence: 0.9,
        needsUserConfirmation: false,
        source: "ors",
        capturedAt: new Date().toISOString(),
      }],
    });
    expect(valid.success).toBe(true);
    const empty = placeSearchOutputSchema.safeParse({
      outcome: "LIVE",
      queryId: TOKYO_ID,
      candidates: [],
    });
    expect(empty.success).toBe(false);
  });

  it("per-run cap constant is 6", () => {
    expect(PLACE_SEARCH_MAX_PER_RUN).toBe(6);
  });
});

describe("validateSnapshotBoundPlaceSearch", () => {
  const snapshot = {
    authorizedData: {},
    departureCities: ["Shanghai"],
    destinationCandidates: ["tokyo", "osaka"],
  };

  it("accepts destination in snapshot candidates", () => {
    expect(() => validateSnapshotBoundPlaceSearch({
      input: {
        snapshotId: SNAPSHOT_ID,
        destinationId: "tokyo",
        keyword: "ramen",
        category: "RESTAURANT",
      },
      snapshotId: SNAPSHOT_ID,
      snapshot,
    })).not.toThrow();
  });

  it("rejects destination outside snapshot candidates", () => {
    expect(() => validateSnapshotBoundPlaceSearch({
      input: {
        snapshotId: SNAPSHOT_ID,
        destinationId: "paris",
        keyword: "ramen",
        category: "RESTAURANT",
      },
      snapshotId: SNAPSHOT_ID,
      snapshot,
    })).toThrow(/destination is not in snapshot candidates/);
  });

  it("rejects mismatched snapshotId", () => {
    expect(() => validateSnapshotBoundPlaceSearch({
      input: {
        snapshotId: SNAPSHOT_ID,
        destinationId: "tokyo",
        keyword: "ramen",
        category: "RESTAURANT",
      },
      snapshotId: OTHER_SNAPSHOT_ID,
      snapshot,
    })).toThrow(/snapshot does not match task snapshot/);
  });

  it("rejects private markers in keyword", () => {
    expect(() => validateSnapshotBoundPlaceSearch({
      input: {
        snapshotId: SNAPSHOT_ID,
        destinationId: "tokyo",
        keyword: "owner-only ramen",
        category: "RESTAURANT",
      },
      snapshotId: SNAPSHOT_ID,
      snapshot,
    })).toThrow(/private markers/);
  });
});