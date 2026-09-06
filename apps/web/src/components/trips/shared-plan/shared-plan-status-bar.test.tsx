import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { renderWithIntl } from "@/test/render";

import { SharedPlanStatusBar } from "./shared-plan-status-bar";

afterEach(cleanup);

function run(status: string, resultPlanId: string | null = null) {
  return {
    runId: "00000000-0000-4000-8000-000000000001",
    operation: "PLAN" as const,
    status,
    generationAttempt: 0,
    attemptCount: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
    finishedAt: "2026-09-01T00:01:00.000Z",
    errorCode: null,
    assistantMessageId: null,
    resultPlanId,
    researchIntentDraft: null,
    researchIntentState: null,
  } as never;
}

describe("SharedPlanStatusBar", () => {
  it("says the plan is ready only when a plan was actually produced", () => {
    renderWithIntl(<SharedPlanStatusBar run={run("COMPLETED")} />);
    expect(screen.getByText("Plan is ready")).toBeInTheDocument();
  });

  it("explains when a run finished with gaps and no plan", () => {
    renderWithIntl(<SharedPlanStatusBar run={run("COMPLETED_WITH_GAPS")} />);
    expect(screen.queryByText("Plan is ready")).not.toBeInTheDocument();
    expect(screen.getByText(/no plan was created/i)).toBeInTheDocument();
  });

  it("reports a saved plan with gaps without claiming that no plan exists", () => {
    renderWithIntl(
      <SharedPlanStatusBar
        run={run("COMPLETED_WITH_GAPS", "00000000-0000-4000-8000-000000000002")}
      />,
    );
    expect(screen.getByText("Plan is ready with gaps to review")).toBeInTheDocument();
    expect(screen.queryByText(/no plan was created/i)).not.toBeInTheDocument();
  });
});
