/**
 * Trip Pinned Session — wire-contract parity test (web side).
 *
 * Mirrors apps/api/tests/contracts/trip-pinned-session-schema.test.ts.
 * The web-side Zod schema must accept exactly the same payload shapes
 * that the server emits; a drift here means the PinnedResultCard will
 * silently render `null` for a legitimately-pinned run.
 */

import { describe, expect, it } from "vitest";

import {
  tripPinnedSessionSchema,
  tripSummarySchema,
  tripDetailSchema,
} from "@/lib/api/contracts";

describe("web tripPinnedSessionSchema", () => {
  const basePinned = {
    agentTaskRunId: "00000000-0000-4000-8000-000000000001",
    operation: "RESEARCH" as const,
    status: "COMPLETED" as const,
    destinationCandidates: ["Tokyo"],
    travelDays: 7,
    generatedAt: "2026-10-01T00:00:00.000Z",
    pinnedAt: "2026-10-01T00:00:00.000Z",
  };

  it("accepts a complete payload", () => {
    expect(tripPinnedSessionSchema.safeParse(basePinned).success).toBe(true);
  });

  it("accepts travelDays = null", () => {
    expect(
      tripPinnedSessionSchema.safeParse({ ...basePinned, travelDays: null }).success,
    ).toBe(true);
  });

  it("rejects an unknown operation", () => {
    expect(
      tripPinnedSessionSchema.safeParse({ ...basePinned, operation: "BOOKING" }).success,
    ).toBe(false);
  });

  it("rejects a malformed status", () => {
    expect(
      tripPinnedSessionSchema.safeParse({ ...basePinned, status: "WIPED" }).success,
    ).toBe(false);
  });
});

describe("web tripSummarySchema with pinnedSession", () => {
  const baseSummary = {
    id: "00000000-0000-4000-8000-000000000010",
    name: "Trip",
    status: "PLANNING" as const,
    departureCities: ["San Francisco"],
    destinationCandidates: ["Tokyo"],
    travelDateStart: null,
    travelDateEnd: null,
    archivedAt: null,
    archiveReason: null,
    memberCount: 1,
    role: "CREATOR" as const,
    createdAt: "2026-09-01T00:00:00.000Z",
  };

  it("accepts pinnedSession: null", () => {
    expect(tripSummarySchema.safeParse({ ...baseSummary, pinnedSession: null }).success).toBe(true);
  });

  it("omits pinnedSession when not present (legacy clients)", () => {
    expect(tripSummarySchema.safeParse(baseSummary).success).toBe(true);
  });
});

describe("web tripDetailSchema with pinnedSession", () => {
  const baseDetail = {
    id: "00000000-0000-4000-8000-000000000010",
    name: "Trip",
    createdBy: "00000000-0000-4000-8000-000000000011",
    status: "PLANNING" as const,
    departureCities: ["San Francisco"],
    destinationCandidates: ["Tokyo"],
    travelDateStart: null,
    travelDateEnd: null,
    archivedAt: null,
    archiveReason: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
  };

  it("accepts a populated pinnedSession", () => {
    expect(
      tripDetailSchema.safeParse({
        ...baseDetail,
        pinnedSession: {
          agentTaskRunId: "00000000-0000-4000-8000-000000000001",
          operation: "RESEARCH",
          status: "COMPLETED",
          destinationCandidates: ["Tokyo"],
          travelDays: 7,
          generatedAt: "2026-10-01T00:00:00.000Z",
          pinnedAt: "2026-10-01T00:00:00.000Z",
        },
      }).success,
    ).toBe(true);
  });
});