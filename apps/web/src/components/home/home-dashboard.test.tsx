import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TravelApi } from "@/lib/api";
import type { TripsResponse } from "@/lib/api/contracts";
import { renderWithIntl } from "@/test/render";

const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));

vi.mock("@/i18n/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/i18n/navigation")>();
  return { ...actual, useRouter: () => ({ push: routerPush }) };
});

import { HomeDashboard } from "./home-dashboard";

const TRIP_ID = "11111111-1111-4111-8111-111111111111";
const THREAD_ID = "22222222-2222-4222-8222-222222222222";
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
  routerPush.mockReset();
});

describe("HomeDashboard", () => {
  it("creates an idempotent Draft trip and opens its planning workspace", async () => {
    const startExploration = vi.fn().mockResolvedValue({
      trip: {
        id: TRIP_ID,
        name: "Trip Planner",
        status: "DRAFT",
        departureCities: [],
        destinationCandidates: [],
        travelDateStart: null,
        travelDateEnd: null,
        createdAt: "2026-08-30T00:00:00.000Z",
        updatedAt: "2026-08-30T00:00:00.000Z",
      },
      defaultThread: { id: THREAD_ID, tripId: TRIP_ID, scope: "TRIP", isDefault: true },
    });
    const api = {
      getMyProfile: vi.fn().mockResolvedValue({ profile: null }),
      getTrips: vi.fn().mockResolvedValue({ trips: [], nextCursor: null }),
      startExploration,
    } as unknown as TravelApi;

    renderWithIntl(<HomeDashboard />, { api });
    fireEvent.click(screen.getByRole("button", { name: "New trip" }));

    await waitFor(() => expect(startExploration).toHaveBeenCalledTimes(1));
    expect(startExploration.mock.calls[0][0].requestId).toMatch(/^[0-9a-f-]{36}$/i);
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith(`/trips/${TRIP_ID}?thread=${THREAD_ID}`));
  });

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
