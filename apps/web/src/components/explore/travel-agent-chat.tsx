"use client";

import { ArrowUp, LoaderCircle, MessageCircle, RotateCw, Sparkles, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { AgentStreamEvent, ConversationMessage, ConversationPlace, ConversationTurnRequest } from "@/lib/api/contracts";
import { TravelApiError } from "@/lib/api/errors";
import { useAgentRun, useCancelAgentRun, useOwnerConversation, useSubmitConversationTurn } from "@/lib/query/hooks";
import { useTravelApi } from "@/lib/query/provider";

export const CHAT_ACTIVE_RUN_STORAGE_KEY = "wanderly.privateChatActiveRunId.v1";
type PendingTurn = ConversationTurnRequest;
type StreamState = {
  attempt: number;
  nextSequence: number;
  pending: Record<number, string>;
  text: string;
  phase: string | null;
};

export type ChatThreadStatus = "preparing" | "ready" | "error";

type TravelAgentChatProps = {
  open?: boolean;
  onOpen?: () => void;
  onDismiss?: () => void;
  /**
   * Controlled threadId. Required: callers must always provision the
   * thread via a Trip-scoped endpoint (e.g. `POST /trips/:tripId/threads/default`)
   * so the server-derived trip binding is honored across refreshes.
   * `null` means "thread is being provisioned; do not allow sending".
   */
  threadId: string | null;
  threadStatus?: ChatThreadStatus;
  onRetryThread?: () => void;
  /**
   * Notifies the parent when the server reports the thread is missing
   * (404) so it can drop the stale id from URL / state and re-route to
   * the workspace default.
   */
  onThreadInvalidated?: () => void;
  /**
   * Optional one-shot provisioner invoked once before the very first
   * Send when `threadId` is still null. The exploration page uses this
   * to call `POST /explorations/start` and surface the resulting
   * `threadId` from the in-memory session. Trip-scoped chat hosts can
   * leave it unset; their `threadId` arrives via `useTripThreads` /
   * `getOrCreateDefaultTripThread`.
   */
  onEnsureThreadForFirstSend?: () => Promise<{ threadId: string }>;
  /** Clears the current in-memory exploration. It never creates a Trip. */
  onStartNewExploration?: () => void;
  selectedPlace?: { place: ConversationPlace; context: string } | null;
  onConversationText?: (text: string) => void;
};

export function TravelAgentChat({
  open = true,
  onOpen = () => {},
  onDismiss = () => {},
  threadId: controlledThreadId,
  threadStatus,
  onRetryThread,
  onThreadInvalidated,
  onEnsureThreadForFirstSend,
  onStartNewExploration,
  selectedPlace,
  onConversationText,
}: TravelAgentChatProps) {
  const t = useTranslations("explore.chat");
  const effectiveThreadId = controlledThreadId;
  const resolvedThreadStatus = threadStatus ?? (effectiveThreadId ? "ready" : "preparing");
  // Send is allowed when we already have a thread, or when the parent
  // has supplied a provisioner the first send can use (exploration
  // flow). It is blocked only when there is no thread AND no provisioner,
  // or when the last provision attempt errored.
  const canSend = (Boolean(effectiveThreadId) || Boolean(onEnsureThreadForFirstSend))
    && resolvedThreadStatus !== "error";

  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [sessionMessages, setSessionMessages] = useState<ConversationMessage[]>([]);
  const [refusalMessageIds, setRefusalMessageIds] = useState<Set<string>>(new Set());
  const [pendingTurn, setPendingTurn] = useState<PendingTurn | null>(null);
  const [requestError, setRequestError] = useState<unknown>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<StreamState>(emptyStreamState);
  const panelInputRef = useRef<HTMLTextAreaElement>(null);
  const panelScrollRef = useRef<HTMLDivElement>(null);
  const pendingTurnAnchorRef = useRef<HTMLParagraphElement>(null);
  const wasSendingRef = useRef(false);

  const api = useTravelApi();
  const conversation = useOwnerConversation(effectiveThreadId);
  const agentRun = useAgentRun(activeRunId);
  const refetchAgentRun = agentRun.refetch;
  const cancelRun = useCancelAgentRun();
  const submitTurn = useSubmitConversationTurn();
  const isSending = submitTurn.isPending || Boolean(activeRunId);
  const inputDisabled = !canSend || isSending;

  const clearLocalSessionState = useCallback(() => {
    clearStoredActiveRunId();
    setSessionMessages([]);
    setRefusalMessageIds(new Set());
    setPendingTurn(null);
    setActiveRunId(null);
    setStreamState(emptyStreamState());
    setRequestError(null);
  }, []);

  useEffect(() => {
    const restorePointers = window.setTimeout(() => {
      const storedActiveRunId = readStoredActiveRunId();
      if (storedActiveRunId) setActiveRunId(storedActiveRunId);
    }, 0);
    return () => window.clearTimeout(restorePointers);
  }, []);

  const sendTurn = useCallback(
    async (turn: PendingTurn) => {
      setRequestError(null);
      try {
        let activeThreadId = effectiveThreadId;
        if (!activeThreadId) {
          // Controlled callers must always supply a threadId. The parent
          // (ExploreChatHost / TripWorkspace) owns provisioning; if the
          // id is still null at submit time we surface a request error
          // rather than try to create a thread out-of-band.
          if (!onEnsureThreadForFirstSend) {
            setRequestError(new Error("No active thread for this conversation"));
            return;
          }
          const provisioned = await onEnsureThreadForFirstSend();
          if (!provisioned.threadId) {
            setRequestError(new Error("Could not provision a thread for this conversation"));
            return;
          }
          activeThreadId = provisioned.threadId;
        }

        const response = await submitTurn.mutateAsync({ threadId: activeThreadId, input: turn });
        setSessionMessages((current) => mergeMessages(current, [response.userMessage]));
        setStreamState(emptyStreamState());
        setActiveRunId(response.runId);
        storeActiveRunId(response.runId);
        setPendingTurn(null);
      } catch (error) {
        if (error instanceof TravelApiError && error.statusCode === 404) {
          clearLocalSessionState();
          onThreadInvalidated?.();
          return;
        }
        setRequestError(error);
      }
    },
    [
      submitTurn,
      effectiveThreadId,
      onEnsureThreadForFirstSend,
      clearLocalSessionState,
      onThreadInvalidated,
    ],
  );

  useEffect(() => {
    if (pendingTurn && pendingTurnAnchorRef.current) {
      // scrollIntoView is unavailable in jsdom tests; guard defensively.
      // Call through the element so the host-method `this` binding is preserved;
      // detaching `node.scrollIntoView` to a local throws "Illegal invocation".
      const node = pendingTurnAnchorRef.current;
      try {
        node.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch {
        /* no-op in test environments without scrollIntoView */
      }
    }
  }, [pendingTurn]);

  useEffect(() => {
    if (wasSendingRef.current && !isSending && open && panelInputRef.current) {
      panelInputRef.current.focus();
    }
    wasSendingRef.current = isSending;
  }, [isSending, open]);

  useEffect(() => {
    if (panelInputRef.current && open) {
      panelInputRef.current.focus();
    }
  }, [open]);

  useEffect(() => {
    const textarea = panelInputRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
  }, [draft]);

  useEffect(() => {
  if (conversation.error instanceof TravelApiError && conversation.error.statusCode === 404) {
    // Synchronously clear local state when the server reports the
    // active thread is gone. The cascading render is the correct
    // behavior: it forces the host to re-route to a fresh default
    // thread instead of replaying a ghost conversation.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    clearLocalSessionState();
    onThreadInvalidated?.();
  }
  }, [conversation.error, clearLocalSessionState, onThreadInvalidated]);

  useEffect(() => {
    if (!activeRunId) return;
    const controller = new AbortController();
    void api.subscribeAgentRun(activeRunId, controller.signal, (event) => {
      setStreamState((current) => applyStreamEvent(current, event));
      if (
        event.event === "turn.completed"
        || event.event === "turn.cancelled"
        || event.event === "turn.failed"
        || event.event === "turn.stale"
      ) {
        void refetchAgentRun();
      }
    }).catch(() => {
      // A dropped observation connection never cancels the accepted task.
      // Polling the durable run state remains the recovery path.
    });
    return () => controller.abort();
  }, [activeRunId, api, refetchAgentRun]);

  useEffect(() => {
    if (
      !activeRunId ||
      !(agentRun.error instanceof TravelApiError && agentRun.error.statusCode === 404)
    ) {
      return;
    }
    const staleRun = window.setTimeout(() => {
      setActiveRunId(null);
      clearStoredActiveRunId();
      setStreamState(emptyStreamState());
    }, 0);
    return () => window.clearTimeout(staleRun);
  }, [activeRunId, agentRun.error]);

  useEffect(() => {
    const status = agentRun.data?.status;
    if (!activeRunId || !status) return;
    if (status === "COMPLETED" && effectiveThreadId) {
      let active = true;
      void api.getOwnerConversation(effectiveThreadId).then((restored) => {
        if (active) {
          setSessionMessages((current) => mergeMessages(current, restored.messages));
        }
      }).finally(() => {
        if (active) {
          setActiveRunId(null);
          clearStoredActiveRunId();
          setStreamState(emptyStreamState());
        }
      });
      return () => { active = false; };
    }
    if (status === "FAILED" || status === "STALE" || status === "CANCELLED") {
      const clearTerminalRun = window.setTimeout(() => {
        setActiveRunId(null);
        clearStoredActiveRunId();
        setStreamState(emptyStreamState());
        if (status === "FAILED") setRequestError(new Error("Agent run failed"));
      }, 0);
      return () => window.clearTimeout(clearTerminalRun);
    }
  }, [activeRunId, agentRun.data?.status, api, effectiveThreadId]);

  const messages = useMemo(
    () => mergeMessages(conversation.data?.messages ?? [], sessionMessages),
    [conversation.data?.messages, sessionMessages],
  );
  const visibleError = requestError ?? (
    conversation.error instanceof TravelApiError && conversation.error.statusCode !== 404
      ? conversation.error
      : null
  );

  useEffect(() => {
    if (!open) return;
    const node = panelScrollRef.current;
    if (!node) return;
    // Defer one frame so layout settles after mount, the open transition,
    // or async conversation history arriving.
    const handle = window.setTimeout(() => {
      try {
        node.scrollTop = node.scrollHeight;
      } catch {
        /* no-op in test environments without DOM scroll metrics */
      }
    }, 0);
    return () => window.clearTimeout(handle);
  }, [open, messages.length]);

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || inputDisabled) return;

    const turn: PendingTurn = {
      requestId: crypto.randomUUID(),
      question,
      ...(selectedPlace ? { place: selectedPlace.place } : {}),
    };
    setPendingTurn(turn);
    setRequestError(null);
    setDraft("");
    onConversationText?.(question);
    onOpen();
    void sendTurn(turn);
  }

  function retryPendingTurn() {
    if (!pendingTurn || isSending) return;
    void sendTurn(pendingTurn);
  }

  function closeConversation() {
    setExpanded(false);
    onDismiss();
  }

  function stopActiveRun() {
    if (activeRunId && !cancelRun.isPending) void cancelRun.mutateAsync(activeRunId);
  }

  function askAboutSelectedPlace() {
    if (selectedPlace) setDraft(t("askQuestion", { name: selectedPlace.place.name }));
  }

  function startNewExploration() {
    if (isSending || !onStartNewExploration) return;
    clearLocalSessionState();
    setDraft("");
    onStartNewExploration();
  }

  const submitButton = (
    <button type="submit" aria-label={t("sendAria")} disabled={inputDisabled} className="grid size-11 shrink-0 place-items-center rounded-full bg-sidebar text-white shadow-md transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/70">
      {isSending ? <LoaderCircle aria-hidden="true" className="size-5 animate-spin motion-reduce:animate-none" /> : <ArrowUp aria-hidden="true" className="size-5" />}
    </button>
  );

  if (!open) {
    return (
      <>
        <button type="button" onClick={onOpen} className="absolute bottom-20 right-4 z-40 rounded-full border border-white/80 bg-white/85 px-3 py-1.5 text-[11px] font-bold text-primary shadow-md backdrop-blur transition hover:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/60 landscape:bottom-24 landscape:right-6">{t("history")}</button>
        {resolvedThreadStatus !== "ready" ? (
          <ThreadStatus status={resolvedThreadStatus} onRetry={onRetryThread} compact />
        ) : null}
        <form onSubmit={submitMessage} className="wanderly-liquid-glass absolute bottom-3 left-1/2 z-40 flex min-h-14 w-[calc(100%-3rem)] -translate-x-1/2 items-center gap-2 rounded-full p-1.5 pl-4 landscape:bottom-6 landscape:left-auto landscape:right-6 landscape:w-[min(calc(40vw-1.5rem),calc(66.667dvh-3.5rem),596px)] landscape:translate-x-0" aria-label={t("startAria")}>
          <Sparkles aria-hidden="true" className="size-4 shrink-0 text-primary" />
          <input value={draft} disabled={inputDisabled} onChange={(event) => setDraft(event.target.value)} aria-label={t("startInputAria")} placeholder={t("startPlaceholder")} className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-60" />
          {submitButton}
        </form>
      </>
    );
  }

  const conversationPanel = (
    <aside role="dialog" aria-label={t("dialogAria")} data-expanded={expanded ? "true" : "false"} className={`flex flex-col overflow-hidden shadow-[0_28px_90px_rgb(8_47_63/28%)] transition-[inset,height,width,border-radius] duration-300 ${expanded ? "fixed inset-0 z-[100] h-dvh rounded-none" : "absolute inset-x-3 bottom-3 z-50 h-[60dvh] min-h-[300px] rounded-[28px] landscape:inset-x-auto landscape:bottom-6 landscape:left-auto landscape:right-6 landscape:h-[min(60vw,calc(100dvh-3rem),852px)] landscape:min-h-0 landscape:w-[min(40vw,calc(66.667dvh-2rem),620px)]"}`}>
      <div className={`flex min-h-0 flex-1 flex-col overflow-hidden border-x border-t border-white/80 bg-white landscape:border ${expanded ? "rounded-none" : "rounded-t-[28px] landscape:rounded-[28px]"}`}>
        <header className="relative flex items-center gap-2.5 border-b border-[#dbe8e5] px-3 pb-1 pt-2.5">
          <button type="button" onClick={() => setExpanded((current) => !current)} aria-label={expanded ? t("collapse") : t("expand")} className="absolute left-1/2 top-1 -translate-x-1/2 rounded-full bg-muted/70 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30">{expanded ? t("collapse") : t("expand")}</button>
          <span className="grid size-7 place-items-center rounded-[10px] bg-sidebar text-white shadow-sm"><MessageCircle aria-hidden="true" className="size-4" /></span>
          <p className="min-w-0 flex-1 text-sm font-black tracking-[-0.025em] text-sidebar">{t("agentName")}</p>
          {onStartNewExploration ? <button type="button" onClick={startNewExploration} disabled={isSending} className="rounded-full border border-primary/20 bg-white px-2.5 py-1 text-[10px] font-bold text-primary hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30">{t("startNewExploration")}</button> : null}
          <button type="button" onClick={closeConversation} aria-label={t("close")} className="grid size-7 place-items-center rounded-full bg-sidebar text-white transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sidebar/25"><X aria-hidden="true" className="size-3.5" /></button>
        </header>

        <div ref={panelScrollRef} className="flex-1 space-y-4 overflow-y-auto bg-[linear-gradient(180deg,#ffffff_0%,#f6fbf9_100%)] px-5 py-5" aria-live="polite">
          {resolvedThreadStatus !== "ready" ? <ThreadStatus status={resolvedThreadStatus} onRetry={onRetryThread} /> : null}
          {conversation.isLoading ? <p role="status" className="text-sm text-muted-foreground">{t("restoring")}</p> : null}
          {!conversation.isLoading && messages.length === 0 && !pendingTurn ? (
            <div className="max-w-[86%] rounded-[20px] rounded-tl-[6px] bg-[#e2f3ee] px-4 py-3 text-sm leading-6 text-foreground">
              <p className="font-bold text-primary">{t("introTitle")}</p>
              <p className="mt-1 text-muted-foreground">{t("introBody")}</p>
            </div>
          ) : null}
          {messages.map((message) => (
            <article key={message.id} data-role={message.role} className={message.role === "USER" ? "ml-auto max-w-[86%] rounded-[20px] rounded-tr-[6px] bg-sidebar px-4 py-3 text-sm leading-6 text-white shadow-sm" : "max-w-[86%] rounded-[20px] rounded-tl-[6px] bg-[#e2f3ee] px-4 py-3 text-sm leading-6 text-foreground"}>
              <p>{message.content}</p>
              {refusalMessageIds.has(message.id) ? <p className="mt-2 text-[10px] font-black uppercase tracking-[0.1em] text-primary">{t("verificationRequired")}</p> : null}
            </article>
          ))}
          {pendingTurn ? <p ref={pendingTurnAnchorRef} data-role="USER" data-pending="true" className="ml-auto max-w-[86%] rounded-[20px] rounded-tr-[6px] bg-sidebar px-4 py-3 text-sm leading-6 text-white shadow-sm opacity-80">{pendingTurn.question}</p> : null}
          {activeRunId ? (
            <article data-role="ASSISTANT" data-streaming="true" className="max-w-[86%] rounded-[20px] rounded-tl-[6px] bg-[#e2f3ee] px-4 py-3 text-sm leading-6 text-foreground">
              {streamState.text ? <p>{streamState.text}</p> : null}
              <p role="status" className="mt-1 inline-flex items-center gap-2 text-xs font-semibold text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />{t("sending")}</p>
              <button type="button" onClick={stopActiveRun} disabled={cancelRun.isPending} className="mt-2 rounded-full border border-primary/20 bg-white px-3 py-1 text-xs font-bold text-primary disabled:opacity-50">{t("stop")}</button>
            </article>
          ) : isSending ? <p role="status" className="inline-flex items-center gap-2 text-xs font-semibold text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />{t("sending")}</p> : null}
          {visibleError ? (
            <div role="alert" className="rounded-[16px] border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
              <p className="font-bold">{errorMessage(visibleError, t)}</p>
              {pendingTurn && isRetryable(visibleError) ? <button type="button" onClick={retryPendingTurn} disabled={isSending} className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-bold text-destructive shadow-sm disabled:opacity-50"><RotateCw aria-hidden="true" className="size-3.5" />{t("retry")}</button> : null}
            </div>
          ) : null}
        </div>
      </div>

      <form onSubmit={submitMessage} className="bg-white px-3 pb-3 pt-2">
        {selectedPlace ? <button type="button" onClick={askAboutSelectedPlace} className="mb-1.5 flex h-5 max-w-full items-center rounded-full border border-white/80 bg-[#dff3ed]/90 px-2.5 text-[10px] font-bold text-primary shadow-sm backdrop-blur hover:bg-[#d2eee6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"><span className="truncate">{t("askAbout", { name: selectedPlace.place.name, context: selectedPlace.context })}</span></button> : null}
        <div className="wanderly-liquid-glass flex min-h-14 items-end gap-2 rounded-[20px] p-1.5 pl-4">
          <textarea ref={panelInputRef} value={draft} disabled={inputDisabled} rows={1} enterKeyHint="send" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} aria-label={t("messageInputAria")} placeholder={t("messagePlaceholder")} className="min-w-0 flex-1 resize-none bg-transparent text-sm font-semibold text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-60" />
          {submitButton}
        </div>
      </form>
    </aside>
  );

  return expanded && typeof document !== "undefined" ? createPortal(conversationPanel, document.body) : conversationPanel;
}

function ThreadStatus({ status, onRetry, compact = false }: { status: ChatThreadStatus; onRetry?: () => void; compact?: boolean }) {
  const t = useTranslations("explore.chat");
  const message = status === "preparing" ? t("preparingPrivateChat") : t("privateChatUnavailable");
  return (
    <div role="status" className={compact ? "absolute bottom-20 left-4 z-40 flex items-center gap-2 rounded-full bg-white/85 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground shadow-md backdrop-blur landscape:bottom-24 landscape:left-auto landscape:right-[8.5rem]" : "rounded-[16px] border border-border bg-card p-3 text-sm text-muted-foreground"}>
      <span>{message}</span>
      {status === "error" && onRetry ? <button type="button" onClick={onRetry} className="font-bold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30">{t("retryPrivateChat")}</button> : null}
    </div>
  );
}

function readStoredActiveRunId(): string | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage.getItem(CHAT_ACTIVE_RUN_STORAGE_KEY); } catch { return null; }
}

