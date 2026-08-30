import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";

import { ResearchRunCard } from "@/components/trips/personal-research/research-run-card";
import type { ResearchStageEvent } from "@/lib/api/contracts";
import { renderWithIntl } from "@/test/render";

function makeStage(stage: ResearchStageEvent["stage"]): ResearchStageEvent {
  return {
    event: "research.stage",
    runId: "00000000-0000-0000-0000-000000000001",
    generationAttempt: 0,
    stage,
  };
}

describe("ResearchRunCard", () => {
  it("renders the run id and accumulated stages", () => {
    const stages = [
      makeStage("SNAPSHOT_CREATED"),
      makeStage("RESEARCHING"),
      makeStage("COMPLETED"),
    ];
    renderWithIntl(<ResearchRunCard runId="run-12345678" stages={stages} outcome="COMPLETED" />);
    expect(screen.getByTestId("research-run-card")).toHaveAttribute(
      "data-run-id",
      "run-12345678",
    );
    expect(screen.getByText(/快照已建/)).toBeInTheDocument();
    expect(screen.getByText(/研究进行中/)).toBeInTheDocument();
    expect(screen.getByText(/结果：已完成/)).toBeInTheDocument();
  });

  it("falls back to a placeholder when no stages have arrived yet", () => {
    renderWithIntl(<ResearchRunCard runId="run-x" stages={[]} outcome={null} />);
    expect(screen.getByText(/等待阶段/)).toBeInTheDocument();
  });

  it("invokes onView when the view-latest-result link is clicked", () => {
    const onView = vi.fn();
    renderWithIntl(
      <ResearchRunCard runId="run-y" stages={[]} outcome="COMPLETED" onView={onView} />,
    );
    const buttons = screen.getAllByRole("button");
    const view = buttons.find((b) => b.textContent === "查看最新结果");
    expect(view).toBeDefined();
    fireEvent.click(view!);
    expect(onView).toHaveBeenCalledTimes(1);
  });
});