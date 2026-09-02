import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  personalResearchAnswersRequestSchema,
  personalResearchConfirmRequestSchema,
  personalResearchConfirmAcceptedResponseSchema,
  personalResearchEvidenceResponseSchema,
  personalResearchEvidenceSummarySchema,
  personalResearchOperationCapabilitySchema,
  personalResearchOwnerDraftSchema,
  personalResearchReadResponseSchema,
} from "../../src/types/schemas.js";

/**
 * Schema contract tests for the DRAFT Personal Research surface. These are
 * pure Zod tests — no DB, no HTTP, no providers. They cover:
 *   - `.strict()` rejection of extra keys at every API boundary
 *   - discriminated-union exhaustiveness across 7 capabilities
 *   - the personal_research_capability enum is the 7-capability subset
 *   - visa is NOT in the capability enum (per spec §3.5 stage 4 deferred)
 *   - the answers / confirm / read / evidence envelope shapes parse
 *     strict-correct shapes and reject malformed ones.
 *
 * Source: docs/draft-personal-research-implementation.md §3.3, §3.5.
 */

const VALID_UUID_V4_A = "12345678-1234-4234-8234-123456789012";
const VALID_UUID_V4_B = "11111111-1111-4111-8111-111111111111";
const VALID_UUID_V4_C = "22222222-2222-4222-8222-222222222222";

describe("personalResearchOperationCapabilitySchema", () => {
  it("accepts every one of the 7 enabled capabilities", () => {
    for (const cap of [
      "flight.search",
      "hotel.search",
      "accommodation.discovery",
      "activities.search",
      "places.search",
      "navigation.route",
      "mobility.search",
    ]) {
      expect(personalResearchOperationCapabilitySchema.parse(cap)).toBe(cap);
    }
  });

  it("rejects visa.* (stage 4 deferred)", () => {
    expect(() => personalResearchOperationCapabilitySchema.parse("visa.readiness")).toThrow();
    expect(() => personalResearchOperationCapabilitySchema.parse("visa.search")).toThrow();
  });

  it("rejects unknown capabilities", () => {
    expect(() => personalResearchOperationCapabilitySchema.parse("taxi.search")).toThrow();
  });
});

describe("personalResearchOwnerDraftSchema (discriminated union, 7 kinds)", () => {
  it("parses a flight draft and exposes the kind discriminant", () => {
    const draft = {
      kind: "FLIGHT_SEARCH" as const,
      originId: "PEK",
      destinationId: "NRT",
      tripType: "ROUND_TRIP" as const,
      departureDate: "2026-12-01",
      returnDate: "2026-12-08",
      adults: 1,
      cabin: "ECONOMY" as const,
      currency: "USD",
    };
    const parsed = personalResearchOwnerDraftSchema.parse(draft);
    expect(parsed.kind).toBe("FLIGHT_SEARCH");
  });

  it("parses every other 6 kinds without discriminator confusion", () => {
    const samples = [
      { kind: "HOTEL_SEARCH", cityCode: "TYO", checkIn: "2026-12-01", checkOut: "2026-12-08", occupancy: { adults: 2, rooms: 1 }, currency: "USD" },
      { kind: "ACCOMMODATION_DISCOVERY", latitude: 35.68, longitude: 139.69, radiusMeters: 5000, checkIn: "2026-12-01", checkOut: "2026-12-08", occupancy: { adults: 2, rooms: 1 } },
      { kind: "ACTIVITIES_SEARCH", destinationCode: "TYO", startDate: "2026-12-01", endDate: "2026-12-08", category: null, limit: 20 },
      { kind: "PLACES_SEARCH", keyword: null, latitude: 35.68, longitude: 139.69, radiusMeters: 5000, category: "ATTRACTION", limit: 20 },
      { kind: "NAVIGATION_ROUTE", originPlaceId: VALID_UUID_V4_B, destinationPlaceId: VALID_UUID_V4_C, mode: "driving" },
      { kind: "MOBILITY_SEARCH", originPlaceId: VALID_UUID_V4_B, destinationPlaceId: VALID_UUID_V4_C, transferDateTime: "2026-12-01T08:00:00.000Z", passengers: 2, currency: "USD" },
    ];
    for (const sample of samples) {
      const parsed = personalResearchOwnerDraftSchema.parse(sample);
      expect(parsed.kind).toBe(sample.kind);
    }
  });

  it("rejects an unknown kind", () => {
    expect(() => personalResearchOwnerDraftSchema.parse({ kind: "ALIEN_SEARCH" })).toThrow();
  });
});

