import { describe, expect, it } from "vitest";
import {
  validatePlanOutput,
  planOutputSchema,
} from "../src/policy/plan-output-validator.js";
import type { ConstraintSnapshotData } from "../src/types/domain.js";

const snapshot: ConstraintSnapshotData = {
  authorizedData: {},
  departureCities: ["San Francisco", "Shanghai"],
  destinationCandidates: ["Tokyo", "Bangkok", "Seoul"],
  travelDateStart: "2025-08-01",
  travelDateEnd: "2025-08-07",
};

function goodPlanData() {
  return {
    destination: "Tokyo",
    flights: [
      {
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
        fixtureVersion: "2026-08-23.v1",
        isDemo: true,
      },
    ],
    stays: [
      {
        id: "stay-tyo-01",
        destination: "Tokyo",
        checkIn: "2025-08-02",
        checkOut: "2025-08-07",
        pricePerNightUsd: 180,
        style: "city_center",
        location: "Shinjuku",
        source: "Demo data",
        capturedAt: "2026-08-23T00:00:00.000Z",
        fixtureVersion: "2026-08-23.v1",
        isDemo: true,
      },
    ],
    ground: [
      {
        id: "gnd-tyo-01",
        destination: "Tokyo",
        type: "airport_transfer" as const,
        priceUsd: 35,
        provider: "Demo Transfer",
        source: "Demo data",
        capturedAt: "2026-08-23T00:00:00.000Z",
        fixtureVersion: "2026-08-23.v1",
        isDemo: true,
      },
    ],
    generatedAt: "2026-08-23T00:00:00.000Z",
  };
}

describe("plan-output-validator", () => {
  it("accepts a clean plan", () => {
    const result = validatePlanOutput(goodPlanData(), snapshot, {});
    expect(result.ok).toBe(true);
  });

  it("rejects flight origin not in snapshot.departureCities", () => {
    const data = goodPlanData();
    (data.flights[0] as { origin: string }).origin = "Mars";
    const result = validatePlanOutput(data, snapshot, {});
    expect(result).toEqual({
      ok: false,
      violations: expect.arrayContaining([
        expect.objectContaining({ path: "flights[0].origin" }),
      ]),
    });
  });

  it("rejects stay destination not in snapshot.destinationCandidates", () => {
    const data = goodPlanData();
    (data.stays[0] as { destination: string }).destination = "Atlantis";
    const result = validatePlanOutput(data, snapshot, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some(v => v.path === "stays[0].destination")).toBe(true);
    }
  });

  it("rejects red-eye flight when an authorized member forbids it", () => {
    const data = goodPlanData();
    (data.flights[0] as { isRedEye: boolean }).isRedEye = true;
    const result = validatePlanOutput(data, snapshot, { alice: { noRedEye: true } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some(v => v.path === "flights[0].isRedEye")).toBe(true);
    }
  });

  it("rejects stay style when an authorized member prefers a different style", () => {
    const data = goodPlanData();
    (data.stays[0] as { style: string }).style = "budget";
    const result = validatePlanOutput(data, snapshot, { alice: { accommodationStyle: "luxury" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some(v => v.path === "stays[0].style")).toBe(true);
    }
  });

  it("rejects passport-shaped values in plan output", () => {
    const data = goodPlanData();
    (data.flights[0] as { id: string }).id = "AB1234567";
    const result = validatePlanOutput(data, snapshot, {});
    expect(result.ok).toBe(false);
  });

  it("rejects PII key names embedded in output", () => {
    const data = goodPlanData();
    (data as unknown as { passportNumber: string }).passportNumber = "AB1234567";
    const result = validatePlanOutput(data, snapshot, {});
    expect(result.ok).toBe(false);
  });

  it("rejects missing source or capturedAt", () => {
    const data = goodPlanData();
    delete (data.flights[0] as { source?: string }).source;
    const result = validatePlanOutput(data, snapshot, {});
    expect(result.ok).toBe(false);
  });

  it("schema parses a clean plan", () => {
    expect(() => planOutputSchema.parse(goodPlanData())).not.toThrow();
  });
});