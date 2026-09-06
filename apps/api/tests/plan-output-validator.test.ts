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

  it("accepts a dated daily itinerary only when provider items cite selected evidence", () => {
    const data = goodPlanData();
    data.dailyItinerary = ["2025-08-01", "2025-08-02", "2025-08-03", "2025-08-04", "2025-08-05", "2025-08-06", "2025-08-07"].map((date, index) => ({
      date,
      timeZone: "destination_local",
      items: [{
        kind: index === 0 ? "FLIGHT" : "SUGGESTED_STOP",
        startTimeLocal: "09:00",
        endTimeLocal: "10:00",
        title: index === 0 ? "Arrival flight" : "Suggested stop",
        verification: index === 0 ? "PROVIDER_BACKED" : "SUGGESTED",
        ...(index === 0 ? { evidenceRef: { category: "flights", id: data.flights[0].id } } : {}),
      }],
    }));
    expect(() => validatePlanOutput({
      planData: data, snapshot, evidence: goodEvidence(), requireDailyItinerary: true,
    })).not.toThrow();
  });

  it("accepts the server-owned ready outcome and rejects mixed legacy state", () => {
    const days = ["2025-08-01", "2025-08-02", "2025-08-03", "2025-08-04", "2025-08-05", "2025-08-06", "2025-08-07"].map((date) => ({
      date,
      timeZone: "destination_local" as const,
      items: [{
        kind: "SUGGESTED_STOP" as const,
        startTimeLocal: "09:00",
        endTimeLocal: "10:00",
        title: "Suggested stop",
        verification: "SUGGESTED" as const,
      }],
    }));
    const data = {
      ...goodPlanData(),
      dailyItineraryOutcome: {
        status: "READY" as const,
        days,
        attempts: 1,
        checkedAt: "2026-09-06T12:00:00.000Z",
      },
    };
    expect(() => validatePlanOutput({
      planData: data, snapshot, evidence: goodEvidence(), requireDailyItinerary: true,
    })).not.toThrow();

    expect(violationsFor({ ...data, dailyItineraryStatus: "READY", dailyItinerary: days }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "STRUCTURE_INVALID", fieldPath: "dailyItineraryOutcome" }),
      ]));
  });

  it("rejects overlapping times and a fabricated provider-backed itinerary item", () => {
    const data = goodPlanData();
    data.dailyItinerary = [{ date: "2025-08-01", timeZone: "destination_local", items: [
      { kind: "SUGGESTED_STOP", startTimeLocal: "09:00", endTimeLocal: "11:00", title: "Suggestion", verification: "SUGGESTED" },
      { kind: "FLIGHT", startTimeLocal: "10:00", endTimeLocal: "12:00", title: "Invented flight", verification: "PROVIDER_BACKED", evidenceRef: { category: "flights", id: "missing" } },
    ] }];
    expect(violationsFor(data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "DAILY_ITINERARY_TIME_ORDER", fieldPath: "dailyItinerary.0.items.1" }),
      expect.objectContaining({ code: "DAILY_ITINERARY_EVIDENCE_REFERENCE", fieldPath: "dailyItinerary.0.items.1.evidenceRef" }),
    ]));
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

  /**
   * 2026-09-05: a refused flight request used to withhold the entire plan.
   * A trip whose flight provider answered 4xx therefore showed nothing at all,
   * even though the run had verified live accommodation and activities. Flights
   * are now a capability like any other: absent means an UNAVAILABLE row on the
   * card, not a missing plan.
   */
  /**
   * Providers take controlled airport ids; the snapshot holds the traveller's
   * own words. Comparing them as strings meant a real offer could never match
   * its own plan — every flight was both an origin the snapshot disallowed and
   * a destination that did not match, so no plan built from live flight
   * evidence could ever persist. Nothing caught it because the repo had never
   * written a plan.
   */
  it("matches a flight offer's airport ids against the snapshot's city names", () => {
    const airportPlan = {
      ...goodPlanData(),
      destination: "Tokyo",
      flights: [{ ...goodPlanData().flights[0], origin: "SFO", destination: "NRT" }],
    };
    const evidence = { ...goodEvidence(), flights: airportPlan.flights };
    const result = validatePlanOutput({ planData: airportPlan, snapshot, evidence });
    expect(result.flights[0].destination).toBe("NRT");
  });

  it("still rejects an airport that serves a different city", () => {
    const wrongPlan = {
      ...goodPlanData(),
      flights: [{ ...goodPlanData().flights[0], origin: "SFO", destination: "CDG" }],
    };
    const violations = (() => {
      try {
        validatePlanOutput({
          planData: wrongPlan,
          snapshot,
          evidence: { ...goodEvidence(), flights: wrongPlan.flights },
        });
      } catch (error) {
        if (error instanceof PlanValidationError) return error.violations;
        throw error;
      }
      throw new Error("Expected plan validation to fail");
    })();
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "DESTINATION_MISMATCH" }),
      ]),
    );
  });

  it("rejects accommodation discovery from the final plan contract", () => {
    const accommodation = {
      id: "00000000-0000-4000-8000-000000000040",
      queryId: "00000000-0000-4000-8000-000000000041",
      providerPlaceId: "W488780173",
      destinationId: "Tokyo",
      name: "Jinjiang Hotel",
      kind: "hotels",
      longitude: 121.458, latitude: 31.222,
      distanceMeters: 43, popularityTier: 7,
      source: "OpenTripMap" as const,
      attribution: "© OpenStreetMap contributors" as const,
      capturedAt: "2026-08-23T00:00:00.000Z",
      expiresAt: "2099-08-23T00:00:00.000Z",
    };
    let caught: unknown;
    try {
      validatePlanOutput({
        planData: { ...goodPlanData(), accommodations: [accommodation] },
        snapshot,
        evidence: { ...goodEvidence(), accommodations: [accommodation] },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PlanValidationError);
    expect((caught as PlanValidationError).violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "STRUCTURE_INVALID", fieldPath: "planData" }),
    ]));
  });

  it("accepts a plan with no flights when other evidence is cited", () => {
    const activity = goodActivity();
    const plan = {
      ...goodPlanData(),
      flights: [],
      activities: [activity],
      generatedAt: activity.capturedAt,
    };
    const result = validatePlanOutput({
      planData: plan,
      snapshot,
      evidence: { ...goodEvidence(), activities: [activity] },
    });
    expect(result.flights).toEqual([]);
    expect(result.activities).toHaveLength(1);
  });

  /**
   * The one thing an empty flight list must not license. Every capability may
   * be unavailable at once, and the result is still not a plan — a card naming
   * a destination and citing no verifiable fact is the shape `AGENTS.md`
   * forbids. Such a run writes the research summary instead.
   */
  it("refuses a plan that cites no evidence at all", () => {
    const violations = violationsFor({
      ...goodPlanData(),
      flights: [],
      stays: [],
    });
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "EVIDENCE_NOT_FOUND", fieldPath: "generatedAt" }),
      ]),
    );
  });

  /**
   * Multi-origin invariant, unchanged. Some flights but an origin with none
   * means one member is told there is a way to get there and another nothing —
   * that is a wrong plan, not an unavailable capability.
   */
  it("still refuses a partially covered origin set", () => {
    const violations = violationsFor(
      goodPlanData(),
      { ...snapshot, departureCities: ["San Francisco", "Singapore"] },
    );
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ORIGIN_MISSING", fieldPath: "flights" }),
      ]),
    );
  });

  it("accepts an empty stay selection as a provider service gap", () => {
    const planData = { ...goodPlanData(), stays: [] };
    expect(() => validatePlanOutput({
      planData,
      snapshot,
      evidence: { flights: planData.flights, stays: [] },
    })).not.toThrow();
  });

  /**
   * 2026-09-06: a replan put a hotel id into `stays[]`. The deterministic
   * preflight must surface that as `EVIDENCE_SLOT_MISMATCH` at `stays.0` —
   * not as a generic `EVIDENCE_NOT_FOUND` against the wrong slot's evidence.
   * The preflight's `reason` is a closed literal; the offending id must not
   * appear in any violation text.
   */
  it("flags a hotel id placed in stays as EVIDENCE_SLOT_MISMATCH without leaking the id", () => {
    const SENTINEL_HOTEL_ID = "22222222-2222-4222-8222-222222222222";
    // This is the actual model emission: a compact hotel id in `stays[]`.
    // It is not stay-shaped, so the preflight must run before strict schema
    // parsing instead of reducing the fault to STRUCTURE_INVALID.
    const planData = {
      ...goodPlanData(),
      stays: [{ id: SENTINEL_HOTEL_ID }],
      hotels: [],
    };
    const hotelFixture = {
      id: SENTINEL_HOTEL_ID,
      providerOfferId: "nuitee-1",
      queryId: "00000000-0000-4000-8000-000000000099",
      providerName: "nuitee_connect" as const,
      destinationId: "Tokyo",
      propertyId: "p1",
      propertyName: "Hotel Test",
      checkIn: "2025-08-02",
      checkOut: "2025-08-07",
      nights: 5,
      roomCount: 1,
      adultsPerRoom: [1],
      totalPrice: 1000,
      pricePerNight: 200,
      currency: "CNY",
      taxesAndFees: { status: "INCLUDED" as const },
      cancellationSummary: null,
      roomSummary: null,
      source: "Nuitee LiteAPI",
      capturedAt: "2026-08-23T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    let caught: unknown;
    try {
      validatePlanOutput({
        planData,
        snapshot,
        evidence: {
          flights: planData.flights,
          stays: [],
          hotels: [hotelFixture],
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PlanValidationError);
    const violations = (caught as PlanValidationError).violations;
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "EVIDENCE_SLOT_MISMATCH", fieldPath: "stays.0" }),
      ]),
    );
    for (const violation of violations) {
      expect(violation.reason).not.toContain(SENTINEL_HOTEL_ID);
    }
  });
});
