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
    researchSetupSession: null,
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

  // ─── researchSetupSession inline projection ───────────────────────────────
  // Regression for: when a CONVERSATION run carried an OPEN setup session,
  // `GET /agent-runs/:runId` returned 400 VALIDATION_REJECTED because
  // `toRunResponse` projected the row without `budgetHint`, even though the
  // response schema marks the field required (nullable).
  // See: fix(api): include budgetHint in agent run DTO setup session projection
  const openSetupBase = {
    intentRunId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    tripId: "5804c21c-21fa-4774-9c58-52c639bbf7ce",
    ownerUserId: "1ffb515f-647a-4b3f-8c76-52c1c54985ef",
    departureCity: null,
    travelDateStart: null,
    travelDateEnd: null,
    stayPreferences: null,
    flightPreferences: null,
    missing: ["DATES_MISSING", "STAY_PREFERENCES_MISSING"],
    version: 1,
    status: "OPEN" as const,
    expiresAt: "2026-09-01T12:31:35.990Z",
  };

  it("accepts an OPEN researchSetupSession with budgetHint=null", () => {
    // Mirrors what `toRunResponse` emits when the row has no budget captured.
    const parsed = agentRunResponseSchema.parse({
      ...baseRow,
      researchIntentDraft: {
        kind: "RESEARCH_ONLY",
        requestedCapabilities: ["hotel"],
        readiness: "NEEDS_SETUP",
        blockers: ["DATES_MISSING"],
        warnings: [],
        missing: ["DATES_MISSING"],
      },
      researchIntentState: "PROPOSED",
      researchSetupSession: { ...openSetupBase, budgetHint: null },
    });
    expect(parsed.researchSetupSession?.budgetHint).toBeNull();
    expect(parsed.researchSetupSession?.missing).toContain("DATES_MISSING");
  });

  it("accepts an OPEN researchSetupSession with a populated budgetHint", () => {
    const parsed = agentRunResponseSchema.parse({
      ...baseRow,
      researchIntentDraft: {
        kind: "RESEARCH_ONLY",
        requestedCapabilities: ["hotel"],
        readiness: "NEEDS_SETUP",
        blockers: ["DATES_MISSING"],
        warnings: ["BUDGET_HINT_MISSING"],
        missing: ["DATES_MISSING", "BUDGET_HINT_MISSING"],
      },
      researchIntentState: "PROPOSED",
      researchSetupSession: {
        ...openSetupBase,
        budgetHint: { amount: 1200, currency: "USD", cadence: "PER_NIGHT" },
      },
    });
    expect(parsed.researchSetupSession?.budgetHint).toEqual({
      amount: 1200,
      currency: "USD",
      cadence: "PER_NIGHT",
    });
  });

  it("rejects an OPEN researchSetupSession missing budgetHint (regression)", () => {
    // This is the exact pre-fix shape: toRunResponse projected the row but
    // never emitted `budgetHint`. Schema is `.strict()` so the field is
    // required when researchSetupSession is non-null.
    expect(() => agentRunResponseSchema.parse({
      ...baseRow,
      researchIntentDraft: null,
      researchIntentState: null,
      researchSetupSession: openSetupBase, // <-- no budgetHint
    })).toThrow(/budgetHint/);
  });

  it("rejects a budgetHint with an unknown cadence", () => {
    expect(() => agentRunResponseSchema.parse({
      ...baseRow,
      researchSetupSession: {
        ...openSetupBase,
        budgetHint: { amount: 100, currency: "USD", cadence: "PER_WEEKEND" },
      },
    })).toThrow();
  });
});
