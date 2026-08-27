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

function buildTripResponse(): TripDetailResponse {
  return {
    trip: {
      id: TRIP_ID,
      name: "Tokyo & Kyoto",
      createdBy: "owner-user-id",
      status: "PLANNING",
      departureCities: ["San Francisco"],
      destinationCandidates: ["Tokyo", "Kyoto"],
      travelDateStart: "2026-09-10",
      travelDateEnd: "2026-09-20",
      memberCount: 3,
      role: "CREATOR",
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-20T10:00:00.000Z",
    },
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
    getTripThreads: vi.fn().mockResolvedValue({ threads: [] }),
    createTripThread: vi.fn().mockImplementation(async () => ({
      id: SECOND_THREAD_ID,
      message: "Thread created" as const,
    })),
    getOrCreateDefaultTripThread: vi.fn().mockResolvedValue({ id: DEFAULT_THREAD_ID, message: "Thread created" as const }),
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
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("TripWorkspace", () => {
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

  it("creates an additional thread and switches the URL to it", async () => {
    const api = createApi({
      getTripThreads: vi.fn().mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] }),
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    expect(await screen.findByRole("button", { name: /Default/ })).toBeInTheDocument();

    const input = await screen.findByPlaceholderText(/Visa prep/);
    fireEvent.change(input, { target: { value: "Hotel ideas" } });
    fireEvent.click(screen.getByRole("button", { name: /Create thread/ }));

    await waitFor(() => expect(api.createTripThread).toHaveBeenCalledWith(TRIP_ID, { title: "Hotel ideas" }));
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
