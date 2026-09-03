import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRun, ConversationPlace, ConversationTurnAcceptedResponse } from "@/lib/api/contracts";
import { TravelApiError } from "@/lib/api/errors";
import type { TravelApi } from "@/lib/api";
import { renderWithIntl } from "@/test/render";
import { CHAT_ACTIVE_RUN_STORAGE_KEY, TravelAgentChat } from "./travel-agent-chat";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const USER_MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const ASSISTANT_MESSAGE_ID = "77777777-7777-4777-8777-777777777777";
const TRIP_ID = "99999999-9999-4999-8999-999999999999";
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
    getMyProfile: vi.fn(),
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
    ...overrides,
  };
}

describe("TravelAgentChat durable streaming flow", () => {
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

  // The collapsed composer is the open panel's composer one state earlier, and
  // both float in the cosmic scene, so they take the same deep-space material.
  // Giving this one the paper card made opening the chat read as a jump
  // between two different products.
  it("uses the cosmic surface for the collapsed composer", async () => {
    renderChat(createApi(), { initiallyOpen: false });

    const collapsedComposer = screen.getByRole("form", { name: "Start a conversation with Wanderly Agent" });
    expect(collapsedComposer).toHaveClass("wanderly-cosmos-surface", "wanderly-r-lg", "wanderly-shadow");
    expect(collapsedComposer).not.toHaveClass("bg-card", "wanderly-edge");
  });

  // The open panel floats inside `.wanderly-cosmos`, where the design system
  // rules out a white card: it takes the deep-space panel, and everything it
  // contains takes the deep-space surface rather than `bg-card` on paper.
  it("uses the cosmic surfaces for the open conversation", async () => {
    renderChat(createApi(), { initiallyOpen: false });

    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));

    const dialog = await screen.findByRole("dialog", { name: "Wanderly Agent conversation" });
    expect(dialog).toHaveClass("wanderly-cosmos-chat", "wanderly-cosmos-panel", "wanderly-r-lg");
    expect(dialog).not.toHaveClass("bg-sidebar", "wanderly-edge");

    const composerBox = screen.getByRole("textbox", { name: "Message Wanderly Agent" }).parentElement;
    expect(composerBox).toHaveClass("wanderly-cosmos-surface", "wanderly-r-md", "wanderly-shadow-sm");
    expect(composerBox).not.toHaveClass("bg-card");
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
    localStorage.setItem(CHAT_ACTIVE_RUN_STORAGE_KEY, RUN_ID);
    const api = createApi({
      getAgentRun: vi.fn().mockRejectedValue(new TravelApiError("missing", 404, "Not Found", null)),
    });
    renderChat(api, { initiallyOpen: true });

    await waitFor(() => expect(localStorage.getItem(CHAT_ACTIVE_RUN_STORAGE_KEY)).toBeNull());
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Wanderly Agent" })).not.toBeDisabled();
  });

  it("restores a running durable run after mount without submitting another turn", async () => {
    localStorage.setItem(CHAT_ACTIVE_RUN_STORAGE_KEY, RUN_ID);
    const api = createApi();

    renderChat(api);

    await waitFor(() => expect(api.subscribeAgentRun).toHaveBeenCalledWith(RUN_ID, expect.any(AbortSignal), expect.any(Function)));
    expect(api.submitConversationTurn).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("clears a completed durable-run pointer after restoring persisted history", async () => {
    localStorage.setItem(CHAT_ACTIVE_RUN_STORAGE_KEY, RUN_ID);
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
    await waitFor(() => expect(localStorage.getItem(CHAT_ACTIVE_RUN_STORAGE_KEY)).toBeNull());
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
      { fieldKey: "trip_pace", category: "PREFERENCE" as const, value: "relaxed", inherited: true, options: ["relaxed", "balanced", "packed"], multiValue: false },
      { fieldKey: "interests", category: "PREFERENCE" as const, value: ["ramen"], inherited: true, options: null, multiValue: true },
    ],
  };

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
      fields: [{ ...card.fields[1], value: null, multiValue: true }],
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
});

describe("highlighting something worth remembering", () => {
  /**
   * jsdom's Selection cannot be produced by a drag, so this stands in for what
   * the browser hands the handler afterwards: some text and where it sits.
   */
  function selectInside(text: string | null) {
    vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => text ?? "",
      rangeCount: text ? 1 : 0,
      getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 100, top: 200, width: 40 }) }),
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
    selectInside("町屋");
    fireEvent.mouseUp(bubble);

    fireEvent.click(await screen.findByTestId("remember-highlight"));

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
    selectInside("很长的一段");
    fireEvent.mouseUp(bubble);
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
    fireEvent.mouseUp(bubble);

    expect(screen.queryByTestId("remember-highlight")).not.toBeInTheDocument();
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
