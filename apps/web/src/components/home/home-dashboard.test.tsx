import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TravelApi } from "@/lib/api";
import type { TripsResponse } from "@/lib/api/contracts";
import { renderWithIntl } from "@/test/render";

import { HomeDashboard } from "./home-dashboard";

const CREATED_AT = "2026-08-30T00:00:00.000Z";

const draftTrip = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Taipei exploration",
  status: "DRAFT" as const,
  departureCities: [],
  destinationCandidates: ["Taipei City"],
  travelDateStart: null,
  travelDateEnd: null,
  archivedAt: null,
  archiveReason: null,
  memberCount: 1,
  role: "CREATOR" as const,
  createdAt: CREATED_AT,
};

const planningTrip = {
  ...draftTrip,
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Osaka planning",
  status: "PLANNING" as const,
};

function makeApi(trips: TripsResponse["trips"]): TravelApi {
  return {
    getMyProfile: vi.fn().mockResolvedValue({ profile: null }),
    getTrips: vi.fn().mockResolvedValue({ trips }),
  } as unknown as TravelApi;
}

afterEach(() => {
  cleanup();
});

describe("HomeDashboard", () => {
  it("shows an unarchived Draft in the default active list and prioritizes it for continuation", async () => {
    renderWithIntl(<HomeDashboard />, { api: makeApi([planningTrip, draftTrip]) });

    await waitFor(() => {
      expect(screen.getAllByRole("heading", { name: "Taipei exploration" })).toHaveLength(2);
    });

    expect(screen.getByRole("button", { name: "Active2" })).toBeInTheDocument();
    expect(screen.getByText("Draft needs details")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue exploration" })).toHaveAttribute(
      "href",
      "/trips/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
  });

  it("keeps an archived Draft out of the default active list", async () => {
    const archivedDraft = {
      ...draftTrip,
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      name: "Archived Taipei exploration",
      archivedAt: "2026-08-30T01:00:00.000Z",
      archiveReason: "USER_ARCHIVED" as const,
    };
    renderWithIntl(<HomeDashboard />, { api: makeApi([draftTrip, archivedDraft]) });

    await waitFor(() => {
      expect(screen.getAllByRole("heading", { name: "Taipei exploration" })).toHaveLength(2);
    });

    expect(screen.queryByText("Archived Taipei exploration")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Active1" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Archived1" }));
    expect(screen.getByText("Archived Taipei exploration")).toBeInTheDocument();
  });
});
