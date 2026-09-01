/**
 * Agent Run Response Schema — Phase 0/1.
 *
 * Locks the wire-contract shape of the owner-safe DTO returned by
 * `GET /api/v1/agent-runs/:runId`. The two new fields —
 * `researchIntentDraft` and `researchIntentState` — are optional and
 * `.strict()`-bounded; the test asserts the full set of legal / illegal
 * payloads so a future change cannot silently leak place IDs, original
 * question text, or free-text destination names.
 */
import { describe, expect, it } from "vitest";

import { agentRunResponseSchema } from "../../src/types/schemas.js";

describe("agentRunResponseSchema — research intent fields (Phase 0/1)", () => {
  const baseRow = {
    runId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    operation: "CONVERSATION" as const,
    status: "RUNNING" as const,
    generationAttempt: 0,
    attemptCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
    errorCode: null,
    assistantMessageId: null,
    resultPlanId: null,
  };

  it("accepts a CONVERSATION row without the new fields (legacy / non-classified turn)", () => {
    const parsed = agentRunResponseSchema.parse({
      ...baseRow,
      researchIntentDraft: null,
      researchIntentState: null,
    });
    expect(parsed.researchIntentDraft).toBeNull();
    expect(parsed.researchIntentState).toBeNull();
  });

  it("accepts a PROPOSED draft with READY readiness", () => {
    const parsed = agentRunResponseSchema.parse({
      ...baseRow,
      researchIntentDraft: {
        kind: "RESEARCH_ONLY",
        requestedCapabilities: ["hotel"],
        readiness: "READY",
        missing: [],
      },
      researchIntentState: "PROPOSED",
    });
    expect(parsed.researchIntentDraft?.kind).toBe("RESEARCH_ONLY");
    expect(parsed.researchIntentDraft?.requestedCapabilities).toEqual(["hotel"]);
    expect(parsed.researchIntentDraft?.readiness).toBe("READY");
    expect(parsed.researchIntentState).toBe("PROPOSED");
  });

  it("accepts a NEEDS_SETUP draft with multiple missing codes", () => {
    const parsed = agentRunResponseSchema.parse({
      ...baseRow,
      researchIntentDraft: {
        kind: "PROPOSE_PLAN",
        requestedCapabilities: ["flight", "hotel"],
        readiness: "NEEDS_SETUP",
        missing: ["FLIGHT_PREFERENCES_MISSING", "STAY_PREFERENCES_MISSING"],
      },
      researchIntentState: "PROPOSED",
    });
    expect(parsed.researchIntentDraft?.readiness).toBe("NEEDS_SETUP");
    expect(parsed.researchIntentDraft?.missing).toEqual([
      "FLIGHT_PREFERENCES_MISSING",
      "STAY_PREFERENCES_MISSING",
    ]);
  });

  it("accepts a NEEDS_PLACE_SELECTION draft with ROUTE_ENDPOINTS_UNCONFIRMED", () => {
    const parsed = agentRunResponseSchema.parse({
      ...baseRow,
      researchIntentDraft: {
        kind: "RESEARCH_ONLY",
        requestedCapabilities: ["navigation"],
        readiness: "NEEDS_PLACE_SELECTION",
        missing: ["ROUTE_ENDPOINTS_UNCONFIRMED"],
      },
      researchIntentState: "PROPOSED",
    });
    expect(parsed.researchIntentDraft?.readiness).toBe("NEEDS_PLACE_SELECTION");
  });

  it("accepts a DISMISSED draft (state) with draft body still attached", () => {
    // DISMISSED drafts persist their body so re-classification can compare;
    // the state is the public lifecycle marker.
    const parsed = agentRunResponseSchema.parse({
      ...baseRow,
      researchIntentDraft: {
        kind: "RESEARCH_ONLY",
        requestedCapabilities: ["hotel"],
        readiness: "READY",
        missing: [],
      },
      researchIntentState: "DISMISSED",
    });
    expect(parsed.researchIntentState).toBe("DISMISSED");
  });

  it("accepts all 8 capabilities", () => {
    const parsed = agentRunResponseSchema.parse({
      ...baseRow,
      researchIntentDraft: {
        kind: "PROPOSE_PLAN",
        requestedCapabilities: [
          "flight", "accommodation", "hotel", "activities",
          "places", "navigation", "mobility", "readiness",
        ],
        readiness: "READY",
        missing: [],
      },
      researchIntentState: "PROPOSED",
    });
    expect(parsed.researchIntentDraft?.requestedCapabilities).toHaveLength(8);
  });

  it("accepts every documented missing code", () => {
    const allCodes = [
      "TRIP_NOT_ACTIVE",
      "DESTINATION_NOT_CONFIGURED",
      "DATES_MISSING",
      "FLIGHT_PREFERENCES_MISSING",
      "STAY_PREFERENCES_MISSING",
      "HOTEL_PROVIDER_NOT_APPROVED",
      "QUOTE_NATIONALITY_AUTHORIZATION_MISSING",
      "ROUTE_ENDPOINTS_UNCONFIRMED",
      "MODE_NOT_CHOSEN",
      // Quick orchestration — soft budget hint added in 0045.
      "BUDGET_HINT_MISSING",
    ];
    const parsed = agentRunResponseSchema.parse({
      ...baseRow,
      researchIntentDraft: {
        kind: "RESEARCH_ONLY",
        requestedCapabilities: ["hotel"],
        readiness: "NEEDS_SETUP",
        missing: allCodes,
      },
      researchIntentState: "PROPOSED",
    });
    expect(parsed.researchIntentDraft?.missing).toEqual(allCodes);
  });

  // ─── Strict rejections — invariant: never leak rich client fields ─────────
  it("rejects destinationCandidates on the researchIntentDraft body", () => {
    expect(() => agentRunResponseSchema.parse({
      ...baseRow,
      researchIntentDraft: {
        kind: "RESEARCH_ONLY",
        requestedCapabilities: ["hotel"],
        readiness: "READY",
        missing: [],
        destinationCandidates: ["Tokyo"], // spec §4.1 — MVP does not consume this
      },
      researchIntentState: "PROPOSED",
    })).toThrow();
  });

  it("rejects an unknown capability", () => {
    expect(() => agentRunResponseSchema.parse({
      ...baseRow,
      researchIntentDraft: {
        kind: "RESEARCH_ONLY",
        requestedCapabilities: ["hotel", "spacetime_travel"],
        readiness: "READY",
        missing: [],
      },
      researchIntentState: "PROPOSED",
    })).toThrow();
  });

  it("rejects an unknown missing code", () => {
    expect(() => agentRunResponseSchema.parse({
      ...baseRow,
      researchIntentDraft: {
        kind: "RESEARCH_ONLY",
        requestedCapabilities: ["hotel"],
        readiness: "NEEDS_SETUP",
        missing: ["VISA_REQUIRED"], // not in the bounded enum
      },
      researchIntentState: "PROPOSED",
    })).toThrow();
  });

  it("rejects an unknown readiness", () => {
    expect(() => agentRunResponseSchema.parse({
      ...baseRow,
      researchIntentDraft: {
        kind: "RESEARCH_ONLY",
        requestedCapabilities: ["hotel"],
        readiness: "ALMOST_READY",
        missing: [],
      },
      researchIntentState: "PROPOSED",
    })).toThrow();
  });

  it("rejects an unknown state value", () => {
    expect(() => agentRunResponseSchema.parse({
      ...baseRow,
      researchIntentDraft: null,
      researchIntentState: "PROBABLY_OK",
    })).toThrow();
  });

  it("rejects rich client fields like placeId / snapshotId on the draft body", () => {
    for (const forbidden of [
      "placeId",
      "snapshotId",
      "provider",
      "question",
      "originalQuestion",
      "currency",
      "adults",
      "lat",
      "lng",
    ]) {
      expect(() => agentRunResponseSchema.parse({
        ...baseRow,
        researchIntentDraft: {
          kind: "RESEARCH_ONLY",
          requestedCapabilities: ["hotel"],
          readiness: "READY",
          missing: [],
          [forbidden]: "leaked",
        },
        researchIntentState: "PROPOSED",
      })).toThrow();
    }
  });

  // ─── Backward-compat sanity ────────────────────────────────────────────────
  it("still accepts an empty messageSequence / resultPlanId for CONVERSATION rows", () => {
    const parsed = agentRunResponseSchema.parse({
      ...baseRow,
      researchIntentDraft: null,
      researchIntentState: null,
    });
    expect(parsed.resultPlanId).toBeNull();
    expect(parsed.assistantMessageId).toBeNull();
  });

  });
