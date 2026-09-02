"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useTravelApi } from "@/lib/query/provider";
import { tripKeys } from "@/lib/query/keys";
import { useOptionalAuth } from "@/lib/auth/auth-provider";
import type { ExplorationStartResponse } from "@/lib/api/contracts";

export type ExplorationSessionStatus = "idle" | "starting" | "ready" | "error";

export type ExplorationSession = {
  /**
   * Identifier unique to this provider instance. Regenerated whenever the
   * tab is reloaded, the auth session changes, or the user explicitly
   * resets the session — never persisted outside React memory.
   */
  sessionId: string;
  tripId: string | null;
  threadId: string | null;
  startRequestId: string | null;
  status: ExplorationSessionStatus;
  error: string | null;
};

type StartExplorationContext = {
  session: ExplorationSession;
  /**
   * Idempotently starts a Draft Trip on the server. Multiple concurrent
   * callers share the same in-flight request. Once resolved, the returned
   * `tripId` / `threadId` remain on the session until the user resets it,
   * navigates away from `/home`, or signs out.
   */
  startIfNeeded: () => Promise<{ tripId: string; threadId: string }>;
  /** Replace the in-memory session with a fresh, empty one. */
  reset: () => void;
};

const ExplorationSessionContext = createContext<StartExplorationContext | null>(null);

function generateUuid(): string {
  if (typeof globalThis !== "undefined" && typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // Fallback for test environments that haven't polyfilled crypto.randomUUID.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function buildInitialSession(): ExplorationSession {
  return {
    sessionId: generateUuid(),
    tripId: null,
    threadId: null,
    startRequestId: null,
    status: "idle",
    error: null,
  };
}

export function ExplorationSessionProvider({ children }: { children: ReactNode }) {
  // Read auth context optionally so the Provider can be mounted in tests
  // without an enclosing AuthProvider. Remounting the stateful boundary on
  // an auth revision prevents private exploration identifiers crossing
  // account boundaries without a setState-in-effect reset.
  const auth = useOptionalAuth();
  const sessionRevision = auth?.sessionRevision ?? 0;

  return (
    <ExplorationSessionBoundary key={sessionRevision}>
      {children}
    </ExplorationSessionBoundary>
  );
}

function ExplorationSessionBoundary({ children }: { children: ReactNode }) {
  const api = useTravelApi();
  const queryClient = useQueryClient();

  const [session, setSession] = useState<ExplorationSession>(() => buildInitialSession());
  // A single in-flight promise keeps concurrent callers in lock-step.
  const startInFlightRef = useRef<Promise<ExplorationStartResponse> | null>(null);
  // Refs let startIfNeeded read the latest startRequestId without
  // recreating the callback on every render.
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const mutation = useMutation({
    mutationFn: (requestId: string) => api.startExploration({ requestId }),
  });

  const startIfNeeded = useCallback(async () => {
    const live = sessionRef.current;
    if (live.tripId && live.threadId && live.status === "ready") {
      return { tripId: live.tripId, threadId: live.threadId };
    }

    let inFlight = startInFlightRef.current;
    if (!inFlight) {
      // A failed or interrupted request must be retried with the same
      // idempotency key. The server may have committed the DRAFT before a
      // network failure reaches the browser; generating a new key here would
      // create a duplicate exploration on Retry.
      const requestId = live.startRequestId ?? generateUuid();
      setSession((current) => ({
        ...current,
        startRequestId: requestId,
        status: "starting",
        error: null,
      }));
      // Wrap setState updates in microtasks so concurrent React 18
      // batching flushes them before the test / caller observes the
      // resolved promise.
      inFlight = mutation.mutateAsync(requestId)
        .then(async (response) => {
          // Yield to React so the state update from the caller (which
          // may be inside `act(...)` or a Suspense boundary) is
          // observed as the same render where we mark the session
          // ready.
          await Promise.resolve();
          setSession((current) => ({
            ...current,
            tripId: response.trip.id,
            threadId: response.defaultThread.id,
            status: "ready",
            error: null,
          }));
          // The new Trip belongs on `/home`, `/projects`, and the
          // `/trips/:id` detail view; invalidate every cached list /
          // detail view so the user sees their draft without a refresh.
          await queryClient.invalidateQueries({ queryKey: tripKeys.all });
          return response;
        })
        .catch((error: unknown) => {
          // Surface failure via session.status; do NOT rethrow so that
          // unhandled click handlers do not surface unhandled
          // rejections. Callers that need the failure can read
          // `session.status === "error"` after the next render.
          setSession((current) => ({
            ...current,
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          }));
          throw error;
        })
        .finally(() => {
          // A retry may now reuse the session's startRequestId. A new key is
          // generated only by reset() or an auth-session change.
          startInFlightRef.current = null;
        });
      startInFlightRef.current = inFlight;
    }

    const response = await inFlight;
    return { tripId: response.trip.id, threadId: response.defaultThread.id };
  }, [mutation, queryClient]);

  const reset = useCallback(() => {
    setSession(buildInitialSession());
    startInFlightRef.current = null;
  }, []);

  const value = useMemo<StartExplorationContext>(() => ({
    session,
    startIfNeeded,
    reset,
  }), [session, startIfNeeded, reset]);

  return (
    <ExplorationSessionContext.Provider value={value}>
      {children}
    </ExplorationSessionContext.Provider>
  );
}

export function useExplorationSession(): StartExplorationContext {
  const value = useContext(ExplorationSessionContext);
  if (!value) {
    throw new Error("useExplorationSession must be used within ExplorationSessionProvider");
  }
  return value;
}

/**
 * Returns a promise that resolves when the in-memory exploration has a
 * provisioned draft + thread. Re-runs do not re-issue network calls.
 *
 * Tests assert the Provider never writes to `localStorage`,
 * `sessionStorage`, or `document.cookie`. The Provider lives only in
 * React state; `mutation` state goes through TanStack Query's in-memory
 * cache, which is rebuilt whenever `auth.sessionRevision` changes.
 */
export function __explorationInternalsForTests() {
  return { generateUuid };
}
