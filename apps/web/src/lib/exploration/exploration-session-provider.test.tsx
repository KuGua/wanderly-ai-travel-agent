import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NextIntlClientProvider } from "next-intl";
import { QueryProvider } from "@/lib/query/provider";

import enMessages from "../../../messages/en.json";
import type { ExplorationStartResponse, TravelApi } from "@/lib/api";
import {
  ExplorationSessionProvider,
  useExplorationSession,
} from "./exploration-session-provider";

const messages = { en: enMessages } as const;
const TRIP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THREAD_ID = "11111111-1111-4111-8111-111111111111";

function makeStartResponse(): ExplorationStartResponse {
  return {
    trip: {
      id: TRIP_ID,
      name: "Untitled exploration",
      status: "DRAFT",
      departureCities: [],
      destinationCandidates: [],
      travelDateStart: null,
      travelDateEnd: null,
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    },
    defaultThread: {
      id: THREAD_ID,
      tripId: TRIP_ID,
      scope: "TRIP",
      isDefault: true,
    },
  };
}

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
    subscribeAgentRun: vi.fn(),
    startExploration: vi.fn().mockResolvedValue(makeStartResponse()),
    activateTrip: vi.fn(),
    updateTripTitle: vi.fn(),
    saveTripSearchPreferences: vi.fn(),
    startPlanning: vi.fn(),
    getLatestPlanningRun: vi.fn().mockResolvedValue({ run: null }),
    getLatestPlan: vi.fn(),
    ...overrides,
  };
}

function renderProvider(api: TravelApi) {
  const Probe = () => {
    const { session, startIfNeeded, reset } = useExplorationSession();
    return (
      <div>
        <span data-testid="trip-id">{session.tripId ?? "null"}</span>
        <span data-testid="thread-id">{session.threadId ?? "null"}</span>
        <span data-testid="session-id">{session.sessionId}</span>
        <span data-testid="status">{session.status}</span>
        <button type="button" onClick={() => void startIfNeeded()} data-testid="start">
          start
        </button>
        <button type="button" onClick={reset} data-testid="reset">
          reset
        </button>
      </div>
    );
  };
  return render(
    <NextIntlClientProvider locale="en" messages={messages.en}>
      <QueryProvider configuration={{ api }}>
        <ExplorationSessionProvider>
          <Probe />
        </ExplorationSessionProvider>
      </QueryProvider>
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // Verify no Provider writes touched persistent storage.
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
});

describe("ExplorationSessionProvider", () => {
  it("starts idle with no tripId or threadId, and never persists to storage", async () => {
    const api = makeApi();
    renderProvider(api);
    expect(screen.getByTestId("status")).toHaveTextContent("idle");
    expect(screen.getByTestId("trip-id")).toHaveTextContent("null");
    expect(screen.getByTestId("thread-id")).toHaveTextContent("null");
  });

  it("startIfNeeded calls startExploration and stores tripId + threadId", async () => {
    const api = makeApi();
    renderProvider(api);
    fireEvent.click(screen.getByTestId("start"));
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("ready");
    });
    expect(api.startExploration).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("trip-id")).toHaveTextContent(TRIP_ID);
    expect(screen.getByTestId("thread-id")).toHaveTextContent(THREAD_ID);
  });

  it("concurrent startIfNeeded calls share the same in-flight request", async () => {
    const api = makeApi();
    let resolveStart: ((value: ExplorationStartResponse) => void) | null = null;
    api.startExploration = vi.fn().mockImplementation(() =>
      new Promise<ExplorationStartResponse>((resolve) => {
        resolveStart = resolve;
      }),
    );
    renderProvider(api);
    fireEvent.click(screen.getByTestId("start"));
    fireEvent.click(screen.getByTestId("start"));
    fireEvent.click(screen.getByTestId("start"));
    // Yield to React/TanStack Query so the mutation is dispatched and
    // the startExploration mock is actually invoked.
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.startExploration).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveStart?.(makeStartResponse());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("ready");
    });
  });

  it("reset clears tripId and threadId", async () => {
    const api = makeApi();
    renderProvider(api);
    fireEvent.click(screen.getByTestId("start"));
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("ready");
    });
    fireEvent.click(screen.getByTestId("reset"));
    expect(screen.getByTestId("status")).toHaveTextContent("idle");
    expect(screen.getByTestId("trip-id")).toHaveTextContent("null");
    expect(screen.getByTestId("thread-id")).toHaveTextContent("null");
  });

  it("startExploration failure surfaces status=error", async () => {
    const api = makeApi({
      startExploration: vi.fn().mockRejectedValue(new Error("boom")),
    });
    renderProvider(api);
    fireEvent.click(screen.getByTestId("start"));
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("error");
    });
    expect(screen.getByTestId("trip-id")).toHaveTextContent("null");
  });

  it("retries a failed start with the same idempotency requestId", async () => {
    const startExploration = vi.fn()
      .mockRejectedValueOnce(new Error("transport failure"))
      .mockResolvedValueOnce(makeStartResponse());
    const api = makeApi({ startExploration });
    renderProvider(api);

    fireEvent.click(screen.getByTestId("start"));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("error"));
    fireEvent.click(screen.getByTestId("start"));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));

    expect(startExploration).toHaveBeenCalledTimes(2);
    expect(startExploration.mock.calls[1][0].requestId).toBe(startExploration.mock.calls[0][0].requestId);
  });

  it("regenerates a fresh sessionId on remount (new tab semantics)", () => {
    const api = makeApi();
    const { unmount } = renderProvider(api);
    const firstSessionId = screen.getByTestId("session-id").textContent ?? "";
    expect(firstSessionId).not.toBe("");
    unmount();
    renderProvider(api);
    const secondSessionId = screen.getByTestId("session-id").textContent ?? "";
    expect(secondSessionId).not.toBe(firstSessionId);
  });
});
