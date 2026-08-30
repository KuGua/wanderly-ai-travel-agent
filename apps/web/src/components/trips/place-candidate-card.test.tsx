import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/render";
import { PlaceCandidateCard, TripPlaceRow } from "@/components/trips/place-candidate-card";
import type { PlaceCandidate, TripPlace } from "@/lib/api/contracts";

const BASE_CANDIDATE: PlaceCandidate = {
  candidateId: "11111111-1111-4111-8111-111111111111",
  displayName: "Senso-ji",
  kind: "ATTRACTION",
  countryCode: "JP",
  cityName: "Tokyo",
  longitude: 139.79,
  latitude: 35.71,
  confidence: 0.42,
  needsUserConfirmation: true,
  source: "ORS",
  capturedAt: "2026-08-28T00:00:00.000Z",
};

describe("PlaceCandidateCard", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the candidate name and confidence badge when confirmation is needed", () => {
    renderWithIntl(
      <PlaceCandidateCard
        candidate={BASE_CANDIDATE}
        onAdopt={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    expect(screen.getByText("Senso-ji")).toBeDefined();
    expect(screen.getByText("Attraction")).toBeDefined();
    expect(screen.getByRole("status")).toBeDefined();
  });

  it("hides the confidence badge when not needed", () => {
    renderWithIntl(
      <PlaceCandidateCard
        candidate={{ ...BASE_CANDIDATE, needsUserConfirmation: false, confidence: 0.95 }}
        onAdopt={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("invokes onAdopt with the candidate payload", () => {
    const onAdopt = vi.fn();
    renderWithIntl(
      <PlaceCandidateCard
        candidate={BASE_CANDIDATE}
        onAdopt={onAdopt}
        onDismiss={() => undefined}
      />,
    );
    fireEvent.click(screen.getByText("Add to plan"));
    expect(onAdopt).toHaveBeenCalledWith({
      candidate: BASE_CANDIDATE,
      visibility: "TEAM_VISIBLE",
      kind: "ATTRACTION",
    });
  });

  it("invokes onDismiss with the candidate id", () => {
    const onDismiss = vi.fn();
    renderWithIntl(
      <PlaceCandidateCard
        candidate={BASE_CANDIDATE}
        onAdopt={() => undefined}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByText("Dismiss"));
    expect(onDismiss).toHaveBeenCalledWith(BASE_CANDIDATE.candidateId);
  });

  it("renders localized labels in zh", () => {
    renderWithIntl(
      <PlaceCandidateCard
        candidate={BASE_CANDIDATE}
        onAdopt={() => undefined}
        onDismiss={() => undefined}
      />,
      { locale: "zh" },
    );
    expect(screen.getByText("景点")).toBeDefined();
    expect(screen.getByText("加入方案")).toBeDefined();
  });
});

describe("TripPlaceRow", () => {
  const place: TripPlace = {
    id: "11111111-1111-4111-8111-111111111111",
    tripId: "22222222-2222-4222-8222-222222222222",
    ownerUserId: "33333333-3333-4333-8333-333333333333",
    version: 1,
    visibility: "TEAM_VISIBLE",
    status: "ACTIVE",
    kind: "ATTRACTION",
    displayName: "Senso-ji",
    countryCode: "JP",
    cityName: "Tokyo",
    longitude: 139.79,
    latitude: 35.71,
    source: "ORS",
    providerPlaceId: null,
    capturedAt: "2026-08-28T00:00:00.000Z",
    createdFromRunId: null,
  };

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the saved place with status and visibility badge", () => {
    renderWithIntl(<TripPlaceRow place={place} onRevoke={() => undefined} />);
    expect(screen.getByText("Senso-ji")).toBeDefined();
    expect(screen.getByText("Remove")).toBeDefined();
  });

  it("omits the revoke action for REVOKED places", () => {
    renderWithIntl(
      <TripPlaceRow place={{ ...place, status: "REVOKED" }} onRevoke={() => undefined} />,
    );
    expect(screen.queryByText("Remove")).toBeNull();
  });

  it("invokes onRevoke with the place id", () => {
    const onRevoke = vi.fn();
    renderWithIntl(<TripPlaceRow place={place} onRevoke={onRevoke} />);
    fireEvent.click(screen.getByText("Remove"));
    expect(onRevoke).toHaveBeenCalledWith({
      placeId: place.id,
      reason: "user_revoked",
    });
  });

  it("renders localized labels in zh", () => {
    renderWithIntl(<TripPlaceRow place={place} onRevoke={() => undefined} />, { locale: "zh" });
    expect(screen.getByText("移除")).toBeDefined();
  });
});