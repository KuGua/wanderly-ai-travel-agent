import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup } from "@testing-library/react";

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
    sessionStorage.clear();
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
    sessionStorage.clear();
  });
  afterEach(() => {
    // RTL does not unmount between tests by default; without cleanup
    // earlier classifier cards linger in the DOM and break the
    // `getAllByTestId` + filter selector pattern below.
    cleanup();
  });

  it("disables confirm when there is a hard blocker (DESTINATION_NOT_CONFIGURED)", () => {
    renderWithIntl(
      <ResearchConfirmationCard
        tripId="00000000-0000-0000-0000-000000000001"
        source="classifier-extracted"
        runId="00000000-0000-0000-0000-000000000099"
        intent={intent}
        readiness="NEEDS_SETUP"
        blockers={["DESTINATION_NOT_CONFIGURED"]}
        warnings={[]}
        missing={["DESTINATION_NOT_CONFIGURED"]}
        onDismiss={() => {}}
      />,
    );
    const cards = screen.getAllByTestId("research-confirmation-card");
    const classifierCard = cards.find(
      (el) => el.getAttribute("data-source") === "classifier-extracted",
    );
    expect(classifierCard).toBeDefined();
    expect(classifierCard!.getAttribute("data-readiness")).toBe("NEEDS_SETUP");
    const confirmButton = Array.from(classifierCard!.querySelectorAll("button"))
      .find((b) => b.textContent === "补全资料后继续") as HTMLButtonElement | undefined;
    expect(confirmButton).toBeDefined();
    expect(confirmButton!.disabled).toBe(true);
    // Blocker code copy surfaces in the amber region.
    expect(classifierCard!.textContent).toContain("尚未选择目的地");
  });

  it("enables confirm when readiness is READY (no blockers, no warnings)", () => {
    renderWithIntl(
      <ResearchConfirmationCard
        tripId="00000000-0000-0000-0000-000000000001"
        source="classifier-extracted"
        runId="00000000-0000-0000-0000-000000000099"
        intent={intent}
        readiness="READY"
        blockers={[]}
        warnings={[]}
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

  it("enables confirm with the '继续运行' label when there are only soft warnings (READY_WITH_WARNINGS)", () => {
    renderWithIntl(
      <ResearchConfirmationCard
        tripId="00000000-0000-0000-0000-000000000001"
        source="classifier-extracted"
        runId="00000000-0000-0000-0000-000000000099"
        intent={intent}
        readiness="READY_WITH_WARNINGS"
        blockers={[]}
        warnings={["STAY_PREFERENCES_MISSING"]}
        missing={["STAY_PREFERENCES_MISSING"]}
        onDismiss={() => {}}
      />,
    );
    const cards = screen.getAllByTestId("research-confirmation-card");
    const classifierCard = cards.find(
      (el) => el.getAttribute("data-source") === "classifier-extracted",
    );
    expect(classifierCard!.getAttribute("data-readiness")).toBe("READY_WITH_WARNINGS");
    const confirmButton = Array.from(classifierCard!.querySelectorAll("button"))
      .find((b) => b.textContent === "继续运行") as HTMLButtonElement;
    expect(confirmButton).toBeDefined();
    expect(confirmButton.disabled).toBe(false);
    // Soft warning surfaces in the muted region.
    const warningsRegion = classifierCard!.querySelector('[data-testid="warnings-region"]');
    expect(warningsRegion).not.toBeNull();
    expect(warningsRegion!.textContent).toContain("尚未确认住宿偏好");
  });

  it("renders the placeholder copy for NEEDS_PLACE_SELECTION", () => {
    renderWithIntl(
      <ResearchConfirmationCard
        tripId="00000000-0000-0000-0000-000000000001"
        source="classifier-extracted"
        runId="00000000-0000-0000-0000-000000000099"
        intent={intent}
        readiness="NEEDS_PLACE_SELECTION"
        blockers={["ROUTE_ENDPOINTS_UNCONFIRMED"]}
        warnings={[]}
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