import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TravelApi } from "@/lib/api";
import type { TripsResponse } from "@/lib/api/contracts";
import { AuthContext } from "@/lib/auth/auth-provider";
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

const signedInAuth = {
  status: "SIGNED_IN" as const,
  user: { username: "traveler" },
  error: null,
  busy: false,
  sessionRevision: 0,
  getAccessToken: vi.fn().mockResolvedValue("access-token"),
  signIn: vi.fn().mockResolvedValue(true),
  signOut: vi.fn().mockResolvedValue(true),
};

function makeApi(trips: TripsResponse["trips"]): TravelApi {
  return {
    getMyProfile: vi.fn().mockResolvedValue({ profile: null }),
    getTrips: vi.fn().mockResolvedValue({ trips }),
  } as unknown as TravelApi;
}

function renderAuthenticatedDashboard(api: TravelApi) {
  return renderWithIntl(
    <AuthContext.Provider value={signedInAuth}>
      <HomeDashboard />
    </AuthContext.Provider>,
    { api },
  );
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

    renderAuthenticatedDashboard(api);
    fireEvent.click(screen.getByRole("button", { name: "New trip" }));

    await waitFor(() => expect(startExploration).toHaveBeenCalledTimes(1));
    expect(startExploration.mock.calls[0][0].requestId).toMatch(/^[0-9a-f-]{36}$/i);
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith(`/trips/${TRIP_ID}?thread=${THREAD_ID}`));
  });

  // The compact header shortcut and the card use different accessible names.
  // Target the named card link so this assertion keeps covering the Draft in
  // the active grid even while the header also points at the same trip.
  it("shows an unarchived Draft in the default active list", async () => {
    renderAuthenticatedDashboard(makeApi([planningTrip, draftTrip]));

    await waitFor(() => {
      expect(screen.getAllByRole("heading", { name: "Taipei exploration" })).toHaveLength(1);
    });

    expect(screen.getByRole("button", { name: "Active2" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue planning: Taipei exploration" })).toHaveAttribute(
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
    renderAuthenticatedDashboard(makeApi([draftTrip, archivedDraft]));

    await waitFor(() => {
      expect(screen.getAllByRole("heading", { name: "Taipei exploration" })).toHaveLength(1);
    });

    expect(screen.queryByText("Archived Taipei exploration")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Active1" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Archived1" }));
    expect(screen.getByText("Archived Taipei exploration")).toBeInTheDocument();
  });

  it("points the header's continue control at the unfinished exploration", async () => {
    // Listed planning-first, so this fails if the control just takes the head
    // of the list: a Draft is still waiting on the traveller, a plan under way
    // is waiting on us.
    renderAuthenticatedDashboard(makeApi([planningTrip, draftTrip]));

    await waitFor(() => {
      expect(screen.getByRole("link", { name: /Continue current plan/ })).toBeInTheDocument();
    });
    const control = screen.getByRole("link", { name: /Continue current plan/ });
    expect(control).toHaveAttribute("href", "/trips/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    // It names the plan it opens rather than making the reader click to find out.
    expect(control).toHaveTextContent("Taipei exploration");
  });

  it("leaves the continue control out when nothing is in progress", async () => {
    const archivedDraft = {
      ...draftTrip,
      archivedAt: "2026-08-30T01:00:00.000Z",
      archiveReason: "USER_ARCHIVED" as const,
    };
    renderAuthenticatedDashboard(makeApi([archivedDraft]));

    // Waited on the archived count, not on the header: the header renders on
    // the first frame whether or not the trips have arrived, so waiting there
    // asserts against an empty list and passes for the wrong reason.
    await waitFor(() => expect(screen.getByRole("button", { name: "Archived1" })).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /Continue current plan/ })).not.toBeInTheDocument();
  });

  it("asks a signed-out visitor to sign in instead of requesting private Home data", () => {
    const api = makeApi([]);
    renderWithIntl(
      <AuthContext.Provider value={{
        status: "SIGNED_OUT",
        user: null,
        error: null,
        busy: false,
        sessionRevision: 0,
        getAccessToken: vi.fn().mockResolvedValue(null),
        signIn: vi.fn().mockResolvedValue(false),
        signOut: vi.fn().mockResolvedValue(true),
      }}>
        <HomeDashboard />
      </AuthContext.Provider>,
      { api },
    );

    expect(screen.getByRole("heading", { name: "Your travel profile is ready when you are" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your trips are waiting for you" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Sign in" })).toHaveLength(2);
    expect(api.getMyProfile).not.toHaveBeenCalled();
    expect(api.getTrips).not.toHaveBeenCalled();
  });
});
