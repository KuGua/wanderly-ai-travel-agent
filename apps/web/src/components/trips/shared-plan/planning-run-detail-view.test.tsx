import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { renderWithIntl } from "@/test/render";
import type { TravelApi } from "@/lib/api";
import type { ResearchSummaryReason } from "@/lib/api/contracts";

import { PlanningRunDetailView } from "./planning-run-detail-view";

afterEach(cleanup);

const TRIP_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "00000000-0000-4000-8000-000000000002";

/**
 * The "why no plan" line was one fixed sentence blaming live data, printed
 * whatever the cause. On 2026-09-06 it told a traveller their suppliers were
 * short of data for a run whose every provider call had succeeded and which
 * was stopped by its own turn budget.
 */
function apiReturning(summaryReason: ResearchSummaryReason | null): TravelApi {
  return {
    async getTripPlanningRunDetail() {
      return {
        run: {
          runId: RUN_ID,
          operation: "PLAN",
          status: "COMPLETED_WITH_GAPS",
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
        research: {
          id: "00000000-0000-4000-8000-000000000003",
          tripId: TRIP_ID,
          snapshotId: "00000000-0000-4000-8000-000000000004",
          agentTaskRunId: RUN_ID,
          status: "COMPLETED_WITH_GAPS",
          serviceGaps: [{ capability: "places", code: "SKILL_CONTRACT_VIOLATION" }],
          resultPlanId: null,
          summaryReason,
          offers: [],
          createdAt: "2026-09-06T00:01:00.000Z",
        },
      };
    },
  } as unknown as TravelApi;
}

async function renderWith(summaryReason: ResearchSummaryReason | null) {
  renderWithIntl(<PlanningRunDetailView tripId={TRIP_ID} runId={RUN_ID} />, { api: apiReturning(summaryReason) });
  return screen.findByRole("heading", { level: 1 });
}

describe("PlanningRunDetailView", () => {
  it("does not blame live data for a run stopped by its own turn budget", async () => {
    await renderWith("TOOL_BUDGET_EXHAUSTED");
    expect(screen.getByText(/ran out of research turns/i)).toBeInTheDocument();
    expect(screen.queryByText(/Live data did not meet/i)).not.toBeInTheDocument();
  });

  it("says a rejected draft is a plan-contract failure, not a supplier one", async () => {
    await renderWith("PLAN_SCHEMA_UNMET");
    expect(screen.getByText(/did not meet the plan contract/i)).toBeInTheDocument();
  });

  it("owns a research step we never attempted", async () => {
    await renderWith("RESEARCH_MATRIX_INCOMPLETE");
    expect(screen.getByText(/ours to fix, not a supplier problem/i)).toBeInTheDocument();
  });

  it("keeps the evidence answer for the one case that really is about data", async () => {
    await renderWith("NO_CITABLE_EVIDENCE");
    expect(screen.getByText(/No verifiable supplier fact came back/i)).toBeInTheDocument();
  });

  it("says the reason was not recorded rather than inventing one", async () => {
    // Rows written before `summary_reason` existed genuinely do not know why.
    await renderWith(null);
    expect(screen.getByText(/reason was not recorded/i)).toBeInTheDocument();
  });

  it("still attributes the gap to us, not to a provider", async () => {
    await renderWith("TOOL_BUDGET_EXHAUSTED");
    expect(screen.getByText(/rejected by our own validation/i)).toBeInTheDocument();
  });
});
