import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

import { ResearchConfirmationCard } from "@/components/trips/personal-research/research-confirmation-card";
import type { PersonalResearchIntent } from "@/lib/api/contracts";
import { renderWithIntl } from "@/test/render";

const intent: PersonalResearchIntent = {
  kind: "RESEARCH_ONLY",
  requestedCapabilities: ["activities", "places"],
};

describe("ResearchConfirmationCard — model-extracted path (Phase 2)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the draft kind and capability list", () => {
    renderWithIntl(
      <ResearchConfirmationCard
        tripId="00000000-0000-0000-0000-000000000001"
        source="model-extracted"
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
        source="model-extracted"
        intent={intent}
        onDismiss={onDismiss}
      />,
    );
    const buttons = screen.getAllByRole("button", { name: "取消" });
    fireEvent.click(buttons[buttons.length - 1]);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders the confirm and cancel action affordances", () => {
    renderWithIntl(
      <ResearchConfirmationCard
        tripId="00000000-0000-0000-0000-000000000001"
        source="model-extracted"
        intent={intent}
        onDismiss={() => {}}
      />,
    );
    const confirms = screen.getAllByRole("button", { name: "确认运行" });
    const cancels = screen.getAllByRole("button", { name: "取消" });
    expect(confirms.length).toBeGreaterThan(0);
    expect(cancels.length).toBeGreaterThan(0);
  });
});

describe("ResearchConfirmationCard — classifier-extracted path (Phase 2)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    // RTL does not unmount between tests by default; without cleanup
    // earlier classifier cards linger in the DOM and break the
    // `getAllByTestId` + filter selector pattern below.
    cleanup();
  });

  it("disables confirm when readiness is NEEDS_SETUP", () => {
    renderWithIntl(
      <ResearchConfirmationCard
        tripId="00000000-0000-0000-0000-000000000001"
        source="classifier-extracted"
        runId="00000000-0000-0000-0000-000000000099"
        intent={intent}
        readiness="NEEDS_SETUP"
        missing={["STAY_PREFERENCES_MISSING"]}
        onDismiss={() => {}}
      />,
    );
    const cards = screen.getAllByTestId("research-confirmation-card");
    const classifierCard = cards.find(
      (el) => el.getAttribute("data-source") === "classifier-extracted",
    );
    expect(classifierCard).toBeDefined();
    expect(classifierCard!.getAttribute("data-readiness")).toBe("NEEDS_SETUP");
    const confirmButtons = classifierCard!.querySelectorAll("button");
    const confirmButton = Array.from(confirmButtons).find(
      (b) => b.textContent === "确认运行",
    ) as HTMLButtonElement | undefined;
    expect(confirmButton).toBeDefined();
    expect(confirmButton!.disabled).toBe(true);
    // Missing-code copy surfaces in the warning block.
    expect(classifierCard!.textContent).toContain("尚未确认住宿偏好");
  });

  it("enables confirm when readiness is READY", () => {
    renderWithIntl(
      <ResearchConfirmationCard
        tripId="00000000-0000-0000-0000-000000000001"
        source="classifier-extracted"
        runId="00000000-0000-0000-0000-000000000099"
        intent={intent}
        readiness="READY"
        missing={[]}
        onDismiss={() => {}}
      />,
    );
    const cards = screen.getAllByTestId("research-confirmation-card");
    const classifierCard = cards.find(
      (el) => el.getAttribute("data-source") === "classifier-extracted",
    );
    const confirmButton = Array.from(classifierCard!.querySelectorAll("button"))
      .find((b) => b.textContent === "确认运行") as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(false);
  });

  it("renders the placeholder copy for NEEDS_PLACE_SELECTION", () => {
    renderWithIntl(
      <ResearchConfirmationCard
        tripId="00000000-0000-0000-0000-000000000001"
        source="classifier-extracted"
        runId="00000000-0000-0000-0000-000000000099"
        intent={intent}
        readiness="NEEDS_PLACE_SELECTION"
        missing={["ROUTE_ENDPOINTS_UNCONFIRMED"]}
        onDismiss={() => {}}
      />,
    );
    const cards = screen.getAllByTestId("research-confirmation-card");
    const classifierCard = cards.find(
      (el) => el.getAttribute("data-source") === "classifier-extracted",
    );
    expect(classifierCard!.textContent).toContain("需要先选择路线端点");
    expect(classifierCard!.textContent).toContain("尚未选择路线端点");
  });
});
