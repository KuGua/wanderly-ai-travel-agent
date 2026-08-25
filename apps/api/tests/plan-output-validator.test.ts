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
    flights: [{
      id: "flt-sfo-tyo-01",
      origin: "San Francisco",
      destination: "Tokyo",
      departureTime: "2025-08-01T11:00:00Z",
      arrivalTime: "2025-08-02T15:00:00Z",
      priceUsd: 850,
      isRedEye: false,
      airline: "Demo Air",
      source: "Demo data",
      capturedAt: "2026-08-23T00:00:00.000Z",
    }],
    stays: [{
      id: "stay-tyo-01",
      destination: "Tokyo",
      checkIn: "2025-08-02",
      checkOut: "2025-08-07",
      pricePerNightUsd: 180,
      style: "city_center",
      location: "Shinjuku",
      source: "Demo data",
      capturedAt: "2026-08-23T00:00:00.000Z",
    }],
    ground: [{
      id: "gnd-tyo-01",
      destination: "Tokyo",
      type: "airport_transfer" as const,
      priceUsd: 35,
      provider: "Demo Transfer",
      source: "Demo data",
      capturedAt: "2026-08-23T00:00:00.000Z",
    }],
    generatedAt: "2026-08-23T00:00:00.000Z",
  };
}

function goodEvidence(): PlanProviderEvidence {
  const data = goodPlanData();
  return { flights: data.flights, stays: data.stays, ground: data.ground };
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
    data.ground[0].destination = "Atlantis";
    expect(violationsFor(data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "DESTINATION_NOT_ALLOWED", fieldPath: "destination" }),
    ]));
  });

  it("rejects red-eye flight when it differs from authorized provider evidence", () => {
    const data = goodPlanData();
    data.flights[0].isRedEye = true;
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

  it("schema parses a clean plan", () => {
    expect(() => planOutputSchema.parse(goodPlanData())).not.toThrow();
  });
});
