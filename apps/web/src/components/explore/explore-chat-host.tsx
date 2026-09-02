"use client";

import { useCallback, useMemo } from "react";
import { useLocale } from "next-intl";

import { TravelAgentChat, type ChatThreadStatus } from "./travel-agent-chat";
import { useExplorationSession } from "@/lib/exploration/exploration-session-provider";
import { useTripThreads } from "@/lib/query/hooks";

export type TripConversationHandoff = {
  tripId: string;
  threadId: string;
};

type ExploreChatHostProps = {
  open?: boolean;
  onOpen?: () => void;
  onDismiss?: () => void;
  selectedPlace?: Parameters<typeof TravelAgentChat>[0]["selectedPlace"];
  onConversationText?: (text: string) => void;
  /** A server-owned private thread explicitly handed off by a Trip route. */
  tripConversationHandoff?: TripConversationHandoff | null;
};

export function ExploreChatHost({
  open = false,
  onOpen = () => {},
  onDismiss = () => {},
  selectedPlace,
  onConversationText,
  tripConversationHandoff = null,
}: ExploreChatHostProps) {
  const { session, startIfNeeded, reset } = useExplorationSession();
  const handoffThreads = useTripThreads(tripConversationHandoff?.tripId ?? null);
  const locale = useLocale() === "zh" ? "zh" : "en";

  // URL values are only a handoff hint, never authority. Before showing a
  // conversation or allowing another turn, the server-authorized thread list
  // must prove that this member owns the requested thread within that Trip.
  const handoffThreadIsOwned = Boolean(
    tripConversationHandoff
    && handoffThreads.data?.threads.some((thread) => thread.id === tripConversationHandoff.threadId),
  );
  const effectiveThreadId = tripConversationHandoff
    ? (handoffThreadIsOwned ? tripConversationHandoff.threadId : null)
    : session.threadId;
  const effectiveTripId = tripConversationHandoff
    ? (handoffThreadIsOwned ? tripConversationHandoff.tripId : null)
    : session.tripId;
  const threadStatus: ChatThreadStatus = useMemo(() => {
    if (tripConversationHandoff) {
      if (handoffThreads.isPending) return "preparing";
      return handoffThreadIsOwned ? "ready" : "error";
    }
    if (session.status === "error") return "error";
    if (session.status === "ready" && session.threadId) return "ready";
    // Only `starting` is real work. A session that has never been started is
    // idle: the exploration thread is provisioned by the first Send, so
    // reporting "preparing" before then promises work nobody has begun.
    if (session.status === "starting") return "preparing";
    return "idle";
  }, [handoffThreadIsOwned, handoffThreads.isPending, session, tripConversationHandoff]);

  const ensureThread = useCallback(async () => {
    const result = await startIfNeeded();
    return { threadId: result.threadId };
  }, [startIfNeeded]);

  const retryProvisioning = useCallback(() => {
    // Keep the original request id. The server may have completed the first
    // request after the browser observed a transport failure.
    void startIfNeeded();
  }, [startIfNeeded]);

  const handleInvalidated = useCallback(() => {
    // The server reported the thread id is gone. Drop the in-memory
    // session so the next Send provisions a fresh draft.
    reset();
  }, [reset]);

  return (
    <div data-testid="explore-chat-host" className="contents">
      <TravelAgentChat
        open={open}
        onOpen={onOpen}
        onDismiss={onDismiss}
        threadId={effectiveThreadId}
        threadStatus={threadStatus}
        onRetryThread={tripConversationHandoff ? undefined : retryProvisioning}
        onThreadInvalidated={handleInvalidated}
        {...(tripConversationHandoff ? {} : { onEnsureThreadForFirstSend: ensureThread })}
        {...(tripConversationHandoff ? {} : { onStartNewExploration: reset })}
        tripId={effectiveTripId}
        titleLocale={locale}
        {...(selectedPlace !== undefined ? { selectedPlace } : {})}
        {...(onConversationText ? { onConversationText } : {})}
      />
    </div>
  );
}
