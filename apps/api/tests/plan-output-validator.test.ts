import { describe, expect, it } from "vitest";
import {
  PlanValidationError,
  validatePlanOutput,
  planOutputSchema,
  type PlanProviderEvidence,
} from "../src/policy/plan-output-validator.js";
import type { ConstraintSnapshotData } from "../src/types/domain.js";

const snapshot: ConstraintSnapshotData = {
  authorizedData: {},
  departureCities: ["San Francisco"],
  destinationCandidates: ["Tokyo", "Bangkok", "Seoul"],
  travelDateStart: "2025-08-01",
  travelDateEnd: "2025-08-07",
};

function goodPlanData() {
  return {
    destination: "Tokyo",
    // Phase 3 — Team Agent 协作编排: every configured candidate must appear.
    destinationCandidatesEvaluated: ["Tokyo", "Bangkok", "Seoul"],
    flights: [{
      id: "flt-sfo-tyo-01",
      providerOfferId: "flt-sfo-tyo-01",
      providerName: "amadeus",
      queryId: "00000000-0000-4000-8000-000000000001",
      origin: "San Francisco",
      destination: "Tokyo",
      segments: [{
        carrierCode: "DA", flightNumber: "101", origin: "SFO", destination: "NRT",
        departureAt: "2025-08-01T11:00:00Z", arrivalAt: "2025-08-02T15:00:00Z", duration: "PT12H",
      }],
      totalDuration: "PT12H",
      totalPrice: 850,
      currency: "USD",
      cabin: "ECONOMY" as const,
      adults: 1,
      baggageSummary: null,
      changeSummary: null,
      source: "Provider API",
      capturedAt: "2026-08-23T00:00:00.000Z",
      expiresAt: "2026-08-24T00:00:00.000Z",
      expiryProvenance: "PROVIDER_VERIFIED" as const,
    }],
    stays: [{
      id: "stay-tyo-01",
      destination: "Tokyo",
      checkIn: "2025-08-02",
      checkOut: "2025-08-07",
      pricePerNightUsd: 180,
      style: "city_center",
      location: "Shinjuku",
      source: "Provider API",
      capturedAt: "2026-08-23T00:00:00.000Z",
    }],
    generatedAt: "2026-08-23T00:00:00.000Z",
  };
}

function goodEvidence(): PlanProviderEvidence {
  const data = goodPlanData();
  return { flights: data.flights, stays: data.stays };
}

function goodActivity() {
  return {
    id: "00000000-0000-4000-8000-000000000020",
    providerOfferId: "394285P13",
    providerName: "viator" as const,
    queryId: "00000000-0000-4000-8000-000000000021",
    destination: "Tokyo",
    title: "Tokyo food walking tour",
    thumbnailUrl: "https://example.com/tokyo-tour.jpg",
    rating: 4.8,
    reviewCount: 120,
    freeCancellation: true,
    durationMinutes: { fixed: 120, from: null, to: null },
    category: "Food Tours",
    fromPrice: 42.5,
    currency: "USD",
    source: "Viator Experiences MCP" as const,
    capturedAt: "2026-08-23T00:00:00.000Z",
    expiresAt: "2099-08-23T00:15:00.000Z",
  };
}

function violationsFor(planData: unknown, testSnapshot: ConstraintSnapshotData = snapshot) {
  try {
    validatePlanOutput({ planData, snapshot: testSnapshot, evidence: goodEvidence() });
  } catch (error) {
    if (error instanceof PlanValidationError) return error.violations;
    throw error;
  }
  throw new Error("Expected plan validation to fail");
}

describe("plan-output-validator", () => {
  it("accepts a clean plan", () => {
    const result = validatePlanOutput({
      planData: goodPlanData(),
      snapshot,
      evidence: goodEvidence(),
    });
    expect(result.destination).toBe("Tokyo");
  });

  it("rejects flight origin not in snapshot.departureCities", () => {
    const data = goodPlanData();
    data.flights[0].origin = "Mars";
    expect(violationsFor(data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ORIGIN_NOT_ALLOWED", fieldPath: "flights.0.origin" }),
    ]));
  });

  it("rejects stay destination not in snapshot.destinationCandidates", () => {
    const data = goodPlanData();
    data.destination = "Atlantis";
    data.flights[0].destination = "Atlantis";
    data.stays[0].destination = "Atlantis";
    expect(violationsFor(data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "DESTINATION_NOT_ALLOWED", fieldPath: "destination" }),
    ]));
  });

  it("rejects a changed flight price when it differs from authorized provider evidence", () => {
    const data = goodPlanData();
    data.flights[0].totalPrice = 900;
    const authorizedSnapshot = {
      ...snapshot,
      authorizedData: { alice: { noRedEye: true } },
    };
    expect(violationsFor(data, authorizedSnapshot)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "EVIDENCE_MISMATCH", fieldPath: "flights.0" }),
    ]));
  });

  it("rejects stay style when it differs from authorized provider evidence", () => {
    const data = goodPlanData();
    data.stays[0].style = "budget";
    const authorizedSnapshot = {
      ...snapshot,
      authorizedData: { alice: { accommodationStyle: "luxury" } },
    };
    expect(violationsFor(data, authorizedSnapshot)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "EVIDENCE_MISMATCH", fieldPath: "stays.0" }),
    ]));
  });

  it("rejects passport-shaped values in plan output", () => {
    const data = goodPlanData();
    data.flights[0].id = "AB1234567";
    expect(violationsFor(data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "EVIDENCE_NOT_FOUND", fieldPath: "flights.0" }),
    ]));
  });

  it("rejects PII key names embedded in output", () => {
    const data = { ...goodPlanData(), passportNumber: "AB1234567" };
    expect(violationsFor(data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "STRUCTURE_INVALID", fieldPath: "planData" }),
    ]));
  });

  it("rejects missing source or capturedAt", () => {
    const data = goodPlanData();
    delete (data.flights[0] as { source?: string }).source;
    expect(violationsFor(data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "STRUCTURE_INVALID", fieldPath: "flights.0.source" }),
    ]));
  });

  it("accepts only unexpired activity evidence that exactly matches the provider result", () => {
    const activity = goodActivity();
    const planData = { ...goodPlanData(), activities: [activity] };
    const evidence = { ...goodEvidence(), activities: [activity] };

    expect(() => validatePlanOutput({
      planData,
      snapshot,
      evidence,
      requireActivities: true,
    })).not.toThrow();

    expect(() => validatePlanOutput({
      planData: {
        ...planData,
        activities: [{ ...activity, title: "Invented replacement title" }],
      },
      snapshot,
      evidence,
      requireActivities: true,
    })).toThrow(PlanValidationError);
  });

  it("schema parses a clean plan", () => {
    expect(() => planOutputSchema.parse(goodPlanData())).not.toThrow();
  });

  it("accepts an empty stay selection as a provider service gap", () => {
    const planData = { ...goodPlanData(), stays: [] };
    expect(() => validatePlanOutput({
      planData,
      snapshot,
      evidence: { flights: planData.flights, stays: [] },
    })).not.toThrow();
  });
});
