import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";

import { ResearchConfirmationCard } from "@/components/trips/personal-research/research-confirmation-card";
import type { PersonalResearchIntent } from "@/lib/api/contracts";
import { renderWithIntl } from "@/test/render";

const intent: PersonalResearchIntent = {
  kind: "RESEARCH_ONLY",
  requestedCapabilities: ["activities", "places"],
};

describe("ResearchConfirmationCard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the draft kind and capability list", () => {
    renderWithIntl(
      <ResearchConfirmationCard
        tripId="00000000-0000-0000-0000-000000000001"
        intent={intent}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByTestId("research-confirmation-card")).toBeInTheDocument();
    expect(screen.getByText(/RESEARCH_ONLY|仅研究/)).toBeInTheDocument();
    expect(screen.getByText(/activities/)).toBeInTheDocument();
  });

  it("calls onDismiss when the cancel button is clicked", () => {
    const onDismiss = vi.fn();
    renderWithIntl(
      <ResearchConfirmationCard
        tripId="00000000-0000-0000-0000-000000000001"
        intent={intent}
        onDismiss={onDismiss}
      />,
    );
    // Cancel is the last button inside the card (after confirm). Use the
    // last matching element by accessible name.
    const buttons = screen.getAllByRole("button", { name: "取消" });
    fireEvent.click(buttons[buttons.length - 1]);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders the confirm and cancel action affordances", () => {
    renderWithIntl(
      <ResearchConfirmationCard
        tripId="00000000-0000-0000-0000-000000000001"
        intent={intent}
        onDismiss={() => {}}
      />,
    );
    // Both action buttons exist (confirm + cancel). Phase 6 leaves the
    // disabled gating to the underlying `useConfirmResearchCommand` mutation
    // and to `api != null`; this test pins the affordance surface.
    const confirms = screen.getAllByRole("button", { name: "确认运行" });
    const cancels = screen.getAllByRole("button", { name: "取消" });
    expect(confirms.length).toBeGreaterThan(0);
    expect(cancels.length).toBeGreaterThan(0);
  });
});