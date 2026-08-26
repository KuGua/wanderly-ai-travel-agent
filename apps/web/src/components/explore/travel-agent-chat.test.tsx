import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRun, ConversationPlace, ConversationTurnAcceptedResponse } from "@/lib/api/contracts";
import { TravelApiError } from "@/lib/api/errors";
import type { TravelApi } from "@/lib/api";
import { renderWithIntl } from "@/test/render";
import { CHAT_THREAD_STORAGE_KEY, TravelAgentChat } from "./travel-agent-chat";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const USER_MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const REPLACEMENT_THREAD_ID = "66666666-6666-4666-8666-666666666666";
const ASSISTANT_MESSAGE_ID = "77777777-7777-4777-8777-777777777777";
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
  selectedPlace = null,
  initiallyOpen = false,
  autoAskRequest = null,
  onAutoAskConsumed,
}: {
  selectedPlace?: { place: ConversationPlace; context: string } | null;
  initiallyOpen?: boolean;
  autoAskRequest?: { nonce: string; place: ConversationPlace; context: string } | null;
  onAutoAskConsumed?: (nonce: string) => void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <TravelAgentChat
      open={open}
      onOpen={() => setOpen(true)}
      onDismiss={() => setOpen(false)}
      selectedPlace={selectedPlace}
      autoAskRequest={autoAskRequest}
      onAutoAskConsumed={onAutoAskConsumed}
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
    getLocationReference: vi.fn(),
    getThreads: vi.fn().mockResolvedValue({ threads: [] }),
    createThread: vi.fn().mockResolvedValue({ id: THREAD_ID, message: "Thread created" }),
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
    ...overrides,
  };
}

describe("TravelAgentChat durable streaming flow", () => {
  it("accepts the USER message first, renders approved deltas, and blocks another active turn", async () => {
    const api = createApi();
    renderChat(api);

    await submitFromCapsule("Tell me about Tokyo");

    expect(await screen.findByText("A streamed answer.")).toBeInTheDocument();
    expect(screen.getByText("Tell me about Tokyo")).toBeInTheDocument();
    expect(api.createThread).toHaveBeenCalledOnce();
    expect(api.submitConversationTurn).toHaveBeenCalledWith(THREAD_ID, {
      requestId: REQUEST_ID,
      question: "Tell me about Tokyo",
    });
    expect(api.subscribeAgentRun).toHaveBeenCalledWith(RUN_ID, expect.any(AbortSignal), expect.any(Function));
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(localStorage.getItem(CHAT_THREAD_STORAGE_KEY)).toBe(THREAD_ID);
  });

  it("sends selected place context without browser-controlled authority fields", async () => {
    const api = createApi();
    renderChat(api, { selectedPlace: { place: TOKYO, context: "Japan" } });

    await submitFromCapsule("What makes it interesting?");
    await waitFor(() => expect(api.submitConversationTurn).toHaveBeenCalledOnce());
    const [, body] = vi.mocked(api.submitConversationTurn).mock.calls[0];

    expect(body).toEqual({ requestId: REQUEST_ID, question: "What makes it interesting?", place: TOKYO });
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

  it("restores deterministic message sequence from the stored owner thread", async () => {
    localStorage.setItem(CHAT_THREAD_STORAGE_KEY, THREAD_ID);
    const api = createApi({
      getOwnerConversation: vi.fn().mockResolvedValue({
        thread: thread(),
        messages: [
          { id: USER_MESSAGE_ID, role: "USER", content: "Earlier question", sequence: 1, createdAt: CREATED_AT },
          {
            id: "66666666-6666-4666-8666-666666666666",
            role: "ASSISTANT",
            content: "Earlier answer",
            sequence: 2,
            createdAt: CREATED_AT,
          },
        ],
      }),
    });
    renderChat(api, { initiallyOpen: true });

    expect(await screen.findByText("Earlier question")).toBeInTheDocument();
    expect(screen.getByText("Earlier answer")).toBeInTheDocument();
  });

  it("clears a stale local pointer when the server returns 404", async () => {
    localStorage.setItem(CHAT_THREAD_STORAGE_KEY, THREAD_ID);
    const api = createApi({
      getOwnerConversation: vi.fn().mockRejectedValue(new TravelApiError("missing", 404, "Not Found", null)),
    });
    renderChat(api, { initiallyOpen: true });

    await waitFor(() => expect(localStorage.getItem(CHAT_THREAD_STORAGE_KEY)).toBeNull());
    expect(screen.getByText("Let's plan somewhere memorable.")).toBeInTheDocument();
  });

  it("does not carry Thread A messages into replacement Thread B after Thread A returns 404", async () => {
    localStorage.setItem(CHAT_THREAD_STORAGE_KEY, THREAD_ID);
    const submit = vi.fn()
      .mockRejectedValueOnce(new TravelApiError("missing", 404, "Not Found", null))
      .mockImplementationOnce(async (_threadId, input) => acceptedForThread(REPLACEMENT_THREAD_ID, input.question));
    const api = createApi({
      createThread: vi.fn().mockResolvedValue({ id: REPLACEMENT_THREAD_ID, message: "Thread created" }),
      // Thread B is a genuinely different server thread, so it must come back
      // empty rather than replaying Thread A's history.
      getOwnerConversation: vi.fn().mockImplementation(async (id: string) => (
        id === THREAD_ID
          ? {
              thread: thread(),
              messages: [
                { id: USER_MESSAGE_ID, role: "USER", content: "Thread A question", sequence: 1, createdAt: CREATED_AT },
                { id: ASSISTANT_MESSAGE_ID, role: "ASSISTANT", content: "Thread A answer", sequence: 2, createdAt: "2026-08-25T10:00:01.000Z" },
              ],
            }
          : { thread: { ...thread(), id }, messages: [] }
      )),
      submitConversationTurn: submit,
    });
    renderChat(api, { initiallyOpen: true });

    expect(await screen.findByText("Thread A answer")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Message Wanderly Agent" }), { target: { value: "Thread A follow-up" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(localStorage.getItem(CHAT_THREAD_STORAGE_KEY)).toBeNull());
    expect(screen.queryByText("Thread A question")).not.toBeInTheDocument();
    expect(screen.queryByText("Thread A answer")).not.toBeInTheDocument();
    expect(screen.queryByText("Thread A follow-up")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Message Wanderly Agent" }), { target: { value: "Thread B question" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("A streamed answer.")).toBeInTheDocument();
    expect(screen.getByText("Thread B question")).toBeInTheDocument();
    expect(screen.queryByText("Thread A question")).not.toBeInTheDocument();
    expect(screen.queryByText("Thread A answer")).not.toBeInTheDocument();
    expect(api.createThread).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenNthCalledWith(2, REPLACEMENT_THREAD_ID, expect.objectContaining({ question: "Thread B question" }));
    expect(localStorage.getItem(CHAT_THREAD_STORAGE_KEY)).toBe(REPLACEMENT_THREAD_ID);
  });

  it("auto-sends a 'Tell me about …' turn when autoAskRequest is provided", async () => {
    const onConsumed = vi.fn();
    const api = createApi();
    const request = { nonce: "n1", place: TOKYO, context: "Japan" };
    renderChat(api, {
      initiallyOpen: true,
      selectedPlace: { place: TOKYO, context: "Japan" },
      autoAskRequest: request,
      onAutoAskConsumed: onConsumed,
    });

    expect(await screen.findByText("A streamed answer.")).toBeInTheDocument();
    expect(screen.getByText("Tell me about Tokyo")).toBeInTheDocument();
    expect(api.createThread).toHaveBeenCalledTimes(1);
    expect(api.createThread).toHaveBeenCalledWith({ title: "Explore · Tokyo" });
    expect(api.submitConversationTurn).toHaveBeenCalledTimes(1);
    expect(api.submitConversationTurn).toHaveBeenCalledWith(THREAD_ID, {
      requestId: REQUEST_ID,
      question: "Tell me about Tokyo",
      place: TOKYO,
    });
    expect(localStorage.getItem(CHAT_THREAD_STORAGE_KEY)).toBe(THREAD_ID);
    await waitFor(() => expect(onConsumed).toHaveBeenCalledWith("n1"));
  });

  it("does not double-fire auto-ask when the parent re-renders while holding the same nonce", async () => {
    const onConsumed = vi.fn();
    const api = createApi();
    const request = { nonce: "n1", place: TOKYO, context: "Japan" };

    function TriggerRerender() {
      const [, force] = useState(0);
      useEffect(() => {
        // Schedule three extra re-renders of TravelAgentChat AFTER the initial
        // effect has had a chance to run, all keeping the same nonce.
        const timers = [0, 5, 25].map((delay) => window.setTimeout(() => force((value) => value + 1), delay));
        return () => timers.forEach((timer) => window.clearTimeout(timer));
      }, []);
      return null;
    }

    renderWithIntl(
      <>
        <ChatHarness
          initiallyOpen
          selectedPlace={{ place: TOKYO, context: "Japan" }}
          autoAskRequest={request}
          onAutoAskConsumed={onConsumed}
        />
        <TriggerRerender />
      </>,
      { api },
    );

    await screen.findByText("A streamed answer.");

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(api.submitConversationTurn).toHaveBeenCalledTimes(1);
    expect(onConsumed).toHaveBeenCalledTimes(1);
    expect(onConsumed).toHaveBeenCalledWith("n1");
  });

  it("appends auto-ask to an existing thread identified by localStorage pointer", async () => {
    localStorage.setItem(CHAT_THREAD_STORAGE_KEY, THREAD_ID);
    const api = createApi();
    const request = { nonce: "n1", place: TOKYO, context: "Japan" };
    renderChat(api, {
      initiallyOpen: true,
      selectedPlace: { place: TOKYO, context: "Japan" },
      autoAskRequest: request,
    });

    expect(await screen.findByText("A streamed answer.")).toBeInTheDocument();
    expect(api.createThread).not.toHaveBeenCalled();
    expect(api.submitConversationTurn).toHaveBeenCalledTimes(1);
    expect(api.submitConversationTurn).toHaveBeenCalledWith(THREAD_ID, {
      requestId: REQUEST_ID,
      question: "Tell me about Tokyo",
      place: TOKYO,
    });
  });

  it("does not submit auto-ask while the chat dialog is closed", async () => {
    const api = createApi();
    renderChat(api, {
      initiallyOpen: false,
      selectedPlace: { place: TOKYO, context: "Japan" },
      autoAskRequest: { nonce: "n1", place: TOKYO, context: "Japan" },
    });

    // Give the effect a chance to fire if it ever would.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.submitConversationTurn).not.toHaveBeenCalled();
    expect(api.createThread).not.toHaveBeenCalled();
  });
});

async function submitFromCapsule(question: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Ask Wanderly" }), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
}

function thread() {
  return {
    id: THREAD_ID,
    ownerUserId: OWNER_ID,
    tripId: null,
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
  };
}

function untilAborted(signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
