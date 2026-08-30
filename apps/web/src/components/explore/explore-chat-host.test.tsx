import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExplorationStartResponse, TravelApi } from "@/lib/api";
import { renderWithIntl } from "@/test/render";
import { ExploreChatHost } from "./explore-chat-host";

const TRIP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const CREATED_AT = "2026-08-27T00:00:00.000Z";

const DRAFT_RESPONSE: ExplorationStartResponse = {
  trip: {
    id: TRIP_ID,
    name: "Untitled exploration",
    status: "PLANNING",
    departureCities: [],
    destinationCandidates: [],
    travelDateStart: null,
    travelDateEnd: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  },
  defaultThread: {
    id: THREAD_ID,
    tripId: TRIP_ID,
    scope: "TRIP",
    isDefault: true,
  },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeApi(overrides: Partial<TravelApi> = {}): TravelApi {
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
    subscribeAgentRun: vi.fn().mockResolvedValue(undefined),
    startExploration: vi.fn().mockResolvedValue(DRAFT_RESPONSE),
    activateTrip: vi.fn(),
    updateTripTitle: vi.fn(),
    saveTripSearchPreferences: vi.fn(),
    startPlanning: vi.fn(),
    getLatestPlanningRun: vi.fn(),
    getLatestPlan: vi.fn(),
    getProfileMemory: vi.fn().mockResolvedValue({ facts: [], suggestions: [] }),
    updateMemoryFact: vi.fn(),
    deleteMemoryFact: vi.fn(),
    confirmMemoryProposal: vi.fn(),
    dismissMemoryProposal: vi.fn(),
    getTripMemoryOverrides: vi.fn().mockResolvedValue({ overrides: [] }),
    getTripMemoryGroupDecisions: vi.fn().mockResolvedValue({ groupDecisions: [] }),
    saveTripMemoryOverride: vi.fn(),
    saveTripMemoryGroupDecision: vi.fn(),
    deleteTripMemory: vi.fn(),
    ...overrides,
  };
}

describe("ExploreChatHost exploration provisioning", () => {
  it("renders the chat in preparing state on first paint without calling any provisioning endpoint", () => {
    const api = makeApi();
    renderWithIntl(<ExploreChatHost />, { api });

    expect(screen.getByRole("form", { name: "Start a conversation with Wanderly Agent" })).toBeInTheDocument();
    // The input is enabled on first paint: the host has a provisioner,
    // so the user's first Send triggers `POST /explorations/start`.
    expect(screen.getByRole("textbox", { name: "Ask Wanderly" })).not.toBeDisabled();
    expect(screen.getByText("Preparing your private chat…")).toBeInTheDocument();
    expect(api.startExploration).not.toHaveBeenCalled();
    expect(api.getTrips).not.toHaveBeenCalled();
    expect(api.getOrCreateDefaultTripThread).not.toHaveBeenCalled();
  });

  it("provisions the draft on the first send and never fetches trips", async () => {
    const api = makeApi();
    renderWithIntl(<ExploreChatHost />, { api });

    const textarea = screen.getByRole("textbox", { name: "Ask Wanderly" });
    fireEvent.change(textarea, { target: { value: "Tell me about Tokyo" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(api.startExploration).toHaveBeenCalledTimes(1);
    });
    expect(api.getTrips).not.toHaveBeenCalled();
    expect(api.getOrCreateDefaultTripThread).not.toHaveBeenCalled();
    // The send was wired through onEnsureThreadForFirstSend → submitTurn.
    expect(api.submitConversationTurn).toHaveBeenCalledTimes(1);
  });

  it("does not start a second exploration on a second send", async () => {
    const api = makeApi();
    renderWithIntl(<ExploreChatHost />, { api });

    const textarea = screen.getByRole("textbox", { name: "Ask Wanderly" });
    fireEvent.change(textarea, { target: { value: "First question" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.change(textarea, { target: { value: "Second question" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await Promise.resolve();
    });

    expect(api.startExploration).toHaveBeenCalledTimes(1);
    expect(api.submitConversationTurn).toHaveBeenCalledTimes(2);
  });

  it("surfaces the retry CTA when the exploration start fails", async () => {
    const api = makeApi({
      startExploration: vi.fn().mockRejectedValue(new Error("boom")),
    });
    renderWithIntl(<ExploreChatHost />, { api });

    const textarea = screen.getByRole("textbox", { name: "Ask Wanderly" });
    fireEvent.change(textarea, { target: { value: "Hi" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByText("Private chat is unavailable.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(api.submitConversationTurn).not.toHaveBeenCalled();
  });

  it("clicking Retry re-issues startExploration and recovers when the next call succeeds", async () => {
    const startExploration = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(DRAFT_RESPONSE);
    const api = makeApi({
      startExploration,
      // After retry succeeds, the chat mounts useOwnerConversation on the
      // newly-provisioned thread; return a valid empty conversation so
      // the query doesn't warn about undefined data.
      getOwnerConversation: vi.fn().mockResolvedValue({
        thread: {
          id: THREAD_ID,
          tripId: TRIP_ID,
          scope: "TRIP",
          isDefault: true,
        },
        messages: [],
      }),
    });
    renderWithIntl(<ExploreChatHost />, { api });

    const textarea = screen.getByRole("textbox", { name: "Ask Wanderly" });
    fireEvent.change(textarea, { target: { value: "Hi" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByText("Private chat is unavailable.")).toBeInTheDocument();
    expect(startExploration).toHaveBeenCalledTimes(1);

    // Retry must re-issue the start request. The original Send was
    // dropped when the first start rejected (sendTurn returns early
    // when the provisioner yields no threadId); the user has to retype
    // and re-send after the panel recovers. The contract under test is
    // simply that Retry exits the error state by issuing a fresh call.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(startExploration).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.queryByText("Private chat is unavailable.")).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("clicking Retry after a persistent failure re-issues the request and keeps the error UI", async () => {
    const startExploration = vi.fn().mockRejectedValue(new Error("boom"));
    const api = makeApi({ startExploration });
    renderWithIntl(<ExploreChatHost />, { api });

    const textarea = screen.getByRole("textbox", { name: "Ask Wanderly" });
    fireEvent.change(textarea, { target: { value: "Hi" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByText("Private chat is unavailable.")).toBeInTheDocument();
    expect(startExploration).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(startExploration).toHaveBeenCalledTimes(2);
    });
    // The error UI stays in place so the user can keep retrying or fall
    // back to a different action; we never silently re-show "Preparing…".
    expect(screen.getByText("Private chat is unavailable.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(api.submitConversationTurn).not.toHaveBeenCalled();
  });

  it("does not render a trip picker chip on the exploration page", () => {
    const api = makeApi();
    renderWithIntl(<ExploreChatHost />, { api });
    expect(screen.queryByRole("button", { name: /Switch trip/i })).not.toBeInTheDocument();
  });
});
