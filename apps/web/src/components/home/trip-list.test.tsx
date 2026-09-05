import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
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

function apiWithDelete(deleteTrip = vi.fn().mockResolvedValue(undefined)) {
  return { deleteTrip } as unknown as TravelApi;
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

  it("does not delete on the first click — it asks first", async () => {
    // The delete is not reversible, so a single mis-click must not reach the
    // API. The first click only arms the confirmation.
    const deleteTrip = vi.fn().mockResolvedValue(undefined);
    renderWithIntl(<TripList trips={[trip()]} />, { api: apiWithDelete(deleteTrip) });

    fireEvent.click(screen.getByRole("button", { name: "Delete Tokyo trip" }));

    expect(deleteTrip).not.toHaveBeenCalled();
    expect(await screen.findByRole("group", { name: "Delete for good?" })).toBeInTheDocument();
  });

  it("places the destructive delete control at the card's top-right and reveals it on hover or focus", () => {
    renderWithIntl(<TripList trips={[trip()]} />, { api: apiWithDelete() });

    const control = screen.getByRole("button", { name: "Delete Tokyo trip" });
    expect(control).toHaveClass(
      "right-2",
      "top-2",
      "bg-destructive",
      "text-white",
      "opacity-0",
      "group-hover:opacity-100",
      "group-focus-within:opacity-100",
    );
    expect(control).not.toHaveClass("left-2");
  });

  it("deletes once the confirmation is taken", async () => {
    const deleteTrip = vi.fn().mockResolvedValue(undefined);
    renderWithIntl(<TripList trips={[trip()]} />, { api: apiWithDelete(deleteTrip) });

    fireEvent.click(screen.getByRole("button", { name: "Delete Tokyo trip" }));
    const confirm = await screen.findByRole("group", { name: "Delete for good?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteTrip).toHaveBeenCalledWith(TRIP_ID));
  });

  it("backs out without deleting when the confirmation is declined", async () => {
    const deleteTrip = vi.fn().mockResolvedValue(undefined);
    renderWithIntl(<TripList trips={[trip()]} />, { api: apiWithDelete(deleteTrip) });

    fireEvent.click(screen.getByRole("button", { name: "Delete Tokyo trip" }));
    const confirm = await screen.findByRole("group", { name: "Delete for good?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep" }));

    expect(deleteTrip).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Delete Tokyo trip" })).toBeInTheDocument();
  });

  it("hides deleting from a member who did not create the trip", () => {
    // Matches the API, which is creator-only: a member who wants out of a
    // shared trip is leaving it, not destroying it for everyone else.
    renderWithIntl(<TripList trips={[trip({ role: "MEMBER" })]} />, { api: apiWithDelete() });

    expect(screen.queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open/ })).toBeInTheDocument();
  });

  it("keeps each card's look tied to its own trip, not its position", () => {
    // Styling once came from the array index, so deleting a card restyled
    // every card after it and the gap appeared to open in the wrong place.
    const second = "22222222-2222-4222-8222-222222222222";
    const before = renderWithIntl(
      <TripList trips={[trip(), trip({ id: second, name: "Kyoto trip" })]} />,
      { api: apiWithDelete() },
    );
    const kyotoBefore = before.container.querySelectorAll("article")[1]!.className;
    cleanup();

    const after = renderWithIntl(
      <TripList trips={[trip({ id: second, name: "Kyoto trip" })]} />,
      { api: apiWithDelete() },
    );
    expect(after.container.querySelectorAll("article")[0]!.className).toBe(kyotoBefore);
  });

  // A country-only brief now gives a Draft a real-looking name ("法国行程规划")
  // while destinationCandidates stays empty. Without this marker the card
  // reads as though the brief were complete.
  it("marks a Draft whose brief still has no destination city", () => {
    renderWithIntl(
      <TripList trips={[trip({ name: "France Trip Planner", status: "DRAFT", destinationCandidates: [] })]} />,
      { api: apiWithDelete() },
    );
    expect(screen.getByText("Destination city not set")).toBeInTheDocument();
  });

  it("drops the marker once the Draft has a confirmed destination", () => {
    renderWithIntl(
      <TripList trips={[trip({ status: "DRAFT", destinationCandidates: ["Paris"] })]} />,
      { api: apiWithDelete() },
    );
    expect(screen.queryByText("Destination city not set")).not.toBeInTheDocument();
  });

  it("never shows the marker outside Draft", () => {
    renderWithIntl(
      <TripList trips={[trip({ status: "PLANNING", destinationCandidates: [] })]} />,
      { api: apiWithDelete() },
    );
    expect(screen.queryByText("Destination city not set")).not.toBeInTheDocument();
  });
});
