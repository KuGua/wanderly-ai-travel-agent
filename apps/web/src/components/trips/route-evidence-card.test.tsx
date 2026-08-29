import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/render";
import { RouteEvidenceCard } from "@/components/trips/route-evidence-card";
import type { RouteEvidence } from "@/lib/api/contracts";

const ROUTE: RouteEvidence = {
  id: "11111111-1111-4111-8111-111111111111",
  searchRunId: "22222222-2222-4222-8222-222222222222",
  snapshotId: "33333333-3333-4333-8333-333333333333",
  tripId: "44444444-4444-4444-8444-444444444444",
  originPlaceId: "55555555-5555-4555-8555-555555555555",
  destinationPlaceId: "66666666-6666-4666-8666-666666666666",
  mode: "WALK",
  distanceMeters: 1500,
  durationSeconds: 600,
  steps: [
    { index: 0, instruction: "Head north", distanceMeters: 800, durationSeconds: 300 },
    { index: 1, instruction: "Turn right", distanceMeters: 700, durationSeconds: 300 },
  ],
  source: "ORS Directions",
  capturedAt: "2026-08-28T00:00:00.000Z",
  refreshAfter: "2099-12-31T00:00:00.000Z",
};

describe("RouteEvidenceCard", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders distance, duration, mode, and ORS attribution", () => {
    renderWithIntl(
      <RouteEvidenceCard
        route={ROUTE}
        originLabel="Senso-ji"
        destinationLabel="Sushi Saito"
      />,
    );
    expect(screen.getByText(/Senso-ji/)).toBeDefined();
    expect(screen.getByText(/Sushi Saito/)).toBeDefined();
    expect(screen.getByText("1.5 km")).toBeDefined();
    expect(screen.getByText("10 min")).toBeDefined();
    expect(screen.getByText("Walk")).toBeDefined();
    expect(screen.getByText("Routing by ORS")).toBeDefined();
  });

  it("calls onRefresh with the route id", () => {
    const onRefresh = vi.fn();
    renderWithIntl(<RouteEvidenceCard route={ROUTE} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText("Refresh"));
    expect(onRefresh).toHaveBeenCalledWith(ROUTE.id);
  });

  it("truncates steps past the 8-step limit and surfaces the count", () => {
    const longRoute: RouteEvidence = {
      ...ROUTE,
      steps: Array.from({ length: 12 }, (_, i) => ({
        index: i,
        instruction: `Step ${i + 1}`,
        distanceMeters: 100,
        durationSeconds: 60,
      })),
    };
    renderWithIntl(<RouteEvidenceCard route={longRoute} />);
    expect(screen.getByText("4 more steps")).toBeDefined();
  });

  it("flags stale evidence via the badge", () => {
    const staleRoute: RouteEvidence = {
      ...ROUTE,
      refreshAfter: "2020-01-01T00:00:00.000Z",
    };
    renderWithIntl(<RouteEvidenceCard route={staleRoute} />);
    expect(screen.getByText("Needs refresh")).toBeDefined();
  });

  it("renders localized copy in zh", () => {
    renderWithIntl(<RouteEvidenceCard route={ROUTE} />, { locale: "zh" });
    expect(screen.getByText("步行")).toBeDefined();
    expect(screen.getByText("ORS 提供路线")).toBeDefined();
  });
});