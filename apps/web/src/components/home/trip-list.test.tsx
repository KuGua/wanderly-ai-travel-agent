import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TravelApi } from "@/lib/api";
import type { TripSummary } from "@/lib/api/contracts";
import { renderWithIntl } from "@/test/render";

import { TripList } from "./trip-list";

const TRIP_ID = "11111111-1111-4111-8111-111111111111";

function trip(overrides: Partial<TripSummary> = {}): TripSummary {
  return {
    id: TRIP_ID,
    name: "Tokyo trip",
    status: "PLANNING",
    departureCities: ["Singapore"],
    destinationCandidates: ["Tokyo"],
    travelDateStart: "2026-10-01",
    travelDateEnd: "2026-10-05",
    archivedAt: null,
    archiveReason: null,
    memberCount: 1,
    role: "CREATOR",
    createdAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

function apiWithArchive(updateTripArchive = vi.fn().mockResolvedValue({
  trip: { id: TRIP_ID, archivedAt: null, archiveReason: null, updatedAt: "2026-09-02T10:00:00.000Z" },
})) {
  return { updateTripArchive } as unknown as TravelApi;
}

// `globals` is off in vitest.config.mts, so Testing Library's automatic
// per-test cleanup never registers — without this, one test's markup is still
// mounted while the next one queries for its absence.
afterEach(cleanup);

describe("TripList", () => {
  it("renders the current identity empty state", () => {
    renderWithIntl(<TripList trips={[]} />);
    expect(screen.getByRole("heading", { name: "No trips yet" })).toBeInTheDocument();
    expect(screen.getByText(/Trip creation is a later slice/)).toBeInTheDocument();
  });

  it("lets the creator archive a trip", async () => {
    const updateTripArchive = vi.fn().mockResolvedValue({
      trip: { id: TRIP_ID, archivedAt: "2026-09-02T10:00:00.000Z", archiveReason: "USER_ARCHIVED", updatedAt: "2026-09-02T10:00:00.000Z" },
    });
    renderWithIntl(<TripList trips={[trip()]} />, { api: apiWithArchive(updateTripArchive) });

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() => expect(updateTripArchive).toHaveBeenCalledWith(TRIP_ID, { archived: true }));
  });

  it("offers to restore a trip the traveller archived", async () => {
    const updateTripArchive = vi.fn().mockResolvedValue({
      trip: { id: TRIP_ID, archivedAt: null, archiveReason: null, updatedAt: "2026-09-02T10:00:00.000Z" },
    });
    renderWithIntl(
      <TripList trips={[trip({ archivedAt: "2026-09-01T10:00:00.000Z", archiveReason: "USER_ARCHIVED" })]} />,
      { api: apiWithArchive(updateTripArchive) },
    );

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() => expect(updateTripArchive).toHaveBeenCalledWith(TRIP_ID, { archived: false }));
  });

  it("offers nothing to undo when the dates merely elapsed", () => {
    // `DATE_ELAPSED` is derived on read, not an action anyone took, so there
    // is no user decision here for a restore button to reverse.
    renderWithIntl(
      <TripList trips={[trip({ archivedAt: "2026-09-01T10:00:00.000Z", archiveReason: "DATE_ELAPSED" })]} />,
      { api: apiWithArchive() },
    );

    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  });

  it("hides archiving from a member who did not create the trip", () => {
    // Matches the API, which is creator-only: a member leaving a shared trip
    // is a different decision from the organiser putting it away.
    renderWithIntl(<TripList trips={[trip({ role: "MEMBER" })]} />, { api: apiWithArchive() });

    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open/ })).toBeInTheDocument();
  });
});
