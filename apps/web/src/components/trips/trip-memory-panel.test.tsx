import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TravelApi } from "@/lib/api";
import type { TripMemoryFact } from "@/lib/api/contracts";
import { renderWithIntl } from "@/test/render";

import { TripMemoryPanel } from "./trip-memory-panel";

const TRIP_ID = "11111111-1111-4111-8111-111111111111";
const OVERRIDE_ID = "22222222-2222-4222-8222-222222222222";
const DECISION_ID = "33333333-3333-4333-8333-333333333333";

function fact(overrides: Partial<TripMemoryFact> = {}): TripMemoryFact {
  return {
    id: OVERRIDE_ID,
    fieldKey: "trip_pace",
    value: "packed",
    kind: "PERSONAL_OVERRIDE",
    source: "OWNER_SAVE",
    status: "ACTIVE",
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

function createApi(overrides: Partial<TravelApi> = {}): TravelApi {
  return {
    getMyProfile: vi.fn(),
    updateMyProfile: vi.fn(),
    getTrips: vi.fn(),
    getTrip: vi.fn(),
    getLocationReference: vi.fn(),
    getLocationIntroduction: vi.fn(),
    getTripThreads: vi.fn(),
    createTripThread: vi.fn(),
    getOrCreateDefaultTripThread: vi.fn(),
    getOwnerConversation: vi.fn(),
    submitConversationTurn: vi.fn(),
    getAgentRun: vi.fn(),
    cancelAgentRun: vi.fn(),
    subscribeAgentRun: vi.fn(),
    startExploration: vi.fn(),
    activateTrip: vi.fn(),
    updateTripTitle: vi.fn(),
    getProfileMemory: vi.fn(),
    updateMemoryFact: vi.fn(),
    deleteMemoryFact: vi.fn(),
    confirmMemoryProposal: vi.fn(),
    dismissMemoryProposal: vi.fn(),
    getTripMemoryOverrides: vi.fn().mockResolvedValue({ overrides: [] }),
    getTripMemoryGroupDecisions: vi.fn().mockResolvedValue({ groupDecisions: [] }),
    saveTripMemoryOverride: vi.fn().mockResolvedValue(fact()),
    saveTripMemoryGroupDecision: vi.fn().mockResolvedValue(fact({ kind: "GROUP_DECISION" })),
    deleteTripMemory: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as TravelApi;
}

afterEach(cleanup);

describe("TripMemoryPanel", () => {
  it("separates this-trip preferences from group decisions", async () => {
    renderWithIntl(<TripMemoryPanel tripId={TRIP_ID} />, { api: createApi() });

    expect(await screen.findByText("This trip only")).toBeInTheDocument();
    expect(screen.getByText("Group decision")).toBeInTheDocument();
  });

  it("states that an override never rewrites the long-term profile", async () => {
    renderWithIntl(<TripMemoryPanel tripId={TRIP_ID} />, { api: createApi() });

    // The scope has to be legible, or a member cannot tell what they changed.
    expect(await screen.findByText(/never rewrites your long-term preferences/))
      .toBeInTheDocument();
  });

  it("saves a this-trip override", async () => {
    const saveTripMemoryOverride = vi.fn().mockResolvedValue(fact());
    renderWithIntl(<TripMemoryPanel tripId={TRIP_ID} />, {
      api: createApi({ saveTripMemoryOverride }),
    });

    const selects = await screen.findAllByLabelText("Trip pace");
    fireEvent.change(selects[0], { target: { value: "packed" } });

    await waitFor(() =>
      expect(saveTripMemoryOverride).toHaveBeenCalledWith(TRIP_ID, "trip_pace", "packed"));
  });

  it("saves a group decision through the group endpoint", async () => {
    const saveTripMemoryGroupDecision = vi.fn().mockResolvedValue(fact({ kind: "GROUP_DECISION" }));
    const saveTripMemoryOverride = vi.fn();
    renderWithIntl(<TripMemoryPanel tripId={TRIP_ID} />, {
      api: createApi({ saveTripMemoryGroupDecision, saveTripMemoryOverride }),
    });

    // Accommodation style appears in both sections; the second is the group one.
    const selects = await screen.findAllByLabelText("Accommodation style");
    fireEvent.change(selects[1], { target: { value: "budget" } });

    await waitFor(() =>
      expect(saveTripMemoryGroupDecision).toHaveBeenCalledWith(TRIP_ID, "accommodation_style", "budget"));
    expect(saveTripMemoryOverride).not.toHaveBeenCalled();
  });

  it("shows an existing override with its scope", async () => {
    renderWithIntl(<TripMemoryPanel tripId={TRIP_ID} />, {
      api: createApi({
        getTripMemoryOverrides: vi.fn().mockResolvedValue({ overrides: [fact()] }),
      }),
    });

    expect(await screen.findByText(/This trip only · packed/)).toBeInTheDocument();
  });

  it("clears an override", async () => {
    const deleteTripMemory = vi.fn().mockResolvedValue(undefined);
    renderWithIntl(<TripMemoryPanel tripId={TRIP_ID} />, {
      api: createApi({
        getTripMemoryOverrides: vi.fn().mockResolvedValue({ overrides: [fact()] }),
        deleteTripMemory,
      }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Clear Trip pace" }));

    await waitFor(() => expect(deleteTripMemory).toHaveBeenCalledWith(TRIP_ID, OVERRIDE_ID));
  });

  it("refetches after a save so a staled plan is not shown as current", async () => {
    const getTripMemoryOverrides = vi.fn().mockResolvedValue({ overrides: [] });
    renderWithIntl(<TripMemoryPanel tripId={TRIP_ID} />, {
      api: createApi({ getTripMemoryOverrides }),
    });

    const selects = await screen.findAllByLabelText("Trip pace");
    fireEvent.change(selects[0], { target: { value: "packed" } });

    // Saving stales the trip's active plan server-side, so the queries are
    // invalidated rather than patched locally.
    await waitFor(() => expect(getTripMemoryOverrides).toHaveBeenCalledTimes(2));
  });

  it("does not render another member's override", async () => {
    // The endpoint is owner-scoped, so the panel only ever receives its own.
    const getTripMemoryOverrides = vi.fn().mockResolvedValue({ overrides: [] });
    renderWithIntl(<TripMemoryPanel tripId={TRIP_ID} />, {
      api: createApi({
        getTripMemoryOverrides,
        getTripMemoryGroupDecisions: vi.fn().mockResolvedValue({
          groupDecisions: [fact({ id: DECISION_ID, kind: "GROUP_DECISION", value: "budget", fieldKey: "accommodation_style" })],
        }),
      }),
    });

    expect(await screen.findByText(/Group decision · budget/)).toBeInTheDocument();
    expect(screen.queryByText(/This trip only · /)).not.toBeInTheDocument();
  });
});
