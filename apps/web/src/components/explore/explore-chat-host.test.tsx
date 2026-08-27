import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TravelApi } from "@/lib/api";
import { renderWithIntl } from "@/test/render";
import { ExploreChatHost } from "./explore-chat-host";

const TRIP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TRIP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const THREAD_A = "11111111-1111-4111-8111-111111111111";
const THREAD_B = "22222222-2222-4222-8222-222222222222";
const CREATED_AT = "2026-08-26T00:00:00.000Z";

const TRIP_A_SUMMARY = {
  id: TRIP_A,
  name: "Asia Trip",
  status: "PLANNING" as const,
  departureCities: ["San Francisco"],
  destinationCandidates: ["Tokyo", "Bangkok"],
  travelDateStart: null,
  travelDateEnd: null,
  memberCount: 2,
  role: "CREATOR" as const,
  createdAt: CREATED_AT,
};

const TRIP_B_SUMMARY = {
  ...TRIP_A_SUMMARY,
  id: TRIP_B,
  name: "Europe Trip",
  destinationCandidates: ["Lisbon"],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeApi(overrides: Partial<TravelApi> = {}): TravelApi {
  return {
    getMyProfile: vi.fn(),
    updateMyProfile: vi.fn(),
    getTrips: vi.fn().mockResolvedValue({ trips: [TRIP_A_SUMMARY] }),
    getTrip: vi.fn(),
    getLocationReference: vi.fn(),
    getTripThreads: vi.fn().mockResolvedValue({ threads: [] }),
    createTripThread: vi.fn(),
    getOrCreateDefaultTripThread: vi.fn().mockResolvedValue({ id: THREAD_A, message: "Thread created" }),
    getOwnerConversation: vi.fn().mockResolvedValue({
      thread: {
        id: THREAD_A,
        ownerUserId: "owner",
        tripId: TRIP_A,
        scope: "TRIP",
        isDefault: true,
        title: "Personal trip scratchpad",
        createdAt: CREATED_AT,
        archivedAt: null,
      },
      messages: [],
    }),
    submitConversationTurn: vi.fn().mockResolvedValue({
      threadId: THREAD_A,
      runId: "run",
      operation: "CONVERSATION",
      status: "QUEUED",
      generationAttempt: 0,
      userMessage: { id: "um", role: "USER", content: "x", sequence: 1, createdAt: CREATED_AT },
    }),
    getAgentRun: vi.fn().mockResolvedValue({
      runId: "run",
      operation: "CONVERSATION",
      status: "RUNNING",
      generationAttempt: 1,
      attemptCount: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      finishedAt: null,
      errorCode: null,
      assistantMessageId: null,
      resultPlanId: null,
    }),
    cancelAgentRun: vi.fn(),
    subscribeAgentRun: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("ExploreChatHost trip provisioning", () => {
  it("keeps the chat entry visible and disabled while trips are loading", () => {
    const api = makeApi({
      getTrips: vi.fn().mockImplementation(() => new Promise(() => {})),
    });
    renderWithIntl(<ExploreChatHost />, { api });

    expect(screen.getByRole("form", { name: "Start a conversation with Wanderly Agent" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Ask Wanderly" })).toBeDisabled();
    expect(screen.getByText("Preparing your private chat…")).toBeInTheDocument();
    expect(screen.getByTestId("explore-chat-host")).toHaveClass("contents");
    expect(screen.getByTestId("explore-chat-host").firstElementChild).toHaveClass("contents");
  });

  it("keeps the chat entry visible when thread provisioning fails", async () => {
    const api = makeApi({
      getTripThreads: vi.fn().mockRejectedValue(new Error("threads unavailable")),
    });
    renderWithIntl(<ExploreChatHost />, { api });

    expect(await screen.findByText("Private chat is unavailable.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Ask Wanderly" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("does not create a trip when the user has no trips", async () => {
    const api = makeApi({
      getTrips: vi.fn().mockResolvedValue({ trips: [] }),
    });
    renderWithIntl(
      <ExploreChatHost />,
      { api },
    );

    expect(await screen.findByText("Private chat is unavailable.")).toBeInTheDocument();
    expect(api.getOrCreateDefaultTripThread).not.toHaveBeenCalled();
  });

  it("provisions the default thread on mount when the trip has no threads yet", async () => {
    const api = makeApi();
    renderWithIntl(
      <ExploreChatHost />,
      { api },
    );

    await waitFor(() => expect(api.getOrCreateDefaultTripThread).toHaveBeenCalledWith(TRIP_A), {
      timeout: 3000,
    });
    expect(api.getOrCreateDefaultTripThread).toHaveBeenCalledTimes(1);
  });

  it("does not provision a default when the trip already has a thread", async () => {
    const api = makeApi({
      getTripThreads: vi.fn().mockResolvedValue({
        threads: [{
          id: THREAD_A,
          ownerUserId: "owner",
          tripId: TRIP_A,
          scope: "TRIP",
          isDefault: true,
          title: "Personal trip scratchpad",
          createdAt: CREATED_AT,
          archivedAt: null,
        }],
      }),
    });
    renderWithIntl(
      <ExploreChatHost />,
      { api },
    );

    await waitFor(() => expect(api.getTripThreads).toHaveBeenCalled(), { timeout: 3000 });
    expect(api.getOrCreateDefaultTripThread).not.toHaveBeenCalled();
  });

  it("renders the trip picker chip when more than one trip is available", async () => {
    const api = makeApi({
      getTrips: vi.fn().mockResolvedValue({ trips: [TRIP_A_SUMMARY, TRIP_B_SUMMARY] }),
      getTripThreads: vi.fn().mockImplementation(async (tripId: string) => ({
        threads: [{
          id: tripId === TRIP_A ? THREAD_A : THREAD_B,
          ownerUserId: "owner",
          tripId,
          scope: "TRIP",
          isDefault: true,
          title: tripId === TRIP_A ? "Asia scratchpad" : "Europe scratchpad",
          createdAt: CREATED_AT,
          archivedAt: null,
        }],
      })),
      getOwnerConversation: vi.fn().mockImplementation(async (threadId: string) => ({
        thread: {
          id: threadId,
          ownerUserId: "owner",
          tripId: threadId === THREAD_A ? TRIP_A : TRIP_B,
          scope: "TRIP",
          isDefault: true,
          title: threadId === THREAD_A ? "Asia scratchpad" : "Europe scratchpad",
          createdAt: CREATED_AT,
          archivedAt: null,
        },
        messages: [],
      })),
    });
    renderWithIntl(
      <ExploreChatHost />,
      { api },
    );

    await waitFor(() => expect(api.getTrips).toHaveBeenCalled(), { timeout: 3000 });
    await waitFor(() => expect(api.getTripThreads).toHaveBeenCalledWith(TRIP_A), { timeout: 3000 });

    // Picker chip surfaces the active trip name and lists both options.
    const picker = await screen.findByRole("button", { name: /Switch trip/i });
    fireEvent.click(picker);

    expect(await screen.findByRole("option", { name: "Asia Trip" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "Europe Trip" })).toBeInTheDocument();
  });
});
