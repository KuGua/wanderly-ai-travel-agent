import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

import { SharedPlanView } from "./shared-plan-view";
import { renderWithIntl } from "@/test/render";
import { TravelApiError } from "@/lib/api/errors";
import type { TravelApi } from "@/lib/api";

const TRIP_ID = "00000000-0000-4000-8000-000000000001";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function buildApi(overrides: Partial<TravelApi> = {}): TravelApi {
  return {
    getMyProfile: vi.fn(),
    updateMyProfile: vi.fn(),
    getTrips: vi.fn(),
    getTrip: vi.fn(),
    getLocationReference: vi.fn(),
    getLocationIntroduction: vi.fn(),
    getTripThreads: vi.fn(),
    createTripThread: vi.fn(),
    getOrCreateDefaultTripThread: vi.fn(),
    getOwnerConversation: vi.fn(),
    submitConversationTurn: vi.fn(),
    getAgentRun: vi.fn(),
    cancelAgentRun: vi.fn(),
    subscribeAgentRun: vi.fn(),
    startExploration: vi.fn(),
    activateTrip: vi.fn(),
    updateTripTitle: vi.fn(),
    saveTripSearchPreferences: vi.fn(),
    startPlanning: vi.fn(),
    getLatestPlanningRun: vi.fn(),
    getLatestPlan: vi.fn(),
    getProfileMemory: vi.fn(),
    updateMemoryFact: vi.fn(),
    deleteMemoryFact: vi.fn(),
    confirmMemoryProposal: vi.fn(),
    dismissMemoryProposal: vi.fn(),
    getTripMemoryOverrides: vi.fn(),
    getTripMemoryGroupDecisions: vi.fn(),
    saveTripMemoryOverride: vi.fn(),
    saveTripMemoryGroupDecision: vi.fn(),
    deleteTripMemory: vi.fn(),
    rememberHighlight: vi.fn(),
    getPreferenceCard: vi.fn(),
    resolvePreferenceCard: vi.fn(),
    getMemoryNotes: vi.fn(),
    deleteMemoryNote: vi.fn(),
    listTripPlans: vi.fn().mockResolvedValue({ tripId: TRIP_ID, proposed: [], active: [], stale: [] }),
    listAdoptionVotes: vi.fn().mockResolvedValue({
      planId: "00000000-0000-4000-8000-000000000002",
      votesAccepted: 0,
      votesRequired: 0,
      hasBlocker: false,
      currentUserDecision: null,
    }),
    castAdoptionVote: vi.fn().mockResolvedValue({
      planId: "00000000-0000-4000-8000-000000000002",
      outcome: "CAST",
      votesAccepted: 0,
      votesRequired: 0,
    }),
    ...overrides,
  };
}

describe("SharedPlanView — Phase 1 states", () => {
  it("renders the empty state when no run and no plans exist", async () => {
    const api = buildApi({
      listTripPlans: vi.fn().mockResolvedValue({ tripId: TRIP_ID, proposed: [], active: [], stale: [] }),
    });
    const { findByTestId } = renderWithIntl(<SharedPlanView tripId={TRIP_ID} />, { api });
    const empty = await findByTestId("shared-plan-empty");
    expect(empty).toBeDefined();
  });

  it("renders a generic error when listTripPlans rejects with a 5xx", async () => {
    const api = buildApi({
      listTripPlans: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const { findByRole } = renderWithIntl(<SharedPlanView tripId={TRIP_ID} />, { api });
    const err = await findByRole("alert");
    expect(err.textContent).toContain("We could not load the shared plan.");
  });

  it("renders the forbidden error when listTripPlans rejects with 403", async () => {
    // Signature: (message, statusCode, error, correlationId, options?).
    const api = buildApi({
      listTripPlans: vi.fn().mockRejectedValue(new TravelApiError("forbidden", 403, "Forbidden", null)),
    });
    const { findByRole } = renderWithIntl(<SharedPlanView tripId={TRIP_ID} />, { api });
    const err = await findByRole("alert");
    expect(err.textContent).toContain("no longer have access");
  });

  it("renders the proposal card when a plan exists (Phase 3 placeholder)", async () => {
    const api = buildApi({
      listTripPlans: vi.fn().mockResolvedValue({
        tripId: TRIP_ID,
        proposed: [
          {
            id: "00000000-0000-0000-4000-000000000010",
            version: 1,
            status: "PROPOSED",
            snapshotId: "00000000-0000-0000-4000-000000000011",
            generatedAt: "2026-09-01T00:00:00.000Z",
            destination: "Tokyo",
            destinationCandidatesEvaluated: ["Tokyo"],
            replacedByPlanId: null,
            staleReason: null,
            planData: {},
          },
        ],
        active: [],
        stale: [],
      }),
    });
    const { findByTestId } = renderWithIntl(<SharedPlanView tripId={TRIP_ID} />, { api });
    const card = await findByTestId("plan-proposal-card-00000000-0000-0000-4000-000000000010");
    expect(card.textContent).toContain("Tokyo");
  });

  it("explains a completed shared-planning run with gaps instead of showing a misleading empty state", async () => {
    const runId = "00000000-0000-4000-8000-000000000099";
    const api = buildApi({
      getLatestPlanningRun: vi.fn().mockResolvedValue({
        run: {
          runId,
          operation: "RESEARCH",
          status: "COMPLETED_WITH_GAPS",
          generationAttempt: 0,
          attemptCount: 1,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:01:00.000Z",
          finishedAt: "2026-09-01T00:01:00.000Z",
          errorCode: null,
          assistantMessageId: null,
          resultPlanId: null,
          researchIntentDraft: null,
          researchIntentState: null,
        },
      }),
      getLatestResearchResult: vi.fn().mockResolvedValue({
        result: {
          id: "00000000-0000-4000-8000-000000000098",
          tripId: TRIP_ID,
          snapshotId: "00000000-0000-4000-8000-000000000097",
          agentTaskRunId: runId,
          status: "COMPLETED_WITH_GAPS",
          serviceGaps: [{ capability: "flight", code: "NO_RESULTS", destinationId: "Shanghai" }],
          resultPlanId: null,
          createdAt: "2026-09-01T00:01:00.000Z",
        },
      }),
    });
    const { findByTestId, findByText } = renderWithIntl(<SharedPlanView tripId={TRIP_ID} />, { api });
    expect(await findByTestId("shared-plan-gaps")).toBeDefined();
    expect(await findByText("flight: NO_RESULTS")).toBeDefined();
  });
});
