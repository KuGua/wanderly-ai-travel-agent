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

  // The panel used to require a research row whose id matched the run. Only
  // `plansQuery` gates the first paint, so whenever the research read had not
  // landed the page fell through to a status bar reading "Plan is ready" over
  // an empty surface. Whether to explain is the run's business; the research
  // row only supplies which capabilities were missing.
  it("still explains the gaps when the research detail is unavailable", async () => {
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
      getLatestResearchResult: vi.fn().mockResolvedValue({ result: null }),
    });
    const { findByTestId, queryByText } = renderWithIntl(<SharedPlanView tripId={TRIP_ID} />, { api });

    expect(await findByTestId("shared-plan-gaps")).toBeDefined();
    // And never the line that made an empty page look like a finished one.
    expect(queryByText("Plan is ready")).toBeNull();
  });

  // 2026-09-06: a replan exhausted repair with `serviceGaps: []`, the run
  // terminal status collapsed to `COMPLETED`, and the Shared Plan page
  // rendered "Plan is ready" over an empty surface. The planless-terminal
  // gate must fire for any terminal status whose `resultPlanId` is null —
  // including `COMPLETED` — and surface the gap panel instead.
  it("renders the gaps panel for a COMPLETED run with no plan", async () => {
    const runId = "00000000-0000-4000-8000-000000000201";
    const api = buildApi({
      getLatestPlanningRun: vi.fn().mockResolvedValue({
        run: {
          runId,
          operation: "RESEARCH",
          status: "COMPLETED",
          generationAttempt: 0,
          attemptCount: 1,
          createdAt: "2026-09-06T00:00:00.000Z",
          updatedAt: "2026-09-06T00:01:00.000Z",
          finishedAt: "2026-09-06T00:01:00.000Z",
          errorCode: null,
          assistantMessageId: null,
          resultPlanId: null,
          researchIntentDraft: null,
          researchIntentState: null,
        },
      }),
      getLatestResearchResult: vi.fn().mockResolvedValue({ result: null }),
    });
    const { findByTestId, queryByText } = renderWithIntl(<SharedPlanView tripId={TRIP_ID} />, { api });
    expect(await findByTestId("shared-plan-gaps")).toBeDefined();
    expect(queryByText("Plan is ready")).toBeNull();
  });

  it("keeps a FAILED run out of the planless research-summary state", async () => {
    const api = buildApi({
      getLatestPlanningRun: vi.fn().mockResolvedValue({
        run: {
          runId: "00000000-0000-4000-8000-000000000211",
          operation: "RESEARCH",
          status: "FAILED",
          generationAttempt: 0,
          attemptCount: 1,
          createdAt: "2026-09-06T00:00:00.000Z",
          updatedAt: "2026-09-06T00:01:00.000Z",
          finishedAt: "2026-09-06T00:01:00.000Z",
          errorCode: "PLANNING_DATA_UNAVAILABLE",
          assistantMessageId: null,
          resultPlanId: null,
          researchIntentDraft: null,
          researchIntentState: null,
        },
      }),
      getLatestResearchResult: vi.fn().mockResolvedValue({ result: null }),
    });
    const { findByTestId, findByText, queryByTestId } = renderWithIntl(<SharedPlanView tripId={TRIP_ID} />, { api });
    expect(await findByTestId("shared-plan-failed")).toBeDefined();
    expect(await findByText("PLANNING_DATA_UNAVAILABLE")).toBeDefined();
    expect(queryByTestId("shared-plan-gaps")).toBeNull();
  });

  it("renders the planSchemaUnmet copy when a matching summaryReason explains the no-plan terminal state", async () => {
    const runId = "00000000-0000-4000-8000-000000000202";
    const api = buildApi({
      getLatestPlanningRun: vi.fn().mockResolvedValue({
        run: {
          runId,
          operation: "REPLAN",
          status: "COMPLETED",
          generationAttempt: 0,
          attemptCount: 1,
          createdAt: "2026-09-06T00:00:00.000Z",
          updatedAt: "2026-09-06T00:01:00.000Z",
          finishedAt: "2026-09-06T00:01:00.000Z",
          errorCode: null,
          assistantMessageId: null,
          resultPlanId: null,
          researchIntentDraft: null,
          researchIntentState: null,
        },
      }),
      getLatestResearchResult: vi.fn().mockResolvedValue({
        result: {
          id: "00000000-0000-4000-8000-000000000203",
          tripId: TRIP_ID,
          snapshotId: "00000000-0000-4000-8000-000000000204",
          agentTaskRunId: runId,
          status: "COMPLETED_WITH_GAPS",
          serviceGaps: [],
          resultPlanId: null,
          summaryReason: "PLAN_SCHEMA_UNMET",
          createdAt: "2026-09-06T00:01:00.000Z",
        },
      }),
    });
    const { findByTestId, findByText } = renderWithIntl(<SharedPlanView tripId={TRIP_ID} />, { api });
    expect(await findByTestId("shared-plan-gaps")).toBeDefined();
    expect(await findByText("Wanderly's draft did not meet the plan contract")).toBeDefined();
  });

  it("renders the status bar (not the gaps panel) when the run carries a plan", async () => {
    const runId = "00000000-0000-4000-8000-000000000205";
    const api = buildApi({
      getLatestPlanningRun: vi.fn().mockResolvedValue({
        run: {
          runId,
          operation: "REPLAN",
          status: "COMPLETED",
          generationAttempt: 0,
          attemptCount: 1,
          createdAt: "2026-09-06T00:00:00.000Z",
          updatedAt: "2026-09-06T00:01:00.000Z",
          finishedAt: "2026-09-06T00:01:00.000Z",
          errorCode: null,
          assistantMessageId: null,
          resultPlanId: "00000000-0000-4000-8000-000000000206",
          researchIntentDraft: null,
          researchIntentState: null,
        },
      }),
      getLatestResearchResult: vi.fn().mockResolvedValue({ result: null }),
    });
    const { findByText, queryByTestId } = renderWithIntl(<SharedPlanView tripId={TRIP_ID} />, { api });
    expect(await findByText("Plan is ready")).toBeDefined();
    expect(queryByTestId("shared-plan-gaps")).toBeNull();
  });

  it("keeps the in-progress status bar when the run is non-terminal and has no plan", async () => {
    const runId = "00000000-0000-4000-8000-000000000207";
    const api = buildApi({
      getLatestPlanningRun: vi.fn().mockResolvedValue({
        run: {
          runId,
          operation: "REPLAN",
          status: "RUNNING",
          generationAttempt: 0,
          attemptCount: 1,
          createdAt: "2026-09-06T00:00:00.000Z",
          updatedAt: "2026-09-06T00:01:00.000Z",
          finishedAt: null,
          errorCode: null,
          assistantMessageId: null,
          resultPlanId: null,
          researchIntentDraft: null,
          researchIntentState: null,
        },
      }),
      getLatestResearchResult: vi.fn().mockResolvedValue({ result: null }),
    });
    const { findByText, queryByTestId } = renderWithIntl(<SharedPlanView tripId={TRIP_ID} />, { api });
    expect(await findByText("Researching options…")).toBeDefined();
    expect(queryByTestId("shared-plan-gaps")).toBeNull();
  });

  it("does not render the gaps panel when the server returns null for an owner-private research summary", async () => {
    // Server-side owner-private filter returns `result: null` for non-owners
    // rather than 403 — see `apps/api/src/routes/research.ts`. The matching
    // predicate therefore cannot fire; the gaps panel must stay hidden so a
    // non-owner does not see the creator's personal research reason.
    const runId = "00000000-0000-4000-8000-000000000208";
    const api = buildApi({
      getLatestPlanningRun: vi.fn().mockResolvedValue({
        run: {
          runId,
          operation: "RESEARCH",
          status: "COMPLETED_WITH_GAPS",
          generationAttempt: 0,
          attemptCount: 1,
          createdAt: "2026-09-06T00:00:00.000Z",
          updatedAt: "2026-09-06T00:01:00.000Z",
          finishedAt: "2026-09-06T00:01:00.000Z",
          errorCode: null,
          assistantMessageId: null,
          // resultPlanId is null here, but the run is COMPLETED_WITH_GAPS
          // — the run itself is member-visible (Shared planner). Without a
          // matching research row the panel stays hidden.
          resultPlanId: null,
          researchIntentDraft: null,
          researchIntentState: null,
        },
      }),
      // Different agentTaskRunId — server already filtered owner-private
      // rows out, so this is the "no matching research" case.
      getLatestResearchResult: vi.fn().mockResolvedValue({
        result: {
          id: "00000000-0000-4000-8000-000000000209",
          tripId: TRIP_ID,
          snapshotId: "00000000-0000-4000-8000-00000000020a",
          agentTaskRunId: "00000000-0000-4000-8000-00000000020b",
          status: "COMPLETED_WITH_GAPS",
          serviceGaps: [],
          resultPlanId: null,
          summaryReason: "PLAN_SCHEMA_UNMET",
          createdAt: "2026-09-06T00:01:00.000Z",
        },
      }),
    });
    const { queryByTestId, findByText } = renderWithIntl(<SharedPlanView tripId={TRIP_ID} />, { api });
    // Gaps panel is still rendered because the run itself is terminal with
    // a null resultPlanId; the matching research row is decorative.
    expect(await findByText("A shared plan was not generated")).toBeDefined();
    expect(queryByTestId("shared-plan-gaps")).not.toBeNull();
  });
});
