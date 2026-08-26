import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConversationPlace, ConversationTurnResponse } from "@/lib/api/contracts";
import { TravelApiError } from "@/lib/api/errors";
import type { TravelApi } from "@/lib/api";
import { renderWithIntl } from "@/test/render";
import { CHAT_THREAD_STORAGE_KEY, TravelAgentChat } from "./travel-agent-chat";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const REPLACEMENT_THREAD_ID = "66666666-6666-4666-8666-666666666666";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const USER_MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const ASSISTANT_MESSAGE_ID = "55555555-5555-4555-8555-555555555555";
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
    submitConversationTurn: vi.fn().mockImplementation(async (_threadId, input) => turn(input.question)),
    ...overrides,
  };
}

describe("TravelAgentChat API flow", () => {
  it("creates one thread for the first turn and renders USER plus ASSISTANT", async () => {
    const api = createApi();
    renderChat(api);

    fireEvent.change(screen.getByRole("textbox", { name: "Ask Wanderly" }), { target: { value: "Tell me about Tokyo" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("A calm, general destination answer.")).toBeInTheDocument();
    expect(screen.getByText("Tell me about Tokyo")).toBeInTheDocument();
    expect(api.createThread).toHaveBeenCalledTimes(1);
    expect(api.submitConversationTurn).toHaveBeenCalledWith(THREAD_ID, {
      requestId: REQUEST_ID,
      question: "Tell me about Tokyo",
    });
    expect(localStorage.getItem(CHAT_THREAD_STORAGE_KEY)).toBe(THREAD_ID);
  });

  it("reuses the same thread for the second turn", async () => {
    const api = createApi();
    renderChat(api);

    await submitFromCapsule("First question");
    await screen.findByText("A calm, general destination answer.");
    fireEvent.change(screen.getByRole("textbox", { name: "Message Wanderly Agent" }), { target: { value: "Second question" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(api.submitConversationTurn).toHaveBeenCalledTimes(2));
    expect(api.createThread).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.submitConversationTurn).mock.calls.map(([id]) => id)).toEqual([THREAD_ID, THREAD_ID]);
  });

  it("sends the selected place DTO without browser-controlled role or sender identity", async () => {
    const api = createApi();
    renderChat(api, { selectedPlace: { place: TOKYO, context: "Japan" } });

    await submitFromCapsule("What makes it interesting?");
    await waitFor(() => expect(api.submitConversationTurn).toHaveBeenCalledOnce());
    const [, body] = vi.mocked(api.submitConversationTurn).mock.calls[0];

    expect(body).toEqual({ requestId: REQUEST_ID, question: "What makes it interesting?", place: TOKYO });
    expect(body).not.toHaveProperty("role");
    expect(body).not.toHaveProperty("senderUserId");
  });

  it("blocks duplicate submission while a turn is pending", async () => {
    const pending = deferred<ConversationTurnResponse>();
    const api = createApi({ submitConversationTurn: vi.fn().mockReturnValue(pending.promise) });
    renderChat(api);

    await submitFromCapsule("Only once");
    await waitFor(() => expect(api.submitConversationTurn).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(api.submitConversationTurn).toHaveBeenCalledOnce();

    pending.resolve(turn("Only once"));
    await screen.findByText("A calm, general destination answer.");
  });

  it("renders SAFE_REFUSAL as an assistant message with a verification indicator", async () => {
    const api = createApi({
      submitConversationTurn: vi.fn().mockResolvedValue(turn("What is the live fare?", "SAFE_REFUSAL")),
    });
    renderChat(api);

    await submitFromCapsule("What is the live fare?");
    expect(await screen.findByText("Verification required")).toBeInTheDocument();
    expect(screen.getByText("I cannot verify that live operational fact.")).toBeInTheDocument();
  });

  it.each([502, 504])("shows a retryable error for provider status %s and reuses requestId", async (statusCode) => {
    const submit = vi.fn()
      .mockRejectedValueOnce(new TravelApiError("unavailable", statusCode, "Upstream", null))
      .mockResolvedValueOnce(turn("Retry me"));
    const api = createApi({ submitConversationTurn: submit });
    renderChat(api);

    await submitFromCapsule("Retry me");
    expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[0][1].requestId).toBe(REQUEST_ID);
    expect(submit.mock.calls[1][1].requestId).toBe(REQUEST_ID);
    expect(await screen.findByText("A calm, general destination answer.")).toBeInTheDocument();
  });

  it("restores owner conversation history using the stored server thread pointer", async () => {
    localStorage.setItem(CHAT_THREAD_STORAGE_KEY, THREAD_ID);
    const api = createApi({
      getOwnerConversation: vi.fn().mockResolvedValue({
        thread: thread(),
        messages: [
          { id: USER_MESSAGE_ID, role: "USER", content: "Earlier question", createdAt: CREATED_AT },
          { id: ASSISTANT_MESSAGE_ID, role: "ASSISTANT", content: "Earlier answer", createdAt: "2026-08-25T10:00:01.000Z" },
        ],
      }),
    });
    renderChat(api, { initiallyOpen: true });

    expect(await screen.findByText("Earlier question")).toBeInTheDocument();
    expect(screen.getByText("Earlier answer")).toBeInTheDocument();
    expect(api.getOwnerConversation).toHaveBeenCalledWith(THREAD_ID);
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
      .mockResolvedValueOnce(turnForThread(REPLACEMENT_THREAD_ID, "Thread B question", "Thread B answer"));
    const api = createApi({
      createThread: vi.fn().mockResolvedValue({ id: REPLACEMENT_THREAD_ID, message: "Thread created" }),
      getOwnerConversation: vi.fn().mockResolvedValue({
        thread: thread(),
        messages: [
          { id: USER_MESSAGE_ID, role: "USER", content: "Thread A question", createdAt: CREATED_AT },
          { id: ASSISTANT_MESSAGE_ID, role: "ASSISTANT", content: "Thread A answer", createdAt: "2026-08-25T10:00:01.000Z" },
        ],
      }),
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

    expect(await screen.findByText("Thread B answer")).toBeInTheDocument();
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

    expect(await screen.findByText("A calm, general destination answer.")).toBeInTheDocument();
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

    await screen.findByText("A calm, general destination answer.");

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

    expect(await screen.findByText("A calm, general destination answer.")).toBeInTheDocument();
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

function turn(question: string, responseMode: "MODEL" | "SAFE_REFUSAL" = "MODEL"): ConversationTurnResponse {
  return {
    threadId: THREAD_ID,
    userMessage: { id: USER_MESSAGE_ID, role: "USER", content: question, createdAt: CREATED_AT },
    assistantMessage: {
      id: ASSISTANT_MESSAGE_ID,
      role: "ASSISTANT",
      content: responseMode === "SAFE_REFUSAL" ? "I cannot verify that live operational fact." : "A calm, general destination answer.",
      createdAt: "2026-08-25T10:00:01.000Z",
    },
    responseMode,
  };
}

function turnForThread(threadId: string, question: string, answer: string): ConversationTurnResponse {
  return {
    threadId,
    userMessage: { id: "77777777-7777-4777-8777-777777777777", role: "USER", content: question, createdAt: "2026-08-25T10:01:00.000Z" },
    assistantMessage: { id: "88888888-8888-4888-8888-888888888888", role: "ASSISTANT", content: answer, createdAt: "2026-08-25T10:01:01.000Z" },
    responseMode: "MODEL",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