describe("personalResearchAnswersRequestSchema", () => {
  it("accepts a valid answers envelope and rejects extra keys (strict)", () => {
    const envelope = {
      schemaVersion: 1 as const,
      draft: {
        kind: "FLIGHT_SEARCH" as const,
        originId: "PEK",
        destinationId: "NRT",
        tripType: "ROUND_TRIP" as const,
        departureDate: "2026-12-01",
        returnDate: "2026-12-08",
        adults: 1,
        cabin: "ECONOMY" as const,
        currency: "USD",
      },
    };
    expect(() => personalResearchAnswersRequestSchema.parse(envelope)).not.toThrow();
    expect(() =>
      personalResearchAnswersRequestSchema.parse({ ...envelope, secretField: "leak" }),
    ).toThrow();
  });

  it("rejects the wrong schemaVersion literal", () => {
    expect(() =>
      personalResearchAnswersRequestSchema.parse({
        schemaVersion: 2,
        draft: { kind: "HOTEL_SEARCH", cityCode: "TYO", checkIn: "2026-12-01", checkOut: "2026-12-08", occupancy: { adults: 1, rooms: 1 }, currency: "USD" },
      }),
    ).toThrow();
  });
});

describe("personalResearchConfirmRequestSchema", () => {
  it("accepts a requestId envelope and rejects extra keys (strict)", () => {
    expect(() => personalResearchConfirmRequestSchema.parse({ requestId: VALID_UUID_V4_A })).not.toThrow();
    expect(() =>
      personalResearchConfirmRequestSchema.parse({ requestId: VALID_UUID_V4_A, extra: true }),
    ).toThrow();
  });
});

describe("personalResearchConfirmAcceptedResponseSchema", () => {
  it("parses the 202 envelope", () => {
    const out = personalResearchConfirmAcceptedResponseSchema.parse({
      runId: VALID_UUID_V4_A,
      capability: "flight.search",
      status: "QUEUED",
    });
    expect(out.capability).toBe("flight.search");
    expect(out.status).toBe("QUEUED");
  });
});

describe("personalResearchEvidenceSummarySchema (discriminated union)", () => {
  it("parses the AVAILABLE branch with a flight projection", () => {
    const out = personalResearchEvidenceSummarySchema.parse({
      outcome: "AVAILABLE",
      capability: "flight.search",
      flight: {
        offerCount: 12,
        currency: "USD",
        originIata: "PEK",
        destinationIata: "NRT",
        earliestDeparture: null,
        latestReturn: null,
      },
    });
    expect(out.outcome).toBe("AVAILABLE");
  });

  it("parses the UNAVAILABLE branch with a typed errorCode", () => {
    for (const code of ["NOT_CONFIGURED", "SEARCH_CONSTRAINTS_INCOMPLETE", "RATE_LIMITED"] as const) {
      const out = personalResearchEvidenceSummarySchema.parse({ outcome: "UNAVAILABLE", summary: { errorCode: code } });
      expect(out.outcome).toBe("UNAVAILABLE");
    }
  });

  it("parses the EXPIRED branch", () => {
    const out = personalResearchEvidenceSummarySchema.parse({ outcome: "EXPIRED" });
    expect(out.outcome).toBe("EXPIRED");
  });
});

describe("personalResearchReadResponseSchema", () => {
  it("accepts a null-draft conversation response", () => {
    const out = personalResearchReadResponseSchema.parse({
      runId: VALID_UUID_V4_A,
      capability: "flight.search",
      status: "QUEUED",
      terminal: false,
      draft: null,
      evidence: null,
    });
    expect(out.draft).toBeNull();
  });
});

describe("personalResearchEvidenceResponseSchema", () => {
  it("accepts an AVAILABLE evidence row", () => {
    const out = personalResearchEvidenceResponseSchema.parse({
      id: VALID_UUID_V4_A,
      capability: "flight.search",
      outcome: "AVAILABLE",
      providerName: "amadeus",
      source: "amadeus",
      capturedAt: "2026-09-01T08:00:00.000Z",
      expiresAt: null,
      summary: {
        outcome: "AVAILABLE",
        capability: "flight.search",
        flight: { offerCount: 1, currency: "USD", originIata: "PEK", destinationIata: "NRT", earliestDeparture: null, latestReturn: null },
      },
    });
    expect(out.outcome).toBe("AVAILABLE");
  });
});

// Type-level sanity: ensure the response schema's read shape stays
// compatible with the evidence response shape via the schema-driven
// `z.infer` type. This is a no-op runtime assertion; the typecheck is the
// real guard.
const _typeOnly: z.infer<typeof personalResearchReadResponseSchema>["evidence"] = null as unknown as z.infer<typeof personalResearchEvidenceResponseSchema>;
void _typeOnly;