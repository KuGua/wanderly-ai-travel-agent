import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRun, ConversationPlace, ConversationTurnAcceptedResponse } from "@/lib/api/contracts";
import { TravelApiError } from "@/lib/api/errors";
import type { TravelApi } from "@/lib/api";
import { renderWithIntl } from "@/test/render";
import { viewerScopedKey } from "@/lib/auth/viewer-scoped-storage";
import { CHAT_ACTIVE_RUN_STORAGE_KEY, TravelAgentChat } from "./travel-agent-chat";

/** The pointer is per-viewer now, so the tests have to look where it lives. */
const ACTIVE_RUN_KEY = () => viewerScopedKey(CHAT_ACTIVE_RUN_STORAGE_KEY);

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const USER_MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const ASSISTANT_MESSAGE_ID = "77777777-7777-4777-8777-777777777777";
const TRIP_ID = "99999999-9999-4999-8999-999999999999";
const CUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CANDIDATE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREATED_AT = "2026-08-25T10:00:00.000Z";
const TOKYO: ConversationPlace = {
  sourceId: "tokyo",
  name: "Tokyo",
  longitude: 139.6917,
  latitude: 35.6895,
  sourceType: "REFERENCE",
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function ChatHarness({
  controlledThreadId = THREAD_ID,
  initiallyOpen = true,
  selectedPlace = null,
  tripId = null,
  onStartNewExploration,
  onConversationText,
  onThreadInvalidated,
  surface,
  variant,
}: {
  controlledThreadId?: string | null;
  initiallyOpen?: boolean;
  selectedPlace?: { place: ConversationPlace; context: string } | null;
  tripId?: string | null;
  onStartNewExploration?: () => void;
  onConversationText?: (text: string) => void;
  onThreadInvalidated?: () => void;
  /** Defaults to the globe, like the component does. */
  surface?: "EXPLORE" | "TRIP_WORKSPACE";
  variant?: "floating" | "docked";
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <TravelAgentChat
      open={open}
      onOpen={() => setOpen(true)}
      onDismiss={() => setOpen(false)}
      threadId={controlledThreadId}
      tripId={tripId}
      onThreadInvalidated={onThreadInvalidated}
      {...(surface ? { surface } : {})}
      {...(variant ? { variant } : {})}
      selectedPlace={selectedPlace}
            onStartNewExploration={onStartNewExploration}
      onConversationText={onConversationText}
    />
  );
}

function renderChat(api: TravelApi, options: Parameters<typeof ChatHarness>[0] = {}) {
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(REQUEST_ID);
  return renderWithIntl(<ChatHarness {...options} />, { api });
}

function createApi(overrides: Partial<TravelApi> = {}): TravelApi {
  return {
    // The component reads the profile to decide whether it must ask for a
    // quote nationality, and a fixture that resolves to `undefined` is not a
    // profile the API can return. The default carries one, which is the common
    // case; the tests about the ask override it.
    getMyProfile: vi.fn().mockResolvedValue({
      profile: {
        id: "profile-1", userId: OWNER_ID, displayName: "Alice", nationality: "CN",
        dateOfBirth: null, interests: null, accommodationStyle: null,
        updatedAt: CREATED_AT,
      },
    }),
    updateMyProfile: vi.fn(),
    getTrips: vi.fn(),
    getTrip: vi.fn(),
    getLocationReference: vi.fn(),
    getLocationIntroduction: vi.fn(),
    getTripThreads: vi.fn(),
    createTripThread: vi.fn(),
    getOrCreateDefaultTripThread: vi.fn(),
    getOwnerConversation: vi.fn().mockResolvedValue({ thread: thread(), messages: [] }),
    submitConversationTurn: vi.fn().mockImplementation(async (_threadId, input) => accepted(input.question)),
    getAgentRun: vi.fn().mockResolvedValue(run("RUNNING")),
    cancelAgentRun: vi.fn().mockResolvedValue(run("CANCEL_REQUESTED")),
    subscribeAgentRun: vi.fn().mockImplementation(async (_runId, signal, onEvent) => {
      onEvent({ event: "turn.started", runId: RUN_ID, generationAttempt: 1 });
      onEvent({ event: "message.delta", runId: RUN_ID, generationAttempt: 1, sequence: 0, delta: "A streamed " });
      onEvent({ event: "message.delta", runId: RUN_ID, generationAttempt: 1, sequence: 1, delta: "answer." });
      await untilAborted(signal);
    }),
    startExploration: vi.fn(),
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
    rememberHighlight: vi.fn(),
    getPreferenceCard: vi.fn().mockResolvedValue({ show: false, fields: [] }),
    resolvePreferenceCard: vi.fn().mockResolvedValue({ applied: [] }),
    getMemoryNotes: vi.fn().mockResolvedValue({ notes: [] }),
    deleteMemoryNote: vi.fn(),
    // Shared Plan Surface (Phase 1) — required on TravelApi.
    listTripPlans: vi.fn().mockResolvedValue({ tripId: "00000000-0000-4000-8000-000000000000", proposed: [], active: [], stale: [] }),
    listAdoptionVotes: vi.fn().mockResolvedValue({
      planId: "00000000-0000-4000-8000-000000000000",
      votesAccepted: 0,
      votesRequired: 0,
      hasBlocker: false,
      currentUserDecision: null,
    }),
    castAdoptionVote: vi.fn().mockResolvedValue({
      planId: "00000000-0000-4000-8000-000000000000",
      outcome: "CAST" as const,
      votesAccepted: 0,
      votesRequired: 0,
    }),
    ...overrides,
  };
}

describe("TravelAgentChat durable streaming flow", () => {
  it("shows globe replies as unframed text without repeating the agent badge", async () => {
    const api = createApi({
      getOwnerConversation: vi.fn().mockResolvedValue({
        thread: thread(),
        messages: [
          {
            id: USER_MESSAGE_ID,
            role: "USER",
            content: "A short question.",
            sequence: 1,
            createdAt: CREATED_AT,
          },
          {
            id: ASSISTANT_MESSAGE_ID,
            role: "ASSISTANT",
            content: "A direct answer about Indonesia.",
            sequence: 2,
            createdAt: CREATED_AT,
          },
        ],
      }),
    });

    renderChat(api);

    const answer = await screen.findByText("A direct answer about Indonesia.");
    const reply = answer.closest("article")?.querySelector(".chat-markdown")?.parentElement;
    expect(screen.queryByText("Wanderly Agent")).not.toBeInTheDocument();
    expect(reply).toHaveClass("max-w-[86%]", "py-1", "text-justify", "text-[var(--w-fog)]");
    expect(reply).toHaveAttribute("data-terminal-output", "true");
    expect(reply).toHaveClass("wanderly-terminal-output");
    expect(reply).not.toHaveClass("wanderly-cosmos-surface", "wanderly-edge", "wanderly-shadow-sm");

    const question = screen.getByText("A short question.").parentElement;
    expect(question).toHaveClass("ml-auto", "w-fit", "max-w-[86%]", "py-2", "bg-[var(--w-bot-outline)]");
    expect(question).not.toHaveClass("wanderly-shadow-sm");
    expect(question?.closest("article")).toHaveClass("mb-[17px]");

    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toHaveClass("wanderly-crt-key");
    expect(send).not.toHaveClass("wanderly-action", "wanderly-bot-action", "wanderly-r-md");
  });

  it("renders the model-owned destination decision with parallel actions", async () => {
    const api = createApi({
      subscribeAgentRun: vi.fn().mockImplementation(async (_runId, signal, onEvent) => {
        onEvent({
          event: "destination.cue_ready",
          runId: RUN_ID,
          generationAttempt: 1,
          cue: { id: CUE_ID, version: 1, candidates: [{ id: CANDIDATE_ID, displayName: "Suzhou", status: "PENDING" }] },
        });
        await untilAborted(signal);
      }),
    });

    renderChat(api, { tripId: TRIP_ID });
    await submitFromCapsule("Tell me about Suzhou");

    const question = await screen.findByText("Set Suzhou as the destination?");
    expect(question.closest("section")).toHaveClass("-translate-y-[3px]");
    const plan = screen.getByRole("button", { name: "Save Suzhou to this trip" });
    const explore = screen.getByRole("button", { name: "Leave it as it is" });
    expect(plan.parentElement).toHaveClass("grid-cols-2");
    expect(plan).toHaveClass("wanderly-action");
    expect(explore).toHaveClass("wanderly-cosmos-control");
  });

  it("offers a further destination as an addition once the trip has one", async () => {
    // The sibling test above is the control: with no destination on the trip
    // the same cue asks 「要将 X 设为目的地吗？」. Once Gero is saved, the trip is
    // no longer being told where it is going, and asking that again reads as
    // though the traveller's answer was lost.
    const api = createApi({
      getTrip: vi.fn().mockResolvedValue({
        trip: {
          id: TRIP_ID, name: "Gero", createdBy: OWNER_ID, status: "DRAFT",
          departureCities: ["Beijing"], destinationCandidates: ["Gero"],
          travelDateStart: null, travelDateEnd: null, travelDays: 10,
          createdAt: CREATED_AT, updatedAt: CREATED_AT,
        },
        callerRole: "CREATOR",
        members: [],
      }),
      subscribeAgentRun: vi.fn().mockImplementation(async (_runId, signal, onEvent) => {
        onEvent({
          event: "destination.cue_ready",
          runId: RUN_ID,
          generationAttempt: 1,
          cue: { id: CUE_ID, version: 1, candidates: [{ id: CANDIDATE_ID, displayName: "Kyoto", status: "PENDING" }] },
        });
        await untilAborted(signal);
      }),
    });

    renderChat(api, { tripId: TRIP_ID });
    await submitFromCapsule("Tell me about Kyoto");

    expect(await screen.findByText("Add Kyoto as a further destination?")).toBeInTheDocument();
    expect(screen.queryByText("Set Kyoto as the destination?")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Kyoto to this trip" })).toBeInTheDocument();
  });

  it("explains a destination-resolution rejection without dropping the proposal", async () => {
    const acceptDestinationCue = vi.fn().mockRejectedValue(
      new TravelApiError("DESTINATION_UNRESOLVED: use an unambiguous supported city name", 422, "Unprocessable Entity", null),
    );
    const api = createApi({
      acceptDestinationCue,
      subscribeAgentRun: vi.fn().mockImplementation(async (_runId, signal, onEvent) => {
        onEvent({
          event: "destination.cue_ready",
          runId: RUN_ID,
          generationAttempt: 1,
          cue: { id: CUE_ID, version: 1, candidates: [{ id: CANDIDATE_ID, displayName: "Suzhou", status: "PENDING" }] },
        });
        await untilAborted(signal);
      }),
    });

    renderChat(api, { tripId: TRIP_ID, surface: "TRIP_WORKSPACE", variant: "docked" });
    await submitFromCapsule("Go to Suzhou");
    fireEvent.click(await screen.findByRole("button", { name: "Save Suzhou to this trip" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't verify that city destination.");
    expect(screen.getByText("Set Suzhou as the destination?")).toBeInTheDocument();
  });

  it("confirms exactly which destination was saved", async () => {
    const acceptDestinationCue = vi.fn().mockResolvedValue({
      cue: null,
      trip: { id: TRIP_ID, destinationCandidates: ["Suzhou"], updatedAt: CREATED_AT },
    });
    const api = createApi({
      acceptDestinationCue,
      subscribeAgentRun: vi.fn().mockImplementation(async (_runId, signal, onEvent) => {
        onEvent({
          event: "destination.cue_ready",
          runId: RUN_ID,
          generationAttempt: 1,
          cue: { id: CUE_ID, version: 1, candidates: [{ id: CANDIDATE_ID, displayName: "Suzhou", status: "PENDING" }] },
        });
        await untilAborted(signal);
      }),
    });

    renderChat(api, { tripId: TRIP_ID, surface: "TRIP_WORKSPACE", variant: "docked" });
    await submitFromCapsule("I want to visit Suzhou");
    fireEvent.click(await screen.findByRole("button", { name: "Save Suzhou to this trip" }));

    const saved = await screen.findByText("Suzhou has been saved as a destination for this trip.");
    expect(saved).toHaveAttribute("role", "status");
    expect(acceptDestinationCue).toHaveBeenCalledWith(
      THREAD_ID,
      CUE_ID,
      CANDIDATE_ID,
      expect.objectContaining({ expectedVersion: 1, titleLocale: "en" }),
    );
  });

  /**
   * The card named only the destination while carrying dates it never showed,
   * so a proposal whose end date was two years before its start looked exactly
   * like a good one — until the button failed and said to refresh.
   */
  it("shows the travel dates it is offering to save", async () => {
    const api = createApi({
      subscribeAgentRun: vi.fn().mockImplementation(async (_runId, signal, onEvent) => {
        onEvent({
          event: "trip.brief_proposed",
          runId: RUN_ID,
          generationAttempt: 1,
          proposal: { destinationCandidates: ["Suzhou"], travelDateStart: "2026-10-01", travelDateEnd: "2026-10-07" },
        });
        await untilAborted(signal);
      }),
    });

    renderChat(api, { tripId: TRIP_ID, surface: "TRIP_WORKSPACE", variant: "docked" });
    await submitFromCapsule("Go to Suzhou October 1 to 7");

    // Intl collapses the shared month and year: "Oct 1 – 7, 2026".
    expect(await screen.findByText(/Oct 1\s*.\s*7, 2026/)).toBeInTheDocument();
  });

  it("does not tell the traveller to refresh when the stored dates are the problem", async () => {
    const updateDraftTripBrief = vi.fn().mockRejectedValue(
      new TravelApiError(
        "BRIEF_DATES_INVALID: travel dates must be valid calendar dates with an end date on or after the start date",
        400,
        "Bad Request",
        null,
      ),
    );
    const api = createApi({
      updateDraftTripBrief,
      subscribeAgentRun: vi.fn().mockImplementation(async (_runId, signal, onEvent) => {
        onEvent({
          event: "trip.brief_proposed",
          runId: RUN_ID,
          generationAttempt: 1,
          proposal: { destinationCandidates: ["Suzhou"], travelDateStart: "2026-10-01", travelDateEnd: "2024-10-07" },
        });
        await untilAborted(signal);
      }),
    });

    renderChat(api, { tripId: TRIP_ID, surface: "TRIP_WORKSPACE", variant: "docked" });
    await submitFromCapsule("Go to Suzhou");
    fireEvent.click(await screen.findByRole("button", { name: "Save this to the trip" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Those travel dates can't be used");
    expect(alert).not.toHaveTextContent("Refresh");
  });

  it("renders the empty-thread introduction as a centred session slogan, not an agent message", async () => {
    renderChat(createApi(), { tripId: TRIP_ID, surface: "TRIP_WORKSPACE", variant: "docked" });

    const title = await screen.findByText(/Let's plan somewhere memorable/);
    expect(title).toHaveClass("text-balance", "text-base", "sm:text-lg", "font-bold", "text-primary");
    expect(title.parentElement).toHaveClass("items-start", "text-left", "max-w-[640px]");
    expect(title.parentElement).not.toHaveClass("wanderly-edge", "wanderly-shadow");
    expect(screen.queryByText("Wanderly Agent")).not.toBeInTheDocument();
  });

  it("keeps the docked conversation as one visually centred group above its elevated composer", () => {
    renderChat(createApi(), { tripId: TRIP_ID, surface: "TRIP_WORKSPACE", variant: "docked" });

    expect(screen.getByTestId("docked-chat-composer")).toHaveClass("mb-5", "relative", "z-10", "xl:translate-x-1");
    expect(screen.getByTestId("docked-chat-composer")).not.toHaveClass("xl:translate-x-6", "xl:-translate-x-4");
    expect(screen.getByTestId("docked-chat-composer")).not.toHaveClass("border-2", "wanderly-shadow");
    expect(screen.queryByText("Enter to send · Shift + Enter for a new line · This thread is private to you and scoped to this trip.")).not.toBeInTheDocument();
  });

  it("links an exploration chat to its bound Trip Planner thread", () => {
    renderChat(createApi(), { tripId: TRIP_ID });

    const link = screen.getByRole("link", { name: "Go to Trip Planner" });
    expect(link).toHaveAttribute(
      "href",
      `/trips/${TRIP_ID}?thread=${THREAD_ID}`,
    );
    expect(link).toHaveTextContent("Go to Trip Planner");
  });

  it("collapses the floating conversation from its header control", () => {
    renderChat(createApi());

    fireEvent.click(screen.getByRole("button", { name: "Collapse conversation" }));

    expect(screen.queryByRole("dialog", { name: "Wanderly Agent conversation" })).not.toBeInTheDocument();
    expect(screen.getByRole("form", { name: "Start a conversation with Wanderly Agent" })).toBeInTheDocument();
  });

  it("shows what the assistant looked up, and how each lookup ended", async () => {
    // A reply that pauses while a supplier answers reads as a hang; these
    // rows are the only thing telling the reader work is happening.
    const api = createApi({
      subscribeAgentRun: vi.fn().mockImplementation(async (_runId: string, signal: AbortSignal, onEvent: (e: unknown) => void) => {
        onEvent({ event: "turn.started", runId: RUN_ID, generationAttempt: 1 });
        onEvent({ event: "tool.started", runId: RUN_ID, generationAttempt: 1, capability: "places.search" });
        onEvent({ event: "tool.started", runId: RUN_ID, generationAttempt: 1, capability: "flight.search" });
        onEvent({ event: "tool.settled", runId: RUN_ID, generationAttempt: 1, capability: "places.search", outcome: "AVAILABLE" });
        onEvent({ event: "tool.settled", runId: RUN_ID, generationAttempt: 1, capability: "flight.search", outcome: "UNAVAILABLE", reason: "NO_RESULTS" });
        await untilAborted(signal);
      }),
    });
    renderChat(api);
    fireEvent.change(screen.getByRole("textbox", { name: "Message Wanderly Agent" }), { target: { value: "Where should I go?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      const lookups = screen.getAllByRole("listitem").filter((row) => row.getAttribute("data-capability"));
      expect(lookups.map((row) => row.getAttribute("data-capability"))).toEqual(["places.search", "flight.search"]);
      // A settled lookup keeps its row: "found nothing" is what lets the
      // reader judge the answer that follows.
      expect(lookups.map((row) => row.getAttribute("data-outcome"))).toEqual(["AVAILABLE", "UNAVAILABLE"]);
    });
  });

  it("shows a persistent confirm/cancel button when flight.search needs confirmation, and clicking confirm sends the phrase the server expects", async () => {
    // The assistant already has every field it needs but won't spend the
    // metered provider call without a person's say-so. A person should
    // never have to type "确认搜索" themselves — the button does that.
    const submitConversationTurn = vi.fn().mockImplementation(async (_threadId, input) => accepted(input.question));
    const api = createApi({
      submitConversationTurn,
      getAgentRun: vi.fn().mockResolvedValue(run("COMPLETED")),
      subscribeAgentRun: vi.fn().mockImplementation(async (_runId: string, signal: AbortSignal, onEvent: (e: unknown) => void) => {
        onEvent({ event: "turn.started", runId: RUN_ID, generationAttempt: 1 });
        onEvent({ event: "tool.settled", runId: RUN_ID, generationAttempt: 1, capability: "flight.search", outcome: "NEEDS_CONFIRMATION" });
        onEvent({ event: "turn.completed", runId: RUN_ID, generationAttempt: 1 });
        await untilAborted(signal);
      }),
    });
    renderChat(api);
    fireEvent.change(screen.getByRole("textbox", { name: "Message Wanderly Agent" }), { target: { value: "SIN to NRT, one way, 2026-09-25, 1 adult" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    const confirmButton = await screen.findByRole("button", { name: "Search" });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    // The run finishing (assistant's "please confirm" reply lands) is what
    // clears `isSending` and makes the button clickable, same as real usage.
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).not.toBeDisabled());

    fireEvent.click(confirmButton);

    await waitFor(() => {
      // Names flights. The bare "确认搜索" authorised whichever search the
      // model then picked, and in a thread that had also discussed hotels it
      // picked the hotel one — this button ran a hotel search.
      expect(submitConversationTurn).toHaveBeenLastCalledWith(THREAD_ID, expect.objectContaining({ question: "确认搜索机票" }));
    });
  });

  it("keeps a completed reply when the traveller switches surface mid-run", async () => {
    // Switching surface (the globe's "Back to trip") remounts the chat while
    // the run is still going. Whichever instance sees COMPLETED first clears
    // the stored run pointer, so the instance that mounts afterwards has
    // nothing left to poll — and the conversation it fetched used to land only
    // in the departing instance's own state. The reply died with it, and the
    // new surface showed the question with no answer under it.
    let conversationCalls = 0;
    const withReply = {
      thread: thread(),
      messages: [
        { id: USER_MESSAGE_ID, role: "USER" as const, content: "best month for Kanazawa?", sequence: 1, createdAt: CREATED_AT },
        { id: ASSISTANT_MESSAGE_ID, role: "ASSISTANT" as const, content: "April for the cherry blossom.", sequence: 2, createdAt: CREATED_AT },
      ],
    };
    const api = createApi({
      submitConversationTurn: vi.fn().mockImplementation(async (_t, input) => accepted(input.question)),
      getAgentRun: vi.fn().mockResolvedValue(run("COMPLETED")),
      // The first read is the initial mount, before the turn exists. Every
      // later read has the reply — as the server does.
      getOwnerConversation: vi.fn().mockImplementation(async () => {
        conversationCalls += 1;
        return conversationCalls === 1 ? { thread: thread(), messages: [] } : withReply;
      }),
      subscribeAgentRun: vi.fn().mockImplementation(async (_id: string, signal: AbortSignal) => {
        await untilAborted(signal);
      }),
    });

    function SurfaceSwitcher() {
      const [surface, setSurface] = useState("globe");
      return (
        <>
          <button type="button" onClick={() => setSurface("workspace")}>Back to trip</button>
          {/* A new key is a new instance, sharing one QueryClient — exactly
              what a surface switch does. */}
          <ChatHarness key={surface} controlledThreadId={THREAD_ID} initiallyOpen tripId={TRIP_ID} />
        </>
      );
    }
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(REQUEST_ID);
    renderWithIntl(<SurfaceSwitcher />, { api });

    fireEvent.change(screen.getByRole("textbox", { name: "Message Wanderly Agent" }), { target: { value: "best month for Kanazawa?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("April for the cherry blossom.");

    // Switch surface. The new instance must render the reply from the shared
    // cache — its own query is still inside staleTime, so nothing refetches.
    fireEvent.click(screen.getByRole("button", { name: "Back to trip" }));
    expect(await screen.findByText("April for the cherry blossom.")).toBeInTheDocument();
  });

  it("offers flight preference chips only for a server-classified flight gap, and saves the latest explicit choice without searching", async () => {
    const saveTripSearchPreferences = vi.fn().mockResolvedValue({});
    const api = createApi({
      saveTripSearchPreferences,
      getAgentRun: vi.fn().mockResolvedValue({
        ...run("COMPLETED"),
        researchIntentDraft: {
          kind: "RESEARCH_ONLY",
          requestedCapabilities: ["flight"],
          readiness: "READY_WITH_WARNINGS",
          blockers: [],
          warnings: ["FLIGHT_PREFERENCES_MISSING"],
          missing: ["FLIGHT_PREFERENCES_MISSING"],
        },
      }),
      subscribeAgentRun: vi.fn().mockImplementation(async (_runId: string, signal: AbortSignal, onEvent: (e: unknown) => void) => {
        onEvent({ event: "turn.started", runId: RUN_ID, generationAttempt: 1 });
        onEvent({ event: "turn.completed", runId: RUN_ID, generationAttempt: 1 });
        await untilAborted(signal);
      }),
    });
    renderChat(api, { tripId: TRIP_ID });
    fireEvent.change(screen.getByRole("textbox", { name: "Message Wanderly Agent" }), { target: { value: "Find flights for my trip" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    const card = await screen.findByRole("region", { name: "Set your flight preferences" });
    expect(saveTripSearchPreferences).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Round trip" }));
    fireEvent.click(screen.getByRole("button", { name: /^2$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Economy" }));
    fireEvent.click(screen.getByRole("button", { name: "SGD" }));
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));

    await waitFor(() => expect(saveTripSearchPreferences).toHaveBeenCalledWith(TRIP_ID, {
      tripType: "ROUND_TRIP",
      adults: 2,
      cabin: "ECONOMY",
      currency: "SGD",
      offerFreshnessMinutes: 60,
    }));
    expect(api.submitConversationTurn).toHaveBeenCalledTimes(1);
    expect(card).toHaveTextContent("Saved. You can change any option");

    fireEvent.click(screen.getByRole("button", { name: /^3$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() => expect(saveTripSearchPreferences).toHaveBeenLastCalledWith(TRIP_ID, expect.objectContaining({ adults: 3 })));
  });

  it("still shows the confirm button when the SSE stream drops the tool.settled event, via the polled agent-run fallback", async () => {
    // A dropped/reconnected stream (routine over a LAN Wi-Fi hop) never
    // re-delivers a one-shot SSE event. `useAgentRun` polls regardless, so
    // the button should still appear once that poll reports it — after the
    // turn finishes, which is when the card is allowed to appear at all.
    const api = createApi({
      getAgentRun: vi.fn().mockResolvedValue({ ...run("COMPLETED"), pendingFlightConfirmation: true }),
      subscribeAgentRun: vi.fn().mockImplementation(async (_runId: string, signal: AbortSignal, onEvent: (e: unknown) => void) => {
        onEvent({ event: "turn.started", runId: RUN_ID, generationAttempt: 1 });
        await untilAborted(signal);
      }),
    });
    renderChat(api);
    fireEvent.change(screen.getByRole("textbox", { name: "Message Wanderly Agent" }), { target: { value: "SIN to NRT, one way, 2026-09-25, 1 adult" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await screen.findByRole("button", { name: "Search" });
  });

  it("waits for the reply to finish before offering to run the search", async () => {
    // The tool settles mid-reply. The card used to slide in under a
    // half-written answer, which reads as the assistant interrupting itself.
    const api = createApi({
      getAgentRun: vi.fn().mockResolvedValue({ ...run("RUNNING"), pendingFlightConfirmation: true }),
      subscribeAgentRun: vi.fn().mockImplementation(async (_runId: string, signal: AbortSignal, onEvent: (e: unknown) => void) => {
        onEvent({ event: "turn.started", runId: RUN_ID, generationAttempt: 1 });
        onEvent({ event: "tool.settled", runId: RUN_ID, generationAttempt: 1, capability: "flight.search", outcome: "NEEDS_CONFIRMATION" });
        await untilAborted(signal);
      }),
    });
    renderChat(api);
    fireEvent.change(screen.getByRole("textbox", { name: "Message Wanderly Agent" }), { target: { value: "SIN to NRT, one way, 2026-09-25, 1 adult" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(api.subscribeAgentRun).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Search" })).not.toBeInTheDocument();
  });

  it("does not render a research run card for an ordinary chat turn", async () => {
    // A research run reports stages; a chat turn never does, and this was
    // showing "研究运行 #… / 等待阶段…" under every reply for a run that had
    // no stage to report.
    const api = createApi({
      subscribeAgentRun: vi.fn().mockImplementation(async (_runId: string, signal: AbortSignal, onEvent: (e: unknown) => void) => {
        onEvent({ event: "turn.started", runId: RUN_ID, generationAttempt: 1 });
        await untilAborted(signal);
      }),
    });
    renderChat(api);
    fireEvent.change(screen.getByRole("textbox", { name: "Message Wanderly Agent" }), { target: { value: "Where should I go?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(api.subscribeAgentRun).toHaveBeenCalled());
    expect(screen.queryByTestId("research-run-card")).not.toBeInTheDocument();
  });

  it("settles the newest run of a tool, so a second call does not stop the first from spinning", async () => {
    // The same tool may legitimately run twice in one reply with different
    // arguments; settling the oldest would leave the wrong row running.
    const api = createApi({
      subscribeAgentRun: vi.fn().mockImplementation(async (_runId: string, signal: AbortSignal, onEvent: (e: unknown) => void) => {
        onEvent({ event: "turn.started", runId: RUN_ID, generationAttempt: 1 });
        onEvent({ event: "tool.started", runId: RUN_ID, generationAttempt: 1, capability: "places.search" });
        onEvent({ event: "tool.started", runId: RUN_ID, generationAttempt: 1, capability: "places.search" });
        onEvent({ event: "tool.settled", runId: RUN_ID, generationAttempt: 1, capability: "places.search", outcome: "AVAILABLE" });
        await untilAborted(signal);
      }),
    });
    renderChat(api);
    fireEvent.change(screen.getByRole("textbox", { name: "Message Wanderly Agent" }), { target: { value: "Twice please" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      const rows = screen.getAllByRole("listitem").filter((row) => row.getAttribute("data-capability"));
      expect(rows.map((row) => row.getAttribute("data-outcome"))).toEqual(["RUNNING", "AVAILABLE"]);
    });
  });

  it("reports a typed place-bearing message to the map without waiting for the model", async () => {
    const api = createApi();
    const onConversationText = vi.fn();
    renderChat(api, { onConversationText });

    await submitFromCapsule("Tell me about Tokyo");

    expect(onConversationText).toHaveBeenCalledWith("Tell me about Tokyo");
  });

  it("accepts the USER message first, renders approved deltas, and blocks another active turn", async () => {
    const api = createApi();
    renderChat(api);

    await submitFromCapsule("Tell me about Tokyo");

    expect(await screen.findByText("A streamed answer.")).toBeInTheDocument();
    expect(document.querySelector('[data-streaming="true"] [data-terminal-output="true"]')).toHaveClass("wanderly-terminal-output");
    expect(document.querySelector('[data-streaming="true"][data-terminal-output="true"]')).toHaveClass("wanderly-terminal-output");
    expect(screen.getByText("Tell me about Tokyo")).toBeInTheDocument();
    expect(api.submitConversationTurn).toHaveBeenCalledWith(THREAD_ID, {
      requestId: REQUEST_ID,
      question: "Tell me about Tokyo",
      // Every turn is stamped with the surface it was typed on; this host is
      // the exploration globe, which must never feed long-term memory.
      surface: "EXPLORE",
    });
    expect(api.subscribeAgentRun).toHaveBeenCalledWith(RUN_ID, expect.any(AbortSignal), expect.any(Function));
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("sends selected place context without browser-controlled authority fields", async () => {
    const api = createApi();
    renderChat(api, { selectedPlace: { place: TOKYO, context: "Japan" } });

    await submitFromCapsule("What makes it interesting?");
    await waitFor(() => expect(api.submitConversationTurn).toHaveBeenCalledOnce());
    const [, body] = vi.mocked(api.submitConversationTurn).mock.calls[0];

    expect(body).toEqual({
      requestId: REQUEST_ID,
      question: "What makes it interesting?",
      place: TOKYO,
      surface: "EXPLORE",
    });
    expect(body).not.toHaveProperty("role");
    expect(body).not.toHaveProperty("senderUserId");
  });

  it("cancels only through the explicit Stop control", async () => {
    const api = createApi();
    renderChat(api);
    await submitFromCapsule("Keep working");

    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(api.cancelAgentRun).toHaveBeenCalledWith(RUN_ID));
  });

  it("replaces an earlier generation attempt instead of concatenating retries", async () => {
    const api = createApi({
      subscribeAgentRun: vi.fn().mockImplementation(async (_runId, signal, onEvent) => {
        onEvent({ event: "message.delta", runId: RUN_ID, generationAttempt: 1, sequence: 0, delta: "Old attempt" });
        onEvent({ event: "message.delta", runId: RUN_ID, generationAttempt: 2, sequence: 0, delta: "New attempt" });
        await untilAborted(signal);
      }),
    });
    renderChat(api);
    await submitFromCapsule("Retry safely");

    expect(await screen.findByText("New attempt")).toBeInTheDocument();
    expect(screen.queryByText("Old attempt")).not.toBeInTheDocument();
  });

  it("restores a thread from the controlled threadId prop", async () => {
    const api = createApi({
      getOwnerConversation: vi.fn().mockResolvedValue({
        thread: thread(),
        messages: [
          { id: USER_MESSAGE_ID, role: "USER", content: "Earlier question", sequence: 1, createdAt: CREATED_AT },
          {
            id: ASSISTANT_MESSAGE_ID,
            role: "ASSISTANT",
            content: "Earlier answer",
            sequence: 2,
            createdAt: CREATED_AT,
          },
        ],
      }),
    });
    renderChat(api);

    expect(await screen.findByText("Earlier question")).toBeInTheDocument();
    expect(screen.getByText("Earlier answer")).toBeInTheDocument();
  });

  it("opens restored chat history at the latest message", async () => {
    const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(640);
    const scrollTop = vi.spyOn(HTMLElement.prototype, "scrollTop", "set");
    const api = createApi({
      getOwnerConversation: vi.fn().mockResolvedValue({
        thread: thread(),
        messages: [
          { id: USER_MESSAGE_ID, role: "USER", content: "First question", sequence: 1, createdAt: CREATED_AT },
          {
            id: ASSISTANT_MESSAGE_ID,
            role: "ASSISTANT",
            content: "Latest answer",
            sequence: 2,
            createdAt: CREATED_AT,
          },
        ],
      }),
    });
    renderChat(api, { initiallyOpen: false });

    expect(await screen.findByRole("button", { name: "Chat history" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));

    expect(await screen.findByText("Latest answer")).toBeInTheDocument();
    await waitFor(() => expect(scrollTop).toHaveBeenCalledWith(640));
    scrollHeight.mockRestore();
    scrollTop.mockRestore();
  });

  // Collapsed and open are one terminal in two sizes, not two components: the
  // same screen, showing only its prompt line before the conversation exists.
  // Giving the collapsed state a deep-space card instead made opening the chat
  // read as a jump between two different products.
  it("shows the collapsed composer as the terminal's prompt line", async () => {
    renderChat(createApi(), { initiallyOpen: false });

    const collapsedComposer = screen.getByRole("form", { name: "Start a conversation with Wanderly Agent" });
    expect(collapsedComposer).toHaveClass("wanderly-crt", "wanderly-crt--prompt");
    expect(collapsedComposer).not.toHaveClass("wanderly-cosmos-surface", "wanderly-r-lg", "wanderly-shadow", "bg-card", "wanderly-edge");
    expect(collapsedComposer.querySelector(".wanderly-crt-caret")).toBeInTheDocument();
  });

  // Opening grows the same screen. The panel keeps `.wanderly-cosmos-chat` for
  // the semantic aliases its nested cards read, but takes no deep-space panel
  // of its own — the phosphor tube is the surface.
  it("grows the same terminal for the open conversation", async () => {
    renderChat(createApi(), { initiallyOpen: false });

    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));

    const dialog = await screen.findByRole("dialog", { name: "Wanderly Agent conversation" });
    expect(dialog).toHaveClass("wanderly-cosmos-chat", "wanderly-crt");
    expect(dialog).not.toHaveClass("wanderly-crt--prompt", "wanderly-cosmos-panel", "wanderly-r-lg", "bg-sidebar", "wanderly-edge");

    const composerBox = screen.getByRole("textbox", { name: "Message Wanderly Agent" }).parentElement;
    expect(composerBox).toHaveClass("wanderly-crt-input");
    expect(composerBox).not.toHaveClass("wanderly-cosmos-surface", "wanderly-r-md", "wanderly-shadow-sm", "bg-card");
  });

  it("calls onThreadInvalidated when the server returns 404 from getOwnerConversation", async () => {
    const onInvalidated = vi.fn();
    const api = createApi({
      getOwnerConversation: vi.fn().mockRejectedValue(new TravelApiError("missing", 404, "Not Found", null)),
    });
    renderChat(api, { onThreadInvalidated: onInvalidated });

    await waitFor(() => expect(onInvalidated).toHaveBeenCalledTimes(1));
  });

  it("clears a stale active-run pointer when its durable run can no longer be read", async () => {
    localStorage.setItem(ACTIVE_RUN_KEY(), RUN_ID);
    const api = createApi({
      getAgentRun: vi.fn().mockRejectedValue(new TravelApiError("missing", 404, "Not Found", null)),
    });
    renderChat(api, { initiallyOpen: true });

    await waitFor(() => expect(localStorage.getItem(ACTIVE_RUN_KEY())).toBeNull());
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Wanderly Agent" })).not.toBeDisabled();
  });

  it("clears the pointer when the stored run belongs to somebody else", async () => {
    // Two people signing in on the same browser: the storage key is not scoped
    // per user, so the previous traveller's run id outlives their sign-out.
    // Reading it back answers 403, not 404, and only 404 used to clear it — so
    // the chat polled a stranger's run forever, stuck on "Wanderly is
    // thinking…" with the composer disabled behind it.
    localStorage.setItem(ACTIVE_RUN_KEY(), RUN_ID);
    const api = createApi({
      getAgentRun: vi.fn().mockRejectedValue(
        new TravelApiError("forbidden", 403, "Not authorized for this Agent run", null),
      ),
    });
    renderChat(api, { initiallyOpen: true });

    await waitFor(() => expect(localStorage.getItem(ACTIVE_RUN_KEY())).toBeNull());
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Wanderly Agent" })).not.toBeDisabled();
  });

  it("restores a running durable run after mount without submitting another turn", async () => {
    localStorage.setItem(ACTIVE_RUN_KEY(), RUN_ID);
    const api = createApi();

    renderChat(api);

    await waitFor(() => expect(api.subscribeAgentRun).toHaveBeenCalledWith(RUN_ID, expect.any(AbortSignal), expect.any(Function)));
    expect(api.submitConversationTurn).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("clears a completed durable-run pointer after restoring persisted history", async () => {
    localStorage.setItem(ACTIVE_RUN_KEY(), RUN_ID);
    const api = createApi({
      getAgentRun: vi.fn().mockResolvedValue(run("COMPLETED")),
      getOwnerConversation: vi.fn().mockResolvedValue({
        thread: thread(),
        messages: [
          { id: USER_MESSAGE_ID, role: "USER", content: "Earlier question", sequence: 1, createdAt: CREATED_AT },
          { id: ASSISTANT_MESSAGE_ID, role: "ASSISTANT", content: "Persisted answer", sequence: 2, createdAt: CREATED_AT },
        ],
      }),
    });

    renderChat(api);

    expect(await screen.findByText("Persisted answer")).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem(ACTIVE_RUN_KEY())).toBeNull());
    expect(screen.getByRole("textbox", { name: "Message Wanderly Agent" })).not.toBeDisabled();
  });

  it("calls onThreadInvalidated when submitConversationTurn returns 404", async () => {
    const onInvalidated = vi.fn();
    const api = createApi({
      submitConversationTurn: vi.fn().mockRejectedValue(new TravelApiError("missing", 404, "Not Found", null)),
    });
    renderChat(api, { onThreadInvalidated: onInvalidated });

    await submitFromCapsule("Anything");

    await waitFor(() => expect(onInvalidated).toHaveBeenCalledTimes(1));
  });

  it("offers a same-request retry after a transient server error", async () => {
    const submitConversationTurn = vi.fn()
      .mockRejectedValueOnce(new TravelApiError("failed", 500, "Internal Server Error", null))
      .mockImplementationOnce(async (_threadId, input) => accepted(input.question));
    const api = createApi({ submitConversationTurn });
    renderChat(api);

    await submitFromCapsule("Try Japan again");
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() => expect(submitConversationTurn).toHaveBeenCalledTimes(2));
    expect(submitConversationTurn.mock.calls[1]).toEqual(submitConversationTurn.mock.calls[0]);
  });

  it("explains when the browser cannot reach the API instead of showing a generic send failure", async () => {
    const api = createApi({
      submitConversationTurn: vi.fn().mockRejectedValue(new TravelApiError("offline", null, "Network Error", null)),
    });
    renderChat(api);

    await submitFromCapsule("Find flights");

    expect(await screen.findByText("The travel service could not be reached. Check the connection and try again.")).toBeInTheDocument();
  });

  it("does not include the intent field for manually typed questions", async () => {
    const api = createApi();
    renderChat(api, { selectedPlace: { place: TOKYO, context: "Japan" } });

    fireEvent.change(screen.getByRole("textbox", { name: "Message Wanderly Agent" }), { target: { value: "What is the weather like?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(api.submitConversationTurn).toHaveBeenCalledTimes(1));
    const [, body] = vi.mocked(api.submitConversationTurn).mock.calls[0];
    expect(body).toEqual({
      requestId: REQUEST_ID,
      question: "What is the weather like?",
      place: TOKYO,
      surface: "EXPLORE",
    });
    expect(body).not.toHaveProperty("intent");
  });

  it("offers an explicit Start new exploration action without sending a turn", () => {
    const api = createApi();
    const onStartNewExploration = vi.fn();
    renderChat(api, { onStartNewExploration });

    fireEvent.click(screen.getByRole("button", { name: "Start new exploration" }));

    expect(onStartNewExploration).toHaveBeenCalledTimes(1);
    expect(api.submitConversationTurn).not.toHaveBeenCalled();
  });
});

describe("terminal typing cadence", () => {
  // Mirrors a real run measured from a browser HAR: a 159-character reply
  // delivered as ~13 clause-sized deltas spread across the generation window.
  it("draws behind the stream instead of painting each delta whole", async () => {
    const CLAUSE = "根据你的出发时间和预算，";
    const api = createApi({
      subscribeAgentRun: vi.fn().mockImplementation(async (_runId, signal, onEvent) => {
        onEvent({ event: "turn.started", runId: RUN_ID, generationAttempt: 1 });
        for (let sequence = 0; sequence < 6; sequence += 1) {
          await new Promise((resolve) => setTimeout(resolve, 120));
          onEvent({
            event: "message.delta", runId: RUN_ID, generationAttempt: 1, sequence, delta: CLAUSE,
          });
        }
        await untilAborted(signal);
      }),
    });
    renderChat(api);
    await submitFromCapsule("帮我规划");

    // Sample the two counters while deltas are still landing.
    let sawLag = false;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const node = document.querySelector('[data-stream-chars]') as HTMLElement | null;
      if (!node) continue;
      const arrived = Number(node.dataset.streamChars ?? 0);
      const typed = Number(node.dataset.typedChars ?? 0);
      if (arrived > 0 && typed < arrived) { sawLag = true; break; }
    }
    expect(sawLag).toBe(true);

    // And it always catches up to everything that arrived.
    await waitFor(() => {
      const node = document.querySelector('[data-stream-chars]') as HTMLElement;
      expect(node.dataset.typedChars).toBe(node.dataset.streamChars);
    }, { timeout: 4000 });
  });
});

async function submitFromCapsule(question: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Message Wanderly Agent" }), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
}

function thread() {
  return {
    id: THREAD_ID,
    ownerUserId: OWNER_ID,
    tripId: TRIP_ID,
    scope: "TRIP" as const,
    isDefault: false,
    title: "Explore conversation",
    createdAt: CREATED_AT,
    archivedAt: null,
  };
}

function accepted(question: string): ConversationTurnAcceptedResponse {
  return acceptedForThread(THREAD_ID, question);
}

function acceptedForThread(threadId: string, question: string): ConversationTurnAcceptedResponse {
  return {
    threadId,
    runId: RUN_ID,
    operation: "CONVERSATION",
    status: "QUEUED",
    generationAttempt: 0,
    userMessage: {
      id: USER_MESSAGE_ID,
      role: "USER",
      content: question,
      sequence: 1,
      createdAt: CREATED_AT,
    },
  };
}

function run(status: AgentRun["status"]): AgentRun {
  return {
    runId: RUN_ID,
    operation: "CONVERSATION",
    status,
    generationAttempt: status === "QUEUED" ? 0 : 1,
    attemptCount: status === "QUEUED" ? 0 : 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    finishedAt: null,
    errorCode: null,
    assistantMessageId: null,
    resultPlanId: null,
    researchIntentDraft: null,
    researchIntentState: null,
  };
}

function untilAborted(signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

/**
 * The card only belongs inside a trip, so these mount the workspace surface.
 * On the globe it must not appear at all — the case below the block.
 */
describe("the trip's preference card", () => {
  const card = {
    show: true,
    fields: [
      { fieldKey: "trip_pace", category: "PREFERENCE" as const, value: "relaxed", inherited: true, options: ["relaxed", "balanced", "packed"], kind: "enum" as const },
      { fieldKey: "interests", category: "PREFERENCE" as const, value: ["ramen"], inherited: true, options: null, kind: "list" as const },
    ],
  };

  it("renders card actions as underlined links with directional affordances", async () => {
    const api = createApi({ getPreferenceCard: vi.fn().mockResolvedValue(card) });
    renderChat(api, { tripId: TRIP_ID, surface: "TRIP_WORKSPACE" });

    const preferenceCard = await screen.findByTestId("trip-preference-card");
    expect(preferenceCard).not.toHaveClass("wanderly-shadow");
    expect(screen.getByRole("button", { name: "Edit" })).toHaveClass("underline");
    expect(screen.getByTestId("trip-preference-submit")).toHaveClass("underline");
    expect(preferenceCard.querySelectorAll("svg[aria-hidden='true']")).toHaveLength(2);
  });

  it("submits only what the traveller changed", async () => {
    // Writing every field would pin the whole set to this trip, and a later
    // profile edit would stop reaching a trip nobody meant to detach.
    const api = createApi({
      getPreferenceCard: vi.fn().mockResolvedValue(card),
      resolvePreferenceCard: vi.fn().mockResolvedValue({ applied: ["trip_pace"] }),
    });
    renderChat(api, { tripId: TRIP_ID, surface: "TRIP_WORKSPACE" });

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("trip_pace"), { target: { value: "packed" } });
    fireEvent.click(screen.getByTestId("trip-preference-submit"));

    await waitFor(() => expect(api.resolvePreferenceCard).toHaveBeenCalledWith(
      TRIP_ID, [{ fieldKey: "trip_pace", value: "packed" }],
    ));
  });

  it("sends a list field as a list the first time it is filled in", async () => {
    // The shape used to be guessed from the value on screen, which is null
    // until the field is first set. So a first `interests` went up as the raw
    // typed string, the catalogue rejected it against `z.array(z.string())`,
    // and the failed save also skipped the card's "seen" marker — the answer
    // was lost and the card came back on the next visit.
    const unsetInterests = {
      show: true,
      fields: [{ ...card.fields[1], value: null }],
    };
    const api = createApi({
      getPreferenceCard: vi.fn().mockResolvedValue(unsetInterests),
      resolvePreferenceCard: vi.fn().mockResolvedValue({ applied: ["interests"] }),
    });
    renderChat(api, { tripId: TRIP_ID, surface: "TRIP_WORKSPACE" });

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("interests"), { target: { value: "historical sites, museums" } });
    fireEvent.click(screen.getByTestId("trip-preference-submit"));

    await waitFor(() => expect(api.resolvePreferenceCard).toHaveBeenCalledWith(
      TRIP_ID, [{ fieldKey: "interests", value: ["historical sites", "museums"] }],
    ));
  });

  it("sends a boolean field as a boolean and a number field as a number", async () => {
    // Both are null until first set, so inferring the control from the value
    // gave them a text box: `no_red_eye` went up as a string and the server
    // answered 422 "Memory field rejected (INVALID_VALUE): no_red_eye".
    const typed = {
      show: true,
      fields: [
        { fieldKey: "no_red_eye", category: "PREFERENCE" as const, value: null, inherited: true, options: null, kind: "boolean" as const },
        { fieldKey: "budget_max_usd", category: "PREFERENCE" as const, value: null, inherited: true, options: null, kind: "number" as const },
      ],
    };
    const api = createApi({
      getPreferenceCard: vi.fn().mockResolvedValue(typed),
      resolvePreferenceCard: vi.fn().mockResolvedValue({ applied: ["no_red_eye", "budget_max_usd"] }),
    });
    renderChat(api, { tripId: TRIP_ID, surface: "TRIP_WORKSPACE" });

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByLabelText("no_red_eye"));
    fireEvent.change(screen.getByLabelText("budget_max_usd"), { target: { value: "2500" } });
    fireEvent.click(screen.getByTestId("trip-preference-submit"));

    await waitFor(() => expect(api.resolvePreferenceCard).toHaveBeenCalledWith(TRIP_ID, [
      { fieldKey: "no_red_eye", value: true },
      { fieldKey: "budget_max_usd", value: 2500 },
    ]));
    // The card is done and goes, but silence there reads exactly like the
    // failure it used to be — so it says what happened on the way out.
    // A second `role="status"` now appears for the follow-up turn in flight,
    // so match the saved line rather than "the" status.
    expect(await screen.findByText("Saved for this trip.")).toBeInTheDocument();
    expect(screen.queryByTestId("trip-preference-card")).not.toBeInTheDocument();
  });

  it("asks the assistant to pick the conversation back up once the card is answered", async () => {
    // Answering the card used to end in silence: it wrote the overrides,
    // closed, and nothing spoke. The turn carries `preferences_saved` so the
    // prompt can tell this from something the traveller typed.
    const api = createApi({
      getPreferenceCard: vi.fn().mockResolvedValue(card),
      resolvePreferenceCard: vi.fn().mockResolvedValue({ applied: ["trip_pace"] }),
    });
    renderChat(api, { tripId: TRIP_ID, surface: "TRIP_WORKSPACE" });

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("trip_pace"), { target: { value: "packed" } });
    fireEvent.click(screen.getByTestId("trip-preference-submit"));

    await waitFor(() => expect(api.submitConversationTurn).toHaveBeenCalledWith(
      THREAD_ID,
      expect.objectContaining({ intent: "preferences_saved" }),
    ));
  });

  it("picks the conversation back up once the remaining trip details are saved", async () => {
    // Destination confirmation is handled by its durable cue. The brief card
    // still owns non-destination details, and saving those must continue the
    // conversation instead of ending in silence.
    // The proposal rides on a run, so there has to be one to read it from.
    localStorage.setItem(ACTIVE_RUN_KEY(), RUN_ID);
    const api = createApi({
      getAgentRun: vi.fn().mockResolvedValue({
        ...run("COMPLETED"),
        tripBriefProposal: { travelDays: 6 },
      }),
      updateDraftTripBrief: vi.fn().mockResolvedValue({
        trip: {
          id: TRIP_ID, name: "Bangkok", nameSource: "AUTO", status: "DRAFT",
          departureCities: [], destinationCandidates: ["Bangkok"],
          travelDateStart: null, travelDateEnd: null, travelDays: null,
          updatedAt: "2026-09-05T10:00:00.000Z",
        },
      }),
      getTrip: vi.fn().mockResolvedValue({
        trip: {
          id: TRIP_ID, name: "Bangkok", createdBy: OWNER_ID, status: "DRAFT",
          departureCities: [], destinationCandidates: ["Bangkok"],
          travelDateStart: null, travelDateEnd: null, travelDays: null,
          createdAt: CREATED_AT, updatedAt: CREATED_AT,
        },
        callerRole: "CREATOR",
        members: [],
      }),
    });
    renderChat(api, { tripId: TRIP_ID, surface: "TRIP_WORKSPACE" });

    fireEvent.click(await screen.findByRole("button", { name: "Save this to the trip" }));

    await waitFor(() => expect(api.submitConversationTurn).toHaveBeenCalledWith(
      THREAD_ID,
      expect.objectContaining({ intent: "brief_saved" }),
    ));
  });

  /**
   * The readiness notice belongs to the planner, not the globe.
   *
   * On the globe someone is asking what a place is like — 「介绍一下蒙古国」 is
   * a question about Mongolia, not a request to start planning — and answering
   * it with a list of fields they have not been asked for reads as a chore
   * they failed to do. The thread still syncs to the trip either way; only the
   * call to action waits for the surface where starting is the point.
   */
  describe("the DRAFT planning CTA", () => {
    function draftTripApi() {
      return createApi({
        getTrip: vi.fn().mockResolvedValue({
          trip: {
            id: TRIP_ID, name: "Mongolia", createdBy: OWNER_ID, status: "DRAFT",
            departureCities: [], destinationCandidates: [],
            travelDateStart: null, travelDateEnd: null, travelDays: null,
            createdAt: CREATED_AT, updatedAt: CREATED_AT,
          },
          callerRole: "CREATOR",
          members: [],
        }),
      });
    }

    it("stays hidden until the brief can actually start planning", async () => {
      const api = draftTripApi();
      renderChat(api, { tripId: TRIP_ID, surface: "TRIP_WORKSPACE" });

      await waitFor(() => expect(api.getTrip).toHaveBeenCalledWith(TRIP_ID));
      expect(screen.queryByText("Trip details aren't complete yet")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Start planning/i })).not.toBeInTheDocument();
    });

    function profileWith(nationality: string | null) {
      return {
        profile: {
          id: "p1", userId: OWNER_ID, displayName: "Alice", nationality,
          dateOfBirth: null, interests: null, accommodationStyle: null,
          updatedAt: CREATED_AT,
        },
      };
    }

    function readyTripApi(nationality: string | null, activateTrip = vi.fn()) {
      return createApi({
        activateTrip,
        getMyProfile: vi.fn().mockResolvedValue(profileWith(nationality)),
        getTrip: vi.fn().mockResolvedValue({
          trip: {
            id: TRIP_ID, name: "Tokyo", createdBy: OWNER_ID, status: "DRAFT",
            departureCities: ["Chengdu"], destinationCandidates: ["Tokyo"],
            travelDateStart: "2026-09-26", travelDateEnd: "2026-10-05", travelDays: 10,
            createdAt: CREATED_AT, updatedAt: CREATED_AT,
          },
          callerRole: "CREATOR",
          members: [],
        }),
      });
    }

    /**
     * Hotel prices are quoted per nationality and the server will not guess
     * one. It has accepted `guestNationality` since the quote work landed, but
     * nothing ever sent it and no screen asked — so a traveller whose profile
     * had none pressed "Start planning" on a complete brief, activation came
     * back 422 "A confirmed Nuitee hotel quote nationality is required", and
     * all they saw was 「这条消息暂时无法被接受」.
     */
    it("asks for a quote nationality when the profile has none, and sends it", async () => {
      const activateTrip = vi.fn().mockResolvedValue({ trip: { id: TRIP_ID }, planningRun: null });
      renderChat(readyTripApi(null, activateTrip), { tripId: TRIP_ID, surface: "TRIP_WORKSPACE" });

      const start = await screen.findByRole("button", { name: /Start planning/i });
      // Held until answered: pressing it without one is the 422.
      expect(start).toBeDisabled();

      fireEvent.change(await screen.findByLabelText(/Nationality for quotes/i), { target: { value: "CN" } });
      expect(start).toBeEnabled();
      fireEvent.click(start);

      await waitFor(() => expect(activateTrip).toHaveBeenCalledWith(
        TRIP_ID,
        expect.objectContaining({ guestNationality: "CN" }),
      ));
    });

    it("does not ask when the profile already carries one", async () => {
      const activateTrip = vi.fn().mockResolvedValue({ trip: { id: TRIP_ID }, planningRun: null });
      renderChat(readyTripApi("CN", activateTrip), { tripId: TRIP_ID, surface: "TRIP_WORKSPACE" });

      const start = await screen.findByRole("button", { name: /Start planning/i });
      expect(start).toBeEnabled();
      expect(screen.queryByLabelText(/Nationality for quotes/i)).not.toBeInTheDocument();

      fireEvent.click(start);

      // The client never echoes a profile value back; the server prefers its own.
      await waitFor(() => expect(activateTrip).toHaveBeenCalled());
      expect(activateTrip.mock.calls[0][1]).not.toHaveProperty("guestNationality");
    });

    it("stays off the globe", async () => {
      // The workspace half of this pair is the positive control: the same
      // fixture, the same DRAFT trip, and the notice appears. Asserting its
      // absence on the globe only means something once the trip has actually
      // loaded — the placeholder is on screen from the first frame, so waiting
      // for that would let the assertion run before the query ever resolved,
      // and it would pass with the surface check deleted.
      const api = draftTripApi();
      renderChat(api, { tripId: TRIP_ID, surface: "EXPLORE" });

      await waitFor(() => expect(api.getTrip).toHaveBeenCalledWith(TRIP_ID));
      // The query resolves in microtasks; a macrotask turn runs after all of
      // them, so once this returns the trip is committed and anything it gates
      // is on screen — or it is never coming.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(screen.queryByText("Trip details aren't complete yet")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Start planning/i })).not.toBeInTheDocument();
    });
  });

  it("keeps the card up when the save is refused, so the answer can be corrected", async () => {
    // Clearing it on a rejection left a red line and nothing to edit: the
    // traveller's answer was gone with no way to put it back.
    const api = createApi({
      getPreferenceCard: vi.fn().mockResolvedValue(card),
      resolvePreferenceCard: vi.fn().mockRejectedValue(new Error("422")),
    });
    renderChat(api, { tripId: TRIP_ID, surface: "TRIP_WORKSPACE" });

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("trip_pace"), { target: { value: "packed" } });
    fireEvent.click(screen.getByTestId("trip-preference-submit"));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be saved/);
    expect(screen.getByTestId("trip-preference-card")).toBeInTheDocument();
  });

  it("treats closing without a change as an answer, and writes no override", async () => {
    // Inheriting the profile is usually right, and saying so has to be as
    // easy as changing something.
    const api = createApi({
      getPreferenceCard: vi.fn().mockResolvedValue(card),
      resolvePreferenceCard: vi.fn().mockResolvedValue({ applied: [] }),
    });
    renderChat(api, { tripId: TRIP_ID, surface: "TRIP_WORKSPACE" });

    fireEvent.click(await screen.findByTestId("trip-preference-submit"));

    await waitFor(() => expect(api.resolvePreferenceCard).toHaveBeenCalledWith(TRIP_ID, []));
    await waitFor(() => expect(screen.queryByTestId("trip-preference-card")).not.toBeInTheDocument());
  });

  it("takes typing past it as an answer and gets out of the way", async () => {
    // Reading it, deciding the profile is right and just asking a question
    // says so as clearly as pressing the button. Leaving the card up would
    // make the traveller dismiss something they had already moved past.
    const api = createApi({
      getPreferenceCard: vi.fn().mockResolvedValue(card),
      resolvePreferenceCard: vi.fn().mockResolvedValue({ applied: [] }),
    });
    renderChat(api, { tripId: TRIP_ID, surface: "TRIP_WORKSPACE" });
    await screen.findByTestId("trip-preference-card");

    fireEvent.change(screen.getByRole("textbox", { name: "Message Wanderly Agent" }), { target: { value: "Where should I go?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(screen.queryByTestId("trip-preference-card")).not.toBeInTheDocument());
    expect(api.resolvePreferenceCard).toHaveBeenCalledWith(TRIP_ID, []);
  });

  it("comes back on the phrase its own hint gives, showing what applies now", async () => {
    // After an adjustment that is the trip's value, not the profile's — which
    // is the whole point of asking again from another thread.
    const adjusted = {
      show: false,
      fields: [{ ...card.fields[0], value: "packed", inherited: false }, card.fields[1]],
    };
    const api = createApi({
      getPreferenceCard: vi.fn()
        .mockResolvedValueOnce({ ...card, show: false })
        .mockResolvedValue(adjusted),
    });
    renderChat(api, { tripId: TRIP_ID, surface: "TRIP_WORKSPACE" });
    await waitFor(() => expect(api.getPreferenceCard).toHaveBeenCalled());
    expect(screen.queryByTestId("trip-preference-card")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Message Wanderly Agent" }), { target: { value: "trip preferences" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    const reopened = await screen.findByTestId("trip-preference-card");
    // Rendered as its label, not the stored token: the card used to show the
    // traveller `packed` (and `city_center`) verbatim.
    expect(within(reopened).getByText("Packed")).toBeInTheDocument();
    // The phrase opens a card; it is not a question for the model.
    expect(api.submitConversationTurn).not.toHaveBeenCalled();
  });

  it("stays away once the member has been asked", async () => {
    const api = createApi({ getPreferenceCard: vi.fn().mockResolvedValue({ show: false, fields: card.fields }) });
    renderChat(api, { tripId: TRIP_ID, surface: "TRIP_WORKSPACE" });

    await waitFor(() => expect(api.getPreferenceCard).toHaveBeenCalled());
    expect(screen.queryByTestId("trip-preference-card")).not.toBeInTheDocument();
  });
});

describe("the preference card and the globe", () => {
  it("does not put the card in front of someone who is still browsing", async () => {
    const card = {
      show: true,
      fields: [{ key: "trip_pace", value: null, source: "PROFILE" as const, options: ["relaxed", "packed"] }],
    };
    const api = {
      ...createApi(),
      getPreferenceCard: vi.fn().mockResolvedValue(card),
      resolvePreferenceCard: vi.fn().mockResolvedValue({ applied: [] }),
    } as unknown as TravelApi;
    // The globe: a DRAFT trip exists here only because the first message made
    // one, so a form about "this trip" is an interruption, not a question.
    renderChat(api, { tripId: TRIP_ID });

    await waitFor(() => expect(screen.getByPlaceholderText(/Ask about your next trip/i)).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: /Preferences for this trip/i })).not.toBeInTheDocument();
    // And it is not consumed either — the trip's planner still gets its turn.
    expect(api.getPreferenceCard).not.toHaveBeenCalled();
    expect(api.resolvePreferenceCard).not.toHaveBeenCalled();
  });
});

describe("when a durable run fails", () => {
  /**
   * The old copy said "The message could not be sent. Please try again." for
   * every failure, including a planning run that failed twenty seconds after
   * the message was safely stored — and offered a retry that was guaranteed to
   * fail the same way.
   */
  it("names the planning failure and its reason instead of blaming the send", async () => {
    const api = {
      ...createApi(),
      getAgentRun: vi.fn().mockResolvedValue({
        runId: RUN_ID,
        operation: "RESEARCH",
        status: "FAILED",
        errorCode: "PLANNING_DATA_UNAVAILABLE",
        generationAttempt: 0,
        attemptCount: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        assistantMessageId: null,
        resultPlanId: null,
      }),
    } as unknown as TravelApi;
    renderChat(api, { tripId: TRIP_ID, surface: "TRIP_WORKSPACE" });

    await submitFromCapsule("上海出发，12月10日去东京玩四天");

    await waitFor(() => {
      expect(screen.getByText(/could not get room prices/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/message could not be sent/i)).not.toBeInTheDocument();
    // Retrying this changes nothing, so it is not offered.
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  /**
   * A conversation run that dies on an unclassified server fault fell through
   * to the same "could not be sent" copy. It reached a real traveller: a blank
   * `MODEL_GATEWAY_API_KEY=` in a later `.env` block shadowed the real key, the
   * worker threw ~60ms in, and the screen blamed the send and offered a retry
   * that could never work. The message itself was accepted and stored — a run
   * row exists at all only because it was.
   */
  it("does not blame the send when a conversation run fails on the server", async () => {
    const api = {
      ...createApi(),
      getAgentRun: vi.fn().mockResolvedValue({
        runId: RUN_ID,
        operation: "CONVERSATION",
        status: "FAILED",
        errorCode: "INTERNAL",
        generationAttempt: 0,
        attemptCount: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        assistantMessageId: null,
        resultPlanId: null,
      }),
    } as unknown as TravelApi;
    renderChat(api, { tripId: TRIP_ID, surface: "TRIP_WORKSPACE" });

    await submitFromCapsule("请你帮我介绍一下 Melville Senior High School WA");

    await waitFor(() => {
      expect(screen.getByText(/hit an error on its own side/i)).toBeInTheDocument();
    });
    // All three of the old copy's claims were false: the message was stored,
    // the failure came after it, and retrying repeats it exactly.
    expect(screen.queryByText(/message could not be sent/i)).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/your message was saved/i);
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });
});

describe("highlighting something worth remembering", () => {
  /**
   * jsdom's Selection cannot be produced by a drag, so this stands in for what
   * the browser hands the handler afterwards: some text and where it sits.
   */
  function selectInside(text: string | null, container?: Node) {
    vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => text ?? "",
      rangeCount: text ? 1 : 0,
      getRangeAt: () => ({
        getBoundingClientRect: () => ({ left: 100, top: 200, width: 40 }),
        // Capture now happens at the document on pointerup and finds the
        // message from the selection, so the selection must report where it is.
        commonAncestorContainer: container ?? document.body,
      }),
      removeAllRanges: () => undefined,
    } as unknown as Selection);
  }

  it("offers to remember a selection, and reports what became of it", async () => {
    const api = createApi({
      getOwnerConversation: vi.fn().mockResolvedValue({
        thread: thread(),
        messages: [{ id: ASSISTANT_MESSAGE_ID, role: "ASSISTANT", content: "京都的町屋很适合你", sequence: 1, createdAt: CREATED_AT }],
      }),
      rememberHighlight: vi.fn().mockResolvedValue({
        outcome: "REMEMBERED_NOTE", memoryId: "note-1", remaining: 19, highlightMaxChars: 500,
      }),
    });
    renderChat(api);
    const bubble = await screen.findByText("京都的町屋很适合你");
    selectInside("町屋", bubble);
    fireEvent.pointerUp(bubble);

    const rememberButton = await screen.findByTestId("remember-highlight");
    expect(rememberButton).toHaveClass("wanderly-r-xs", "wanderly-remember-highlight", "text-[var(--w-fog)]");
    expect(rememberButton).not.toHaveClass("hover:bg-[var(--w-bot-outline)]");
    expect(rememberButton).not.toHaveClass("rounded-full");
    fireEvent.click(rememberButton);

    await waitFor(() => expect(api.rememberHighlight).toHaveBeenCalledWith(
      expect.objectContaining({ highlight: "町屋", sourceMessageId: ASSISTANT_MESSAGE_ID }),
    ));
    expect(await screen.findByTestId("remember-result")).toHaveTextContent("19");
  });

  it("tells the traveller when a highlight is too long instead of cutting it", async () => {
    const api = createApi({
      getOwnerConversation: vi.fn().mockResolvedValue({
        thread: thread(),
        messages: [{ id: ASSISTANT_MESSAGE_ID, role: "ASSISTANT", content: "很长的一段", sequence: 1, createdAt: CREATED_AT }],
      }),
      rememberHighlight: vi.fn().mockResolvedValue({
        outcome: "TOO_LONG", length: 720, limit: 500, highlightMaxChars: 500,
      }),
    });
    renderChat(api);
    const bubble = await screen.findByText("很长的一段");
    selectInside("很长的一段", bubble);
    fireEvent.pointerUp(bubble);
    fireEvent.click(await screen.findByTestId("remember-highlight"));

    expect(await screen.findByTestId("remember-result")).toHaveTextContent("720");
  });

  it("shows nothing to remember when the selection is empty", async () => {
    const api = createApi({
      getOwnerConversation: vi.fn().mockResolvedValue({
        thread: thread(),
        messages: [{ id: ASSISTANT_MESSAGE_ID, role: "ASSISTANT", content: "普通回复", sequence: 1, createdAt: CREATED_AT }],
      }),
    });
    renderChat(api);
    const bubble = await screen.findByText("普通回复");
    selectInside(null);
    fireEvent.pointerUp(bubble);

    expect(screen.queryByTestId("remember-highlight")).not.toBeInTheDocument();
  });

  it("still offers to remember when the drag is released outside the bubble", async () => {
    // Flinging the pointer off the message before letting go used to lose the
    // selection: the release landed elsewhere, so the bubble's own handler
    // never ran. Capture now happens at the document and finds the message
    // from the selection, so where the pointer lands no longer matters.
    const api = createApi({
      getOwnerConversation: vi.fn().mockResolvedValue({
        thread: thread(),
        messages: [{ id: ASSISTANT_MESSAGE_ID, role: "ASSISTANT", content: "京都的町屋很适合你", sequence: 1, createdAt: CREATED_AT }],
      }),
    });
    renderChat(api);
    const bubble = await screen.findByText("京都的町屋很适合你");
    // The selection sits in the message, but the pointer is released on the
    // page far from it.
    selectInside("町屋", bubble);
    fireEvent.pointerUp(document.body);

    expect(await screen.findByTestId("remember-highlight")).toBeInTheDocument();
  });

  it("clears the bubble the moment the selection empties, in step with the underline", async () => {
    // The bubble and the underline both stand for the live selection. Binding
    // them to it keeps them from desyncing: when the selection collapses (the
    // underline goes), the bubble goes with it, rather than lingering.
    const api = createApi({
      getOwnerConversation: vi.fn().mockResolvedValue({
        thread: thread(),
        messages: [{ id: ASSISTANT_MESSAGE_ID, role: "ASSISTANT", content: "京都的町屋很适合你", sequence: 1, createdAt: CREATED_AT }],
      }),
    });
    renderChat(api);
    const bubble = await screen.findByText("京都的町屋很适合你");
    selectInside("町屋", bubble);
    fireEvent.pointerUp(bubble);
    await screen.findByTestId("remember-highlight");

    // The selection collapses (a click on the text, a scroll, anything) — the
    // underline would vanish, and the bubble must vanish with it.
    selectInside(null);
    document.dispatchEvent(new Event("selectionchange"));

    await waitFor(() => expect(screen.queryByTestId("remember-highlight")).not.toBeInTheDocument());
  });
});

describe("one thread's messages stay in that thread", () => {
  it("does not render the previous thread's conversation inside a new one", async () => {
    // The database held two messages and the screen showed a dozen. The
    // server builds the model's context from the real thread, so the
    // traveller could ask about a flight that was on their screen and
    // nowhere in the assistant's context.
    function ThreadSwitcher() {
      const [id, setId] = useState<string>(THREAD_ID);
      return (
        <>
          <button type="button" onClick={() => setId("99999999-9999-4999-8999-999999999999")}>switch thread</button>
          <ChatHarness controlledThreadId={id} />
        </>
      );
    }
    const api = createApi({
      getOwnerConversation: vi.fn().mockResolvedValue({ thread: thread(), messages: [] }),
    });
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(REQUEST_ID);
    renderWithIntl(<ThreadSwitcher />, { api });

    fireEvent.change(screen.getByRole("textbox", { name: "Message Wanderly Agent" }), { target: { value: "first thread question" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("first thread question");

    fireEvent.click(screen.getByRole("button", { name: "switch thread" }));

    await waitFor(() => {
      expect(screen.queryByText("first thread question")).not.toBeInTheDocument();
    });
  });
});

describe("Enter while an IME is composing", () => {
  it("lands the characters instead of sending the message", () => {
    // Typing "sgd" with a Chinese IME leaves the letters uncommitted until
    // Enter lands them. That Enter reached the form and sent the draft
    // mid-sentence — a key meaning "keep what I typed" posted the message.
    const api = createApi();
    renderChat(api);
    const input = screen.getByRole("textbox", { name: "Message Wanderly Agent" });
    fireEvent.change(input, { target: { value: "上海酒店，币种 sgd" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(api.submitConversationTurn).not.toHaveBeenCalled();
    expect((input as HTMLTextAreaElement).value).toBe("上海酒店，币种 sgd");
  });

  it("also honours the legacy 229 an older engine sends mid-composition", () => {
    const api = createApi();
    renderChat(api);
    const input = screen.getByRole("textbox", { name: "Message Wanderly Agent" });
    fireEvent.change(input, { target: { value: "币种 sgd" } });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });

    expect(api.submitConversationTurn).not.toHaveBeenCalled();
  });

  it("still sends once the composition is finished", async () => {
    const api = createApi();
    renderChat(api);
    const input = screen.getByRole("textbox", { name: "Message Wanderly Agent" });
    fireEvent.change(input, { target: { value: "上海酒店，币种 SGD" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(api.submitConversationTurn).toHaveBeenCalled());
  });
});

/**
 * DRAFT → Shared handoff CTA render conditions.
 *
 * Spec: the section must always render for DRAFT trips so the creator
 * sees whether the brief is ready, *and* must list which slot is empty
 * when it isn't. The CTA button must only be enabled when the brief is
 * complete; natural language typed into the chat box must NOT trigger
 * any activate call.
 */
describe("DRAFT → Shared handoff CTA", () => {
  function draftTrip(overrides: Partial<{
    status: "DRAFT";
    departureCities: string[];
    destinationCandidates: string[];
    travelDateStart: string | null;
    travelDateEnd: string | null;
    travelDays: number | null;
  }> = {}) {
    return {
      trip: {
        id: TRIP_ID,
        name: "Tokyo",
        createdBy: OWNER_ID,
        status: "DRAFT" as const,
        departureCities: [],
        destinationCandidates: ["Tokyo"],
        travelDateStart: null,
        travelDateEnd: null,
        travelDays: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        ...overrides,
      },
      callerRole: "CREATOR",
      members: [],
    };
  }

  it("does not render a planning CTA when the departure city is missing", async () => {
    const api = createApi({
      getTrip: vi.fn().mockResolvedValue(draftTrip({
        departureCities: [],
        destinationCandidates: ["Tokyo"],
        travelDateStart: "2026-09-10",
        travelDateEnd: "2026-09-15",
      })),
      activateTrip: vi.fn(),
    });
    renderChat(api, { tripId: TRIP_ID, surface: "TRIP_WORKSPACE" });

    await waitFor(() => expect(api.getTrip).toHaveBeenCalledWith(TRIP_ID));
    expect(screen.queryByText(/Trip details aren't complete yet/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start planning" })).not.toBeInTheDocument();
  });

  it("does not render a planning CTA when travel dates are missing", async () => {
    const api = createApi({
      getTrip: vi.fn().mockResolvedValue(draftTrip({
        departureCities: ["Shanghai"],
        destinationCandidates: ["Tokyo"],
        travelDateStart: null,
        travelDateEnd: null,
        travelDays: null,
      })),
      activateTrip: vi.fn(),
    });
    renderChat(api, { tripId: TRIP_ID, surface: "TRIP_WORKSPACE" });

    await waitFor(() => expect(api.getTrip).toHaveBeenCalledWith(TRIP_ID));
    expect(screen.queryByText(/Trip details aren't complete yet/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start planning" })).not.toBeInTheDocument();
  });

  it("renders the ready CTA and only fires activateTrip on explicit click", async () => {
    const api = createApi({
      getTrip: vi.fn().mockResolvedValue(draftTrip({
        departureCities: ["Shanghai"],
        destinationCandidates: ["Tokyo"],
        travelDateStart: "2026-09-10",
        travelDateEnd: "2026-09-15",
      })),
      activateTrip: vi.fn().mockResolvedValue({
        trip: draftTrip().trip,
        planningRun: { runId: RUN_ID, status: "RUNNING" },
      }),
    });
    renderChat(api, { tripId: TRIP_ID, surface: "TRIP_WORKSPACE" });

    const heading = await screen.findByText(/Trip details are ready/i);
    expect(heading).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Start planning" });
    expect(button).not.toBeDisabled();

    // Typing natural-language confirmation must NOT auto-activate.
    const input = screen.getByRole("textbox", { name: "Message Wanderly Agent" });
    fireEvent.change(input, { target: { value: "好的，开始吧" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.submitConversationTurn).toHaveBeenCalled());
    expect(api.activateTrip).not.toHaveBeenCalled();

    // Clicking the CTA is the only path to activation.
    fireEvent.click(button);
    await waitFor(() => expect(api.activateTrip).toHaveBeenCalledTimes(1));
  });
});