function storeActiveRunId(runId: string) {
  try { window.localStorage.setItem(CHAT_ACTIVE_RUN_STORAGE_KEY, runId); } catch { /* optional pointer */ }
}

function clearStoredActiveRunId() {
  try { window.localStorage.removeItem(CHAT_ACTIVE_RUN_STORAGE_KEY); } catch { /* optional pointer */ }
}

function mergeMessages(current: ConversationMessage[], incoming: ConversationMessage[]) {
  const messages = new Map(current.map((message) => [message.id, message]));
  incoming.forEach((message) => messages.set(message.id, message));
  return [...messages.values()].sort((a, b) => a.sequence - b.sequence);
}

function emptyStreamState(): StreamState {
  return { attempt: 0, nextSequence: 0, pending: {}, text: "", phase: null };
}

function applyStreamEvent(current: StreamState, event: AgentStreamEvent): StreamState {
  if (event.generationAttempt < current.attempt) return current;
  const base = event.generationAttempt > current.attempt
    ? { ...emptyStreamState(), attempt: event.generationAttempt }
    : current;
  if (event.event === "run.phase") return { ...base, phase: event.phase };
  if (event.event !== "message.delta" || event.sequence < base.nextSequence) return base;

  const pending = { ...base.pending, [event.sequence]: event.delta };
  let nextSequence = base.nextSequence;
  let text = base.text;
  while (Object.prototype.hasOwnProperty.call(pending, nextSequence)) {
    text += pending[nextSequence];
    delete pending[nextSequence];
    nextSequence += 1;
  }
  return { ...base, pending, nextSequence, text };
}

function isRetryable(error: unknown) {
  return !(error instanceof TravelApiError) || error.statusCode === null || [404, 502, 504].includes(error.statusCode);
}

function errorMessage(error: unknown, t: ReturnType<typeof useTranslations>) {
  if (error instanceof TravelApiError) {
    if (error.statusCode === 401 || error.statusCode === 403) return t("authenticationRequired");
    if (error.statusCode === 502 || error.statusCode === 504) return t("providerUnavailable");
    if (error.statusCode === 404) return t("threadMissing");
  }
  return t("genericError");
}
