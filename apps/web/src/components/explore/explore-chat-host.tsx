"use client";

import { useCallback, useMemo } from "react";
import { useLocale } from "next-intl";

import { TravelAgentChat, type ChatThreadStatus } from "./travel-agent-chat";
import { useExplorationSession } from "@/lib/exploration/exploration-session-provider";

type ExploreChatHostProps = {
  open?: boolean;
  onOpen?: () => void;
  onDismiss?: () => void;
  selectedPlace?: Parameters<typeof TravelAgentChat>[0]["selectedPlace"];
  onConversationText?: (text: string) => void;
};

export function ExploreChatHost({
  open = false,
  onOpen = () => {},
  onDismiss = () => {},
  selectedPlace,
  onConversationText,
}: ExploreChatHostProps) {
  const { session, startIfNeeded, reset } = useExplorationSession();
  const locale = useLocale() === "zh" ? "zh" : "en";

  const effectiveThreadId = session.threadId;
  const threadStatus: ChatThreadStatus = useMemo(() => {
    if (session.status === "error") return "error";
    if (session.status === "ready" && session.threadId) return "ready";
    return "preparing";
  }, [session]);

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
        onRetryThread={retryProvisioning}
        onThreadInvalidated={handleInvalidated}
        onEnsureThreadForFirstSend={ensureThread}
        onStartNewExploration={reset}
        tripId={session.tripId}
        titleLocale={locale}
        {...(selectedPlace !== undefined ? { selectedPlace } : {})}
        {...(onConversationText ? { onConversationText } : {})}
      />
    </div>
  );
}
