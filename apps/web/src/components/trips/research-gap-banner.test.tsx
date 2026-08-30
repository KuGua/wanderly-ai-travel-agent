import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/render";
import { ResearchGapBanner } from "@/components/trips/research-gap-banner";
import type { ResearchResult } from "@/lib/api/contracts";

const BASE_RESULT: ResearchResult = {
  id: "11111111-1111-4111-8111-111111111111",
  tripId: "22222222-2222-4222-8222-222222222222",
  snapshotId: "33333333-3333-4333-8333-333333333333",
  agentTaskRunId: "44444444-4444-4444-8444-444444444444",
  status: "COMPLETED_WITH_GAPS",
  serviceGaps: [
    { capability: "flight", code: "UPSTREAM_FAILURE", destinationId: "tokyo" },
    { capability: "navigation", code: "NO_RESULTS" },
  ],
  resultPlanId: null,
  createdAt: "2026-08-29T00:00:00.000Z",
};

describe("ResearchGapBanner", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("returns null when result is null", () => {
    const { container } = renderWithIntl(<ResearchGapBanner result={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("returns null when status is COMPLETE", () => {
    const { container } = renderWithIntl(
      <ResearchGapBanner result={{ ...BASE_RESULT, status: "COMPLETE", serviceGaps: [] }} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders capability list when status is COMPLETED_WITH_GAPS", () => {
    renderWithIntl(<ResearchGapBanner result={BASE_RESULT} />);
    expect(screen.getByText("Research summary")).toBeDefined();
    expect(screen.getByText(/Flights:/)).toBeDefined();
    expect(screen.getByText(/Walking \/ driving \/ cycling:/)).toBeDefined();
  });

  it("renders localized copy in zh", () => {
    renderWithIntl(<ResearchGapBanner result={BASE_RESULT} />, { locale: "zh" });
    expect(screen.getByText("研究摘要")).toBeDefined();
    expect(screen.getByText(/航班:/)).toBeDefined();
  });

  it("orders capabilities by priority (flight first)", () => {
    renderWithIntl(
      <ResearchGapBanner
        result={{
          ...BASE_RESULT,
          serviceGaps: [
            { capability: "mobility", code: "NO_RESULTS" },
            { capability: "flight", code: "UPSTREAM_FAILURE" },
            { capability: "stay", code: "NO_RESULTS" },
          ],
        }}
      />,
    );
    const items = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(items[0]).toContain("Flights:");
    expect(items[1]).toContain("Stays:");
    expect(items[2]).toContain("Taxis");
  });
});