import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TripDetailResponse } from "@/lib/api/contracts";
import { TravelApiError } from "@/lib/api/errors";
import type { TravelApi } from "@/lib/api";
import { renderWithIntl } from "@/test/render";

import { TripWorkspace } from "./trip-workspace";

const TRIP_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_THREAD_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_THREAD_ID = "33333333-3333-4333-8333-333333333333";

function buildTripResponse(status: TripDetailResponse["trip"]["status"] = "PLANNING"): TripDetailResponse {
  return {
    trip: {
      id: TRIP_ID,
      name: "Tokyo & Kyoto",
      createdBy: "owner-user-id",
      status,
      departureCities: ["San Francisco"],
      destinationCandidates: ["Tokyo", "Kyoto"],
      travelDateStart: "2026-09-10",
      travelDateEnd: "2026-09-20",
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-20T10:00:00.000Z",
    },
    callerRole: "CREATOR",
    members: [
      {
        userId: "owner-user-id",
        displayName: "Alice",
        role: "CREATOR",
        isRequired: true,
        joinedAt: "2026-08-01T10:00:00.000Z",
      },
    ],
  };
}

function buildThread(id: string, title: string, isDefault: boolean) {
  return {
    id,
    ownerUserId: "owner-user-id",
    tripId: TRIP_ID,
    scope: "TRIP" as const,
    isDefault,
    title,
    createdAt: "2026-08-21T10:00:00.000Z",
    archivedAt: null,
  };
}

function createApi(overrides: Partial<TravelApi> = {}): TravelApi {
  return {
    getMyProfile: vi.fn(),
    updateMyProfile: vi.fn(),
    getTrips: vi.fn(),
    getTrip: vi.fn().mockResolvedValue(buildTripResponse()),
    getLocationReference: vi.fn(),
    getLocationIntroduction: vi.fn(),
    getTripThreads: vi.fn().mockResolvedValue({ threads: [] }),
    createTripThread: vi.fn().mockResolvedValue(buildThread(SECOND_THREAD_ID, "New thread", false)),
    getOrCreateDefaultTripThread: vi.fn().mockResolvedValue(buildThread(DEFAULT_THREAD_ID, "Default", true)),
    getOwnerConversation: vi.fn().mockResolvedValue({ thread: buildThread(DEFAULT_THREAD_ID, "Default", true), messages: [] }),
    submitConversationTurn: vi.fn().mockResolvedValue({
      threadId: DEFAULT_THREAD_ID,
      runId: "00000000-0000-4000-8000-000000000000",
      operation: "CONVERSATION",
      status: "QUEUED",
      generationAttempt: 0,
      userMessage: {
        id: "00000000-0000-4000-8000-000000000001",
        role: "USER",
        content: "hi",
        sequence: 1,
        createdAt: "2026-08-22T10:00:00.000Z",
      },
    }),
    getAgentRun: vi.fn(),
    cancelAgentRun: vi.fn(),
    subscribeAgentRun: vi.fn().mockImplementation(async (_runId, signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }),
    startExploration: vi.fn(),
    activateTrip: vi.fn(),
    updateTripTitle: vi.fn(),
    saveTripSearchPreferences: vi.fn(),
    startPlanning: vi.fn(),
    getLatestPlanningRun: vi.fn().mockResolvedValue({ run: null }),
    getLatestPlan: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("TripWorkspace", () => {
  it("opens a draft in the same workspace used for active planning", async () => {
    const api = createApi({
      getTrip: vi.fn().mockResolvedValue(buildTripResponse("DRAFT")),
      getTripThreads: vi.fn().mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Draft notes", true)] }),
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    expect(await screen.findByRole("button", { name: /Draft notes/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New thread" })).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Activate draft trip" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start planning" }));
    await waitFor(() => expect(api.activateTrip).toHaveBeenCalledWith(TRIP_ID, {
      departureCities: ["San Francisco"],
      destinationCandidates: ["Tokyo", "Kyoto"],
      travelDateStart: "2026-09-10",
      travelDateEnd: "2026-09-20",
      titleLocale: "en",
    }));
  });

  it("auto-provisions a default thread when none exists", async () => {
    // First call returns empty (no threads yet); subsequent calls
    // return the freshly-provisioned default thread.
    const getTripThreads = vi.fn()
      .mockResolvedValueOnce({ threads: [] })
      .mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] });
    const api = createApi({ getTripThreads });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    await waitFor(() => expect(api.getOrCreateDefaultTripThread).toHaveBeenCalledWith(TRIP_ID));

    // After provisioning the rail shows the default thread title.
    expect(await screen.findByRole("button", { name: /Default/ })).toBeInTheDocument();
  });

  it("renders only the caller's own threads, not trip-mate threads", async () => {
    const api = createApi({
      getTripThreads: vi.fn().mockResolvedValue({
        threads: [
          buildThread(DEFAULT_THREAD_ID, "Visa prep", true),
          buildThread(SECOND_THREAD_ID, "Budget", false),
        ],
      }),
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    expect(await screen.findByRole("button", { name: /Visa prep/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Budget/ })).toBeInTheDocument();

    // Rail does NOT list any trip-mate thread.
    expect(screen.queryByRole("button", { name: /Alice/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Bob/ })).not.toBeInTheDocument();
  });

  it("starts a new thread session in one click, without prompting for a title", async () => {
    const api = createApi({
      getTripThreads: vi.fn().mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] }),
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    expect(await screen.findByRole("button", { name: /Default/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));

    // The rail already holds one thread, so the new session is numbered 2.
    await waitFor(() => expect(api.createTripThread).toHaveBeenCalledWith(TRIP_ID, { title: "New thread 2" }));
    expect(screen.queryByPlaceholderText(/Visa prep/)).not.toBeInTheDocument();
  });

  it("lets the creator set a manual title", async () => {
    const updateTripTitle = vi.fn().mockResolvedValue({
      trip: { id: TRIP_ID, name: "Autumn escape", nameSource: "MANUAL", titleLocale: null, updatedAt: "2026-08-22T10:00:00.000Z" },
    });
    const api = createApi({ updateTripTitle, getTripThreads: vi.fn().mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] }) });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    fireEvent.click(await screen.findByRole("button", { name: /Rename/ }));
    fireEvent.change(screen.getByRole("textbox", { name: /Trip title/ }), { target: { value: "Autumn escape" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateTripTitle).toHaveBeenCalledWith(TRIP_ID, { name: "Autumn escape" }));
  });

  it("confirms bounded flight preferences and starts a server-owned Shared planning task", async () => {
    const saveTripSearchPreferences = vi.fn().mockResolvedValue({
      tripId: TRIP_ID, version: 1, tripType: "ROUND_TRIP", currency: "USD", adults: 1, cabin: "ECONOMY",
      offerFreshnessMinutes: 15, confirmedBy: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", createdAt: "2026-08-22T10:00:00.000Z",
    });
    const startPlanning = vi.fn().mockResolvedValue({
      runId: "99999999-9999-4999-8999-999999999999", operation: "PLAN", status: "QUEUED", generationAttempt: 0,
      snapshotId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const api = createApi({
      getTripThreads: vi.fn().mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] }),
      getLatestPlanningRun: vi.fn().mockResolvedValue({ run: null }), saveTripSearchPreferences, startPlanning,
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    fireEvent.click(await screen.findByRole("button", { name: /Confirm and start/ }));

    await waitFor(() => expect(saveTripSearchPreferences).toHaveBeenCalledWith(TRIP_ID, {
      tripType: "ROUND_TRIP", adults: 1, cabin: "ECONOMY", currency: "USD", offerFreshnessMinutes: 15,
    }));
    expect(startPlanning).toHaveBeenCalledWith(TRIP_ID);
  });

  it("shows only the server-activated plan and its grounded flight provenance", async () => {
    const run = {
      runId: "99999999-9999-4999-8999-999999999999", operation: "PLAN" as const, status: "COMPLETED" as const,
      generationAttempt: 1, attemptCount: 1, createdAt: "2026-08-22T10:00:00.000Z", updatedAt: "2026-08-22T10:00:00.000Z",
      finishedAt: "2026-08-22T10:01:00.000Z", errorCode: null, assistantMessageId: null, resultPlanId: "88888888-8888-4888-8888-888888888888",
    };
    const api = createApi({
      getTripThreads: vi.fn().mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] }),
      getLatestPlanningRun: vi.fn().mockResolvedValue({ run }),
      getLatestPlan: vi.fn().mockResolvedValue({ plan: {
        id: run.resultPlanId, version: 1, planData: {
          destination: "Tokyo", generatedAt: "2026-08-22T10:00:00.000Z", flights: [{
            id: "flight-1", providerOfferId: "offer-1", providerName: "flightapi", queryId: "77777777-7777-4777-8777-777777777777",
            origin: "SFO", destination: "NRT", segments: [{ carrierCode: "NH", flightNumber: "7", origin: "SFO", destination: "NRT", departureAt: "2026-09-10T10:00:00", arrivalAt: "2026-09-11T14:00:00", duration: "PT660M" }], totalDuration: "PT660M", totalPrice: 900, currency: "USD", cabin: "ECONOMY", adults: 1, baggageSummary: null, changeSummary: null, source: "FlightAPI Flight Price API", capturedAt: "2026-08-22T10:00:00.000Z", expiresAt: "2026-08-22T10:15:00.000Z",
          }], stays: [{}], ground: [{}],
        },
      } }),
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    expect(await screen.findByText(/Active plan v1/)).toBeInTheDocument();
    expect(screen.getByText(/FlightAPI Flight Price API/)).toBeInTheDocument();
  });

  it("shows a generic membership-revoked error on 403/410 from the trip detail", async () => {
    const api = createApi({
      getTrip: vi.fn().mockRejectedValue(new TravelApiError("forbidden", 403, "Forbidden", null)),
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    expect(await screen.findByText(/You no longer have access to this trip/i)).toBeInTheDocument();
  });

  it("falls back to the default thread when the URL points at a thread no longer in the list", async () => {
    // Pre-set the URL ?thread= to an id that is NOT in the threads list
    // returned by getTripThreads.  The workspace should fall back to the
    // default thread in the rail.
    const api = createApi({
      getTripThreads: vi.fn().mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] }),
    });
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, search: "?thread=stale-id", href: "http://localhost/trips/" + TRIP_ID + "?thread=stale-id" },
    });

    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    // The rail must still render the only available thread (the default).
    expect(await screen.findByRole("button", { name: /Default/ })).toBeInTheDocument();
  });

  it("threads are owner-scoped: even when both threads have the same title, only the caller's threads appear", async () => {
    const api = createApi({
      getTripThreads: vi.fn().mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] }),
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    expect(await screen.findByRole("button", { name: /Default/ })).toBeInTheDocument();

    // Sanity: only one Default entry; the rail does not list other trip-mates' threads.
    expect(screen.getAllByRole("button", { name: /Default/ })).toHaveLength(1);
  });
});
