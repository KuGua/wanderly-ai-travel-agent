/**
 * Trip Response Schema — quick-orchestration `pinnedSession` projection.
 *
 * The server-managed pinned session lives on `shared_trips.pinned_session_id`
 * and surfaces as `pinnedSession` on both `tripSummarySchema` and the
 * `trip` object inside `tripDetailsResponseSchema`. The field is
 * `.nullable()` and `.optional()` so legacy clients that do not know
 * about it still parse cleanly.
 *
 * Ref: C:\Users\dongc\.claude\plans\vectorized-scribbling-thimble.md §3
 */

import { describe, expect, it } from "vitest";

import {
  tripDetailsResponseSchema,
  tripPinnedSessionSchema,
  tripSummarySchema,
} from "../../src/types/schemas.js";

const basePinned = {
  agentTaskRunId: "00000000-0000-4000-8000-000000000001",
  operation: "RESEARCH" as const,
  status: "COMPLETED" as const,
  destinationCandidates: ["Tokyo", "Kyoto"],
  travelDays: 7,
  generatedAt: "2026-10-01T00:00:00.000Z",
  pinnedAt: "2026-10-01T00:00:00.000Z",
};

describe("tripPinnedSessionSchema", () => {
  it("accepts a complete pinned-session payload", () => {
    const result = tripPinnedSessionSchema.safeParse(basePinned);
    expect(result.success).toBe(true);
  });

  it("accepts travelDays = null (no dates on the trip)", () => {
    const result = tripPinnedSessionSchema.safeParse({
      ...basePinned,
      travelDays: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts COMPLETED_WITH_GAPS status (research finished with gaps)", () => {
    const result = tripPinnedSessionSchema.safeParse({
      ...basePinned,
      status: "COMPLETED_WITH_GAPS",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown operation", () => {
    const result = tripPinnedSessionSchema.safeParse({
      ...basePinned,
      operation: "BOOKING",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a status outside the bounded enum", () => {
    const result = tripPinnedSessionSchema.safeParse({
      ...basePinned,
      status: "WIPED_OUT",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid generatedAt (not ISO 8601)", () => {
    const result = tripPinnedSessionSchema.safeParse({
      ...basePinned,
      generatedAt: "not-a-date",
    });
    expect(result.success).toBe(false);
  });
});

describe("tripSummarySchema — pinnedSession projection", () => {
  const baseTripSummary = {
    id: "00000000-0000-4000-8000-000000000010",
    name: "Tokyo trip",
    status: "PLANNING" as const,
    departureCities: ["San Francisco"],
    destinationCandidates: ["Tokyo"],
    travelDateStart: "2026-10-01",
    travelDateEnd: "2026-10-08",
    archivedAt: null,
    archiveReason: null,
    memberCount: 1,
    role: "CREATOR" as const,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
    displayState: "IN_PROGRESS" as const,
    latestPlan: null,
    nextAction: null,
  };

  it("accepts pinnedSession: null (no run pinned yet)", () => {
    const result = tripSummarySchema.safeParse({
      ...baseTripSummary,
      pinnedSession: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a populated pinnedSession", () => {
    const result = tripSummarySchema.safeParse({
      ...baseTripSummary,
      pinnedSession: basePinned,
    });
    expect(result.success).toBe(true);
  });

  it("omitting pinnedSession still parses (legacy clients)", () => {
    const result = tripSummarySchema.safeParse(baseTripSummary);
    expect(result.success).toBe(true);
  });
});

describe("tripDetailsResponseSchema — pinnedSession on the trip object", () => {
  const baseTripDetail = {
    id: "00000000-0000-4000-8000-000000000010",
    name: "Tokyo trip",
    createdBy: "00000000-0000-4000-8000-000000000011",
    status: "PLANNING" as const,
    departureCities: ["San Francisco"],
    destinationCandidates: ["Tokyo"],
    travelDateStart: "2026-10-01",
    travelDateEnd: "2026-10-08",
    archivedAt: null,
    archiveReason: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
  };

  it("accepts pinnedSession: null on the embedded trip object", () => {
    const result = tripDetailsResponseSchema.safeParse({
      trip: {
        ...baseTripDetail,
        pinnedSession: null,
      },
      callerRole: "CREATOR",
      members: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a populated pinnedSession", () => {
    const result = tripDetailsResponseSchema.safeParse({
      trip: {
        ...baseTripDetail,
        pinnedSession: basePinned,
      },
      callerRole: "CREATOR",
      members: [],
    });
    expect(result.success).toBe(true);
  });
});