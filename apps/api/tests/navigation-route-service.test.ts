import { describe, expect, it } from "vitest";
import {
  navigationRouteInputSchema,
  navigationRouteModelArgumentsSchema,
  navigationRouteOutputSchema,
  summarizeRouteEvidence,
  validateSnapshotBoundNavigationRoute,
} from "../src/services/navigation-route-service.js";

const SNAPSHOT_ID = "11111111-1111-4111-8111-111111111111";
const ORIGIN_ID = "22222222-2222-4222-8222-222222222222";
const DEST_ID = "33333333-3333-4333-8333-333333333333";
const TRIP_ID = "44444444-4444-4444-8444-444444444444";
const SEARCH_RUN_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_SNAPSHOT_ID = "99999999-9999-4999-8999-999999999999";

describe("navigation-route-service schemas", () => {
  it("rejects origin equal to destination", () => {
    const bad = navigationRouteInputSchema.safeParse({
      snapshotId: SNAPSHOT_ID,
      originPlaceId: ORIGIN_ID,
      destinationPlaceId: ORIGIN_ID,
      mode: "DRIVE",
    });
    expect(bad.success).toBe(false);
  });

  it("model arguments strip snapshotId", () => {
    const parsed = navigationRouteModelArgumentsSchema.parse({
      originPlaceId: ORIGIN_ID,
      destinationPlaceId: DEST_ID,
      mode: "WALK",
    });
    expect("snapshotId" in parsed).toBe(false);
  });

  it("rejects modes outside the allow-list", () => {
    const bad = navigationRouteModelArgumentsSchema.safeParse({
      originPlaceId: ORIGIN_ID,
      destinationPlaceId: DEST_ID,
      mode: "BUS",
    });
    expect(bad.success).toBe(false);
  });

  it("output schema exposes summary without geometry", () => {
    const parsed = navigationRouteOutputSchema.parse({
      outcome: "LIVE",
      routeId: ORIGIN_ID,
      summary: {
        originPlaceId: ORIGIN_ID,
        destinationPlaceId: DEST_ID,
        mode: "WALK",
        distanceMeters: 1234.5,
        durationSeconds: 600,
        stepCount: 5,
        source: "ors",
        capturedAt: new Date().toISOString(),
      },
    });
    expect(parsed.outcome).toBe("LIVE");
  });

  it("UNAVAILABLE output keeps a bounded code list", () => {
    const parsed = navigationRouteOutputSchema.parse({
      outcome: "UNAVAILABLE",
      code: "NOT_CONFIGURED",
    });
    expect(parsed.outcome).toBe("UNAVAILABLE");
    if (parsed.outcome === "UNAVAILABLE") expect(parsed.code).toBe("NOT_CONFIGURED");
  });
});

describe("summarizeRouteEvidence", () => {
  it("strips geometry and exposes step count", () => {
    const summary = summarizeRouteEvidence({
      id: ORIGIN_ID,
      searchRunId: SEARCH_RUN_ID,
      snapshotId: SNAPSHOT_ID,
      tripId: TRIP_ID,
      originPlaceId: ORIGIN_ID,
      destinationPlaceId: DEST_ID,
      mode: "DRIVE",
      distanceMeters: 1500,
      durationSeconds: 300,
      steps: [
        { index: 0, instruction: "head north", distanceMeters: 800, durationSeconds: 200 },
        { index: 1, instruction: "turn right", distanceMeters: 700, durationSeconds: 100 },
      ],
      encodedGeometry: "polyline-encoded-payload",
      source: "ors",
      capturedAt: new Date().toISOString(),
      refreshAfter: new Date().toISOString(),
    });
    expect(summary.outcome).toBe("LIVE");
    if (summary.outcome === "LIVE") {
      expect(summary.summary.stepCount).toBe(2);
      expect("encodedGeometry" in summary.summary).toBe(false);
    }
  });
});

describe("validateSnapshotBoundNavigationRoute", () => {
  const snapshot = {
    authorizedData: {},
    departureCities: ["Shanghai"],
    destinationCandidates: ["tokyo"],
  };

  it("accepts allowed mode", () => {
    expect(() => validateSnapshotBoundNavigationRoute({
      input: {
        snapshotId: SNAPSHOT_ID,
        originPlaceId: ORIGIN_ID,
        destinationPlaceId: DEST_ID,
        mode: "CYCLE",
      },
      snapshotId: SNAPSHOT_ID,
      snapshot,
    })).not.toThrow();
  });

  it("rejects mismatched snapshotId", () => {
    expect(() => validateSnapshotBoundNavigationRoute({
      input: {
        snapshotId: SNAPSHOT_ID,
        originPlaceId: ORIGIN_ID,
        destinationPlaceId: DEST_ID,
        mode: "DRIVE",
      },
      snapshotId: OTHER_SNAPSHOT_ID,
      snapshot,
    })).toThrow(/snapshot does not match task snapshot/);
  });
});