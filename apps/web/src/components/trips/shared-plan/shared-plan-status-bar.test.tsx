import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { renderWithIntl } from "@/test/render";

import { SharedPlanStatusBar } from "./shared-plan-status-bar";

afterEach(cleanup);

function run(status: string) {
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
    resultPlanId: null,
    researchIntentDraft: null,
    researchIntentState: null,
  } as never;
}

describe("SharedPlanStatusBar", () => {
  it("says the plan is ready only when a plan was actually produced", () => {
    renderWithIntl(<SharedPlanStatusBar run={run("COMPLETED")} />);
    expect(screen.getByText("Plan is ready")).toBeInTheDocument();
  });

  // These two shared a translation key. A run that finished with gaps makes no
  // plan, so "Plan is ready" sat above an empty surface and read as a broken
  // page rather than the honest outcome.
  it("does not reuse that line for a run that finished with gaps", () => {
    renderWithIntl(<SharedPlanStatusBar run={run("COMPLETED_WITH_GAPS")} />);
    expect(screen.queryByText("Plan is ready")).not.toBeInTheDocument();
    expect(screen.getByText(/no plan was created/i)).toBeInTheDocument();
  });
});
