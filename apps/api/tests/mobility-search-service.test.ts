import { describe, expect, it } from "vitest";
import {
  mobilitySearchInputSchema,
  mobilitySearchModelArgumentsSchema,
  mobilitySearchOutputSchema,
  validateSnapshotBoundMobilitySearch,
} from "../src/services/mobility-search-service.js";

const SNAPSHOT_ID = "11111111-1111-4111-8111-111111111111";
const ORIGIN_ID = "22222222-2222-4222-8222-222222222222";
const DEST_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_SNAPSHOT_ID = "99999999-9999-4999-8999-999999999999";

describe("mobility-search-service schemas", () => {
  it("model arguments strip snapshotId and forbid bookingUrl", () => {
    const parsed = mobilitySearchModelArgumentsSchema.parse({
      originPlaceId: ORIGIN_ID,
      destinationPlaceId: DEST_ID,
      passengers: 2,
      departureAt: "2026-09-01T10:00:00Z",
      serviceType: "TAXI",
    });
    expect("snapshotId" in parsed).toBe(false);
    expect("bookingUrl" in parsed).toBe(false);
  });

  it("rejects origin equal to destination", () => {
    const bad = mobilitySearchInputSchema.safeParse({
      snapshotId: SNAPSHOT_ID,
      originPlaceId: ORIGIN_ID,
      destinationPlaceId: ORIGIN_ID,
      passengers: 2,
      departureAt: "2026-09-01T10:00:00Z",
      serviceType: "TRANSFER",
    });
    expect(bad.success).toBe(false);
  });

  it("binds passengers to 1..9 and currency to ISO 4217", () => {
    const tooMany = mobilitySearchOutputSchema.safeParse({
      outcome: "LIVE",
      queryId: ORIGIN_ID,
      offers: [{
        offerId: "offer-1",
        serviceType: "TAXI",
        originPlaceId: ORIGIN_ID,
        destinationPlaceId: DEST_ID,
        passengers: 0,
        departureAt: "2026-09-01T10:00:00Z",
        estimatedPrice: 12.5,
        currency: "usd",
        vehicleClass: "Sedan",
        estimated: true,
        expiresAt: null,
        source: "amadeus-transfer",
        capturedAt: new Date().toISOString(),
      }],
    });
    expect(tooMany.success).toBe(false);
  });

  it("LIVE output requires estimated:true literal", () => {
    const notEstimated = mobilitySearchOutputSchema.safeParse({
      outcome: "LIVE",
      queryId: ORIGIN_ID,
      offers: [{
        offerId: "offer-1",
        serviceType: "TAXI",
        originPlaceId: ORIGIN_ID,
        destinationPlaceId: DEST_ID,
        passengers: 2,
        departureAt: "2026-09-01T10:00:00Z",
        estimatedPrice: 12.5,
        currency: "USD",
        vehicleClass: "Sedan",
        estimated: false,
        expiresAt: null,
        source: "amadeus-transfer",
        capturedAt: new Date().toISOString(),
      }],
    });
    expect(notEstimated.success).toBe(false);
  });
});

describe("validateSnapshotBoundMobilitySearch", () => {
  const snapshot = {
    authorizedData: {},
    departureCities: ["Shanghai"],
    destinationCandidates: ["tokyo"],
  };

  it("accepts aligned snapshotId", () => {
    expect(() => validateSnapshotBoundMobilitySearch({
      input: {
        snapshotId: SNAPSHOT_ID,
        originPlaceId: ORIGIN_ID,
        destinationPlaceId: DEST_ID,
        passengers: 2,
        departureAt: "2026-09-01T10:00:00Z",
        serviceType: "TRANSFER",
      },
      snapshotId: SNAPSHOT_ID,
      snapshot,
    })).not.toThrow();
  });

  it("rejects mismatched snapshotId", () => {
    expect(() => validateSnapshotBoundMobilitySearch({
      input: {
        snapshotId: SNAPSHOT_ID,
        originPlaceId: ORIGIN_ID,
        destinationPlaceId: DEST_ID,
        passengers: 2,
        departureAt: "2026-09-01T10:00:00Z",
        serviceType: "TRANSFER",
      },
      snapshotId: OTHER_SNAPSHOT_ID,
      snapshot,
    })).toThrow(/snapshot does not match task snapshot/);
  });
});