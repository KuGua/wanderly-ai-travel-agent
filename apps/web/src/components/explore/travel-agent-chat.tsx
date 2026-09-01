"use client";

import { ArrowUp, Check, Copy, LoaderCircle, MessageCircle, RotateCw, Sparkles, Square, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ChatMarkdown } from "@/components/ui/chat-markdown";
import { ResearchConfirmationCard } from "@/components/trips/personal-research/research-confirmation-card";
import { ResearchSetupCard } from "@/components/trips/personal-research/research-setup-card";
import { ResearchPlaceSelectionCard } from "@/components/trips/personal-research/research-place-selection-card";
import { ResearchRunCard } from "@/components/trips/personal-research/research-run-card";

import type { AgentStreamEvent, ConversationMessage, ConversationPlace, ConversationTurnRequest, ResearchSetupSessionResponse } from "@/lib/api/contracts";
import { TravelApiError } from "@/lib/api/errors";
import { recordUiDiagnostic } from "@/lib/observability/ui-diagnostics";
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
   * "floating" overlays the map as a dismissible dialog. "docked" fills
   * the host column and drops the dialog chrome, letting the trip
   * workspace own the header and sizing.
   */
  variant?: "floating" | "docked";
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
  tripId?: string | null;
  titleLocale?: "en" | "zh";
};

export function TravelAgentChat({
  open = true,
  onOpen = () => {},
  onDismiss = () => {},
  variant = "floating",
  threadId: controlledThreadId,
  threadStatus,
  onRetryThread,
  onThreadInvalidated,
  onEnsureThreadForFirstSend,
  onStartNewExploration,
  selectedPlace,
  onConversationText,
  tripId = null,
  titleLocale = "en",
}: TravelAgentChatProps) {
  const t = useTranslations("explore.chat");
  const docked = variant === "docked";
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
  const [briefProposal, setBriefProposal] = useState<Extract<AgentStreamEvent, { event: "trip.brief_proposed" }>["proposal"] | null>(null);
  const [isConfirmingBrief, setIsConfirmingBrief] = useState(false);
  // Phase 6 / Personal Trip Orchestrator — LLM-extracted research draft +
  // accumulated stage events for the in-flight run.
  const [researchIntent, setResearchIntent] =
    useState<Extract<AgentStreamEvent, { event: "research.intent_extracted" }>["intent"] | null>(null);
  // Phase 2 / Personal Research Intent Routing — persisted draft recovery.
  // `classifierDraft` carries the full server-side classification result
  // (intent + readiness + missing) so we can mount the right card variant
  // and survive SSE drops / refresh via the agent-run DTO. SUPERSEDED drafts
  // are server-internal and never surface here.
  const [classifierDraft, setClassifierDraft] =
    useState<Extract<AgentStreamEvent, { event: "research.intent_extracted" }> | null>(null);
  // §9 — Personal Research Setup Session state, surfaced inline from the
  // agent-run DTO so the conversational setup card can hydrate on refresh.
  const [researchSetupSession, setResearchSetupSession] =
    useState<ResearchSetupSessionResponse | null>(null);
  // §9 — Latest conversational followup bubble (server-pushed via SSE).
  const [setupFollowup, setSetupFollowup] =
    useState<Extract<AgentStreamEvent, { event: "research.setup.followup" }> | null>(null);
  const [routeEndpoints, setRouteEndpoints] = useState<Array<{ placeId: string; displayName: string }>>([]);
  const [routeOrigin, setRouteOrigin] = useState<{ placeId: string; displayName: string } | null>(null);
  const [routeDestination, setRouteDestination] = useState<{ placeId: string; displayName: string } | null>(null);
  const [routeMode, setRouteMode] = useState<"WALK" | "DRIVE" | "CYCLE" | null>(null);
  const [isSavingRouteSelection, setIsSavingRouteSelection] = useState(false);
  const [researchStages, setResearchStages] = useState<
    Array<Extract<AgentStreamEvent, { event: "research.stage" }>>
  >([]);
  const [researchOutcome, setResearchOutcome] = useState<
    "COMPLETED" | "COMPLETED_WITH_GAPS" | "FAILED" | "STALE" | null
  >(null);
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
    setBriefProposal(null);
    setClassifierDraft(null);
    setRouteEndpoints([]);
    setRouteOrigin(null);
    setRouteDestination(null);
    setRouteMode(null);
  }, []);

  useEffect(() => {
    if (!tripId || classifierDraft?.readiness !== "NEEDS_PLACE_SELECTION" || !api.getRouteEndpoints) return;
    void api.getRouteEndpoints(tripId).then(setRouteEndpoints).catch(setRequestError);
  }, [api, classifierDraft?.readiness, tripId]);

  const saveRouteSelection = useCallback(async () => {
    if (!classifierDraft || !routeOrigin || !routeDestination || !routeMode || !api.saveRouteSelection) return;
    setIsSavingRouteSelection(true);
    try {
      await api.saveRouteSelection(classifierDraft.runId, {
        originPlaceId: routeOrigin.placeId,
        destinationPlaceId: routeDestination.placeId,
        mode: routeMode,
      });
      setClassifierDraft((current) => current ? { ...current, readiness: "READY", missing: [] } : current);
    } catch (error) {
      setRequestError(error);
    } finally {
      setIsSavingRouteSelection(false);
    }
  }, [api, classifierDraft, routeDestination, routeMode, routeOrigin]);

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
      if (event.event === "trip.brief_proposed") setBriefProposal(event.proposal);
      if (event.event === "research.intent_extracted") {
        setResearchIntent(event.intent);
        // Phase 2: persist the full classifier payload so the card can
        // pick a variant and the user can refresh without losing state.
        setClassifierDraft(event);
      }
      if (event.event === "research.intent_dismissed") {
        // Owner dismissed the draft via POST /dismiss-intent. Clear local
        // state immediately so the card unmounts without waiting for the
        // next 1.5 s agent-run poll.
        setClassifierDraft(null);
        setResearchIntent(null);
        setResearchSetupSession(null);
        setSetupFollowup(null);
      }
      if (event.event === "research.setup.followup") {
        // §9 — Conversational followup bubble. The card hydrates from
        // the agent-run DTO after a refetch; this state only drives the
        // chat bubble the owner reads inline.
        setSetupFollowup(event);
        recordUiDiagnostic("setup.followup_received");
        // Trigger a refresh so the setup card rehydrates with the freshly
        // opened session row.
        void refetchAgentRun();
      }
      if (event.event === "research.stage") {
        setResearchStages((current) => [...current, event]);
        if (event.stage === "COMPLETED"
          || event.stage === "COMPLETED_WITH_GAPS"
          || event.stage === "FAILED"
          || event.stage === "STALE") {
          setResearchOutcome(event.stage);
        }
      }
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

  // Phase 2 — recover a PROPOSED classifier draft from the durable agent-run
  // DTO. The SSE may have dropped (browser backgrounded, network blip, etc.)
  // and the user refreshed — without this effect the card would not re-mount
  // and the owner would lose the ability to confirm or dismiss.
  useEffect(() => {
    const data = agentRun.data;
    if (!data || !activeRunId || data.runId !== activeRunId) return;
    if (data.researchIntentState !== "PROPOSED" || !data.researchIntentDraft) {
      return;
    }
    setResearchIntent((current) => current ?? {
      kind: data.researchIntentDraft!.kind,
      requestedCapabilities: data.researchIntentDraft!.requestedCapabilities,
    });
    setClassifierDraft((current) => current ?? {
      event: "research.intent_extracted",
      runId: activeRunId,
      generationAttempt: data.generationAttempt,
      intent: {
        kind: data.researchIntentDraft!.kind,
        requestedCapabilities: data.researchIntentDraft!.requestedCapabilities,
      },
      readiness: data.researchIntentDraft!.readiness,
      missing: data.researchIntentDraft!.missing,
      schemaVersion: 1,
      classifierVersion: "research-intent/v1",
    });
    // §9 — Rehydrate the setup session projection on mount / SSE refresh
    // so a tab reload can render the conversational card with the
    // already-filled slots intact.
    if (data.researchSetupSession) {
      setResearchSetupSession(data.researchSetupSession);
    } else if (data.researchIntentState !== "PROPOSED") {
      setResearchSetupSession(null);
    }
  }, [agentRun.data, activeRunId]);

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
    const scrollToLatest = () => {
      const node = panelScrollRef.current;
      if (!node) return;
      try {
        node.scrollTop = node.scrollHeight;
      } catch {
        /* no-op in test environments without DOM scroll metrics */
      }
    };

    // History can arrive before or after the panel mounts, and the panel's
    // responsive height settles over its opening transition. Scroll once on
    // the next frame and once after the transition so both paths land on the
    // newest message instead of restoring the beginning of the thread.
    const frame = window.requestAnimationFrame(scrollToLatest);
    const afterTransition = window.setTimeout(scrollToLatest, 350);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(afterTransition);
    };
  }, [open, conversation.isLoading, messages.length]);

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

  async function confirmBriefProposal() {
    if (!tripId || !briefProposal || isConfirmingBrief) return;
    if (!api.updateDraftTripBrief) {
      setRequestError(new Error("Draft brief updates are unavailable"));
      return;
    }
    setIsConfirmingBrief(true);
    setRequestError(null);
    try {
      await api.updateDraftTripBrief(tripId, { ...briefProposal, titleLocale });
      setBriefProposal(null);
    } catch (error) {
      setRequestError(error);
    } finally {
      setIsConfirmingBrief(false);
    }
  }

  const rowClass = docked ? "mx-auto mb-[18px] max-w-[640px]" : "";
  const userBubbleClass = docked
    ? "ml-auto max-w-[86%] bg-[var(--w-info)] px-3.5 py-3 text-sm leading-[1.45] text-[var(--w-ink)] wanderly-edge wanderly-r-md wanderly-shadow-sm"
    : "ml-auto max-w-[86%] rounded-[20px] rounded-tr-[6px] bg-sidebar px-4 py-3 text-sm leading-6 text-white shadow-sm";
  const agentBubbleClass = docked
    ? "group/msg relative max-w-[86%] bg-card px-3.5 py-3 text-[var(--w-ink)] wanderly-edge wanderly-r-md wanderly-shadow-sm"
    : "group/msg relative max-w-[86%] rounded-[20px] rounded-tl-[6px] bg-[#e2f3ee] px-4 py-3 text-foreground";
  const agentLabel = docked ? (
    <div className="mb-1.5 flex items-center gap-2.5 text-xs font-black text-[var(--w-ink)]">
      <span aria-hidden="true" className="grid size-[23px] place-items-center bg-[var(--w-highlight)] text-[10px] text-[var(--w-ink)] wanderly-edge-thin wanderly-r-xs">W</span>
      {t("agentName")}
    </div>
  ) : null;

  const submitButton = (
    <button type="submit" aria-label={t("sendAria")} disabled={inputDisabled} className={docked
      ? "grid size-11 shrink-0 place-items-center disabled:cursor-not-allowed wanderly-edge wanderly-r-md wanderly-shadow-sm wanderly-press wanderly-action"
      : "grid size-11 shrink-0 place-items-center disabled:cursor-not-allowed wanderly-edge wanderly-r-md wanderly-shadow-sm wanderly-press wanderly-action"}>
      {isSending ? <LoaderCircle aria-hidden="true" className="size-5 animate-spin motion-reduce:animate-none" /> : <ArrowUp aria-hidden="true" className="size-5" />}
    </button>
  );

  if (!open) {
    return (
      <>
        <button type="button" onClick={onOpen} data-wanderly-avoid className="absolute bottom-20 right-4 z-40 px-3 py-1.5 text-[11px] font-bold wanderly-cosmos-control wanderly-r-xs wanderly-press landscape:bottom-24 landscape:right-6">{t("history")}</button>
        {resolvedThreadStatus !== "ready" ? (
          <ThreadStatus status={resolvedThreadStatus} onRetry={onRetryThread} compact />
        ) : null}
        <form data-wanderly-perch="composer" data-wanderly-avoid onSubmit={submitMessage} className="absolute bottom-3 left-1/2 z-40 flex min-h-14 w-[calc(100%-3rem)] -translate-x-1/2 items-center gap-2 p-1.5 pl-4 wanderly-cosmos-panel wanderly-r-lg landscape:bottom-6 landscape:left-auto landscape:right-6 landscape:w-[min(calc(40vw-1.5rem),calc(66.667dvh-3.5rem),596px)] landscape:translate-x-0" aria-label={t("startAria")}>
          <Sparkles aria-hidden="true" className="size-4 shrink-0 text-primary" />
          <input value={draft} disabled={inputDisabled} onChange={(event) => setDraft(event.target.value)} aria-label={t("startInputAria")} placeholder={t("startPlaceholder")} className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-[var(--w-fog)] placeholder:text-[var(--w-fog)] placeholder:opacity-70 focus:outline-none disabled:opacity-60" />
          {submitButton}
        </form>
      </>
    );
  }

  const conversationPanel = (
    <aside role={docked ? undefined : "dialog"} data-wanderly-avoid={docked ? undefined : ""} aria-label={t("dialogAria")} data-expanded={expanded ? "true" : "false"} className={docked ? "flex min-h-0 flex-1 flex-col overflow-hidden bg-white" : `flex flex-col overflow-hidden bg-white shadow-[0_28px_90px_rgb(8_47_63/28%)] transition-[inset,height,width,border-radius] duration-300 ${expanded ? "fixed inset-0 z-[100] h-dvh rounded-none" : "absolute inset-x-3 bottom-3 z-50 h-[60dvh] min-h-[300px] rounded-[28px] landscape:inset-x-auto landscape:bottom-6 landscape:left-auto landscape:right-6 landscape:h-[min(60vw,calc(100dvh-3rem),852px)] landscape:min-h-0 landscape:w-[min(40vw,calc(66.667dvh-2rem),620px)]"}`}>
      <div className={docked ? "flex min-h-0 flex-1 flex-col overflow-hidden bg-white" : `flex min-h-0 flex-1 flex-col overflow-hidden border-x border-t border-white/80 bg-white landscape:border ${expanded ? "rounded-none" : "rounded-t-[28px]"}`}>
        {docked ? null : (
        <header className="relative flex items-center gap-2.5 border-b border-[#dbe8e5] px-3 pb-1 pt-2.5">
          <button type="button" onClick={() => setExpanded((current) => !current)} aria-label={expanded ? t("collapse") : t("expand")} className="absolute left-1/2 top-1 -translate-x-1/2 rounded-full bg-muted/70 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30">{expanded ? t("collapse") : t("expand")}</button>
          <span className="grid size-7 place-items-center rounded-[10px] bg-sidebar text-white shadow-sm"><MessageCircle aria-hidden="true" className="size-4" /></span>
          <p className="min-w-0 flex-1 text-sm font-black tracking-[-0.025em] text-sidebar">{t("agentName")}</p>
          {onStartNewExploration ? <button type="button" onClick={startNewExploration} disabled={isSending} className="rounded-full border border-primary/20 bg-white px-2.5 py-1 text-[10px] font-bold text-primary hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30">{t("startNewExploration")}</button> : null}
          <button type="button" onClick={closeConversation} aria-label={t("close")} className="grid size-7 place-items-center rounded-full bg-sidebar text-white transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sidebar/25"><X aria-hidden="true" className="size-3.5" /></button>
        </header>
        )}

        <div ref={panelScrollRef} className={docked
          ? "flex-1 overflow-y-auto bg-background px-[clamp(16px,3vw,34px)] pb-4 pt-6"
          : "flex-1 space-y-4 overflow-y-auto bg-[linear-gradient(180deg,#ffffff_0%,#f6fbf9_100%)] px-5 py-5"} aria-live="polite">
          {resolvedThreadStatus !== "ready" ? <ThreadStatus status={resolvedThreadStatus} onRetry={onRetryThread} /> : null}
          {conversation.isLoading ? <p role="status" className="text-sm text-muted-foreground">{t("restoring")}</p> : null}
          {!conversation.isLoading && messages.length === 0 && !pendingTurn ? (
            <div className={rowClass}>
              {agentLabel}
              <div className={docked ? "max-w-[86%] bg-card px-3.5 py-3 text-sm leading-[1.45] text-[var(--w-ink)] wanderly-edge wanderly-r-md wanderly-shadow-sm" : "max-w-[86%] rounded-[20px] rounded-tl-[6px] bg-[#e2f3ee] px-4 py-3 text-sm leading-6 text-foreground"}>
                <p className="font-bold text-primary">{t("introTitle")}</p>
                <p className="mt-1 text-muted-foreground">{t("introBody")}</p>
              </div>
            </div>
          ) : null}
          {messages.map((message) => (
            <article key={message.id} data-role={message.role} className={rowClass}>
              {message.role === "USER" ? (
                <div className={userBubbleClass}>
                  <p>{message.content}</p>
                </div>
              ) : (
                <>
                  {agentLabel}
                  <div className={agentBubbleClass}>
                    <ChatMarkdown content={message.content} />
                    <CopyButton text={message.content} />
                  </div>
                </>
              )}
              {refusalMessageIds.has(message.id) ? <p className="mt-2 text-[10px] font-black uppercase tracking-[0.1em] text-primary">{t("verificationRequired")}</p> : null}
            </article>
          ))}
          {pendingTurn ? <p ref={pendingTurnAnchorRef} data-role="USER" data-pending="true" className={`${rowClass} ${userBubbleClass} opacity-80`}>{pendingTurn.question}</p> : null}
          {activeRunId ? (
            <article data-role="ASSISTANT" data-streaming="true" className={rowClass}>
              {agentLabel}
              <div className={docked ? "max-w-[86%] bg-card px-3.5 py-3 text-[var(--w-ink)] wanderly-edge wanderly-r-md wanderly-shadow-sm" : "max-w-[86%] rounded-[20px] rounded-tl-[6px] bg-[#e2f3ee] px-4 py-3 text-foreground"}>
              {streamState.text ? (
                <ChatMarkdown content={streamState.text} />
              ) : null}
              <div className="mt-2 flex items-center gap-3">
                <p role="status" className="inline-flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                  <span className="inline-flex gap-[3px]">
                    <span className="size-[5px] animate-bounce rounded-full bg-primary/50 [animation-delay:0ms] motion-reduce:animate-none" />
                    <span className="size-[5px] animate-bounce rounded-full bg-primary/50 [animation-delay:150ms] motion-reduce:animate-none" />
                    <span className="size-[5px] animate-bounce rounded-full bg-primary/50 [animation-delay:300ms] motion-reduce:animate-none" />
                  </span>
                  {t("sending")}
                </p>
                <button type="button" onClick={stopActiveRun} disabled={cancelRun.isPending} className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-white px-3 py-1 text-xs font-bold text-primary disabled:opacity-50">
                  <Square aria-hidden="true" className="size-3 fill-current" />{t("stop")}
                </button>
              </div>
              </div>
            </article>
          ) : isSending ? <p role="status" className={`${rowClass} inline-flex items-center gap-2 text-xs font-semibold text-muted-foreground`}><LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />{t("sending")}</p> : null}
          {visibleError ? (
            <div role="alert" className={`${rowClass} rounded-[16px] border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive`}>
              <p className="font-bold">{errorMessage(visibleError, t)}</p>
              {pendingTurn && isRetryable(visibleError) ? <button type="button" onClick={retryPendingTurn} disabled={isSending} className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-bold text-destructive shadow-sm disabled:opacity-50"><RotateCw aria-hidden="true" className="size-3.5" />{t("retry")}</button> : null}
            </div>
          ) : null}
          {briefProposal && tripId ? (
            <section aria-label={t("briefProposalTitle")} className={`${docked ? "mx-auto mb-[18px] max-w-[640px]" : "max-w-[86%]"} rounded-[18px] border border-primary/20 bg-white p-3 text-sm shadow-sm`}>
              <p className="font-bold text-primary">{t("briefProposalTitle")}</p>
              <p className="mt-1 text-muted-foreground">{t("briefProposalBody", { destination: briefProposal.destinationCandidates?.join(" · ") ?? t("briefProposalNoDestination"), days: briefProposal.travelDays ?? t("briefProposalNoDays") })}</p>
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={() => void confirmBriefProposal()} disabled={isConfirmingBrief} className="min-h-11 rounded-full bg-primary px-3 text-xs font-bold text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/30">{isConfirmingBrief ? t("briefProposalSaving") : t("briefProposalConfirm")}</button>
                <button type="button" onClick={() => setBriefProposal(null)} disabled={isConfirmingBrief} className="min-h-11 rounded-full border border-primary/20 px-3 text-xs font-bold text-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/30">{t("briefProposalIgnore")}</button>
              </div>
            </section>
          ) : null}
          {/* Phase 6 / Personal Trip Orchestrator — research intent + run card. */}
          {researchIntent && tripId ? (
            <div className={`${docked ? "mx-auto mb-[18px] max-w-[640px]" : "max-w-[86%]"}`}>
              {classifierDraft ? (
                classifierDraft.readiness === "NEEDS_PLACE_SELECTION" ? (
                  // Phase 4 place picker binds owner-selected endpoints and
                  // a transport mode before the confirm button enables.
                  // Origin/destination start as null and are filled by the
                  // dedicated place-picker UX (introduced when the
                  // proposal / adopt flow ships).
                  <ResearchPlaceSelectionCard
                    intent={classifierDraft.intent}
                    origin={routeOrigin}
                    destination={routeDestination}
                    mode={routeMode}
                    endpoints={routeEndpoints}
                    onSelectOrigin={setRouteOrigin}
                    onSelectDestination={setRouteDestination}
                    onSelectMode={setRouteMode}
                    onConfirm={() => void saveRouteSelection()}
                    onDismiss={() => {
                      setClassifierDraft(null);
                      setResearchIntent(null);
                    }}
                    isSubmitting={isSavingRouteSelection}
                  />
                ) : classifierDraft.readiness === "NEEDS_SETUP" ? (
                  <ResearchSetupCard
                    tripId={tripId ?? ""}
                    runId={classifierDraft.runId}
                    readiness={classifierDraft.readiness}
                    missing={classifierDraft.missing}
                    intent={classifierDraft.intent}
                    setupSession={researchSetupSession}
                    onDismiss={() => {
                      setClassifierDraft(null);
                      setResearchIntent(null);
                      setResearchSetupSession(null);
                    }}
                  />
                ) : (
                  <ResearchConfirmationCard
                    tripId={tripId}
                    source="classifier-extracted"
                    runId={classifierDraft.runId}
                    intent={classifierDraft.intent}
                    readiness={classifierDraft.readiness}
                    missing={classifierDraft.missing}
                    onDismiss={() => {
                      setClassifierDraft(null);
                      setResearchIntent(null);
                    }}
                  />
                )
              ) : (
                <ResearchConfirmationCard
                  tripId={tripId}
                  source="model-extracted"
                  intent={researchIntent}
                  onDismiss={() => setResearchIntent(null)}
                />
              )}
            </div>
          ) : null}
          {/* §9 — Conversational followup bubble. Renders right below the
              research card so the owner can read the LLM followup in
              chat order; auto-clears when the SSE handler refreshes. */}
          {setupFollowup ? (
            <div
              className={`${docked ? "mx-auto mb-[18px] max-w-[640px]" : "max-w-[86%]"}`}
              data-testid="setup-followup-bubble"
              data-question-code={setupFollowup.followup.questionCode}
              data-source={setupFollowup.source}
            >
              <article className="rounded-md border border-amber-200 bg-white p-2 text-sm text-amber-900">
                <p className="text-xs">{setupFollowup.followup.promptText}</p>
                <p className="mt-1 text-[10px] italic text-muted-foreground">
                  来源：{setupFollowup.source === "model" ? "LLM 生成" : "本地模板"}
                </p>
              </article>
            </div>
          ) : null}
          {activeRunId ? (
            <div className={`${docked ? "mx-auto mb-[18px] max-w-[640px]" : "max-w-[86%]"}`}>
              <ResearchRunCard
                runId={activeRunId}
                stages={researchStages}
                outcome={researchOutcome}
              />
            </div>
          ) : null}
        </div>
      </div>

      <form onSubmit={submitMessage} className={docked ? "border-t-2 border-[var(--w-ink)] bg-background px-[clamp(16px,3vw,34px)] pb-[18px] pt-3" : "bg-white px-3 pb-3 pt-2"}>
        {selectedPlace ? <button type="button" onClick={askAboutSelectedPlace} className="mb-1.5 flex h-5 max-w-full items-center rounded-full border border-white/80 bg-[#dff3ed]/90 px-2.5 text-[10px] font-bold text-primary shadow-sm backdrop-blur hover:bg-[#d2eee6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"><span className="truncate">{t("askAbout", { name: selectedPlace.place.name, context: selectedPlace.context })}</span></button> : null}
        <div className={docked ? "mx-auto flex min-h-14 max-w-[640px] items-center gap-2 bg-card p-1.5 pl-4 wanderly-edge wanderly-r-md wanderly-shadow-sm" : "wanderly-liquid-glass flex min-h-14 items-end gap-2 rounded-[20px] p-1.5 pl-4"}>
          <textarea ref={panelInputRef} value={draft} disabled={inputDisabled} rows={1} enterKeyHint="send" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} aria-label={t("messageInputAria")} placeholder={t("messagePlaceholder")} className={docked ? "max-h-[100px] min-w-0 flex-1 resize-none bg-transparent text-sm font-semibold leading-[1.4] text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-60" : "min-w-0 flex-1 resize-none bg-transparent text-sm font-semibold text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-60"} />
          {submitButton}
        </div>
        {docked ? <p className="mx-auto mt-[7px] max-w-[640px] text-[11px] text-[var(--w-ink)] opacity-75">{t("composerNote")}</p> : null}
      </form>
    </aside>
  );

  return expanded && !docked && typeof document !== "undefined" ? createPortal(conversationPanel, document.body) : conversationPanel;
}

function ThreadStatus({ status, onRetry, compact = false }: { status: ChatThreadStatus; onRetry?: () => void; compact?: boolean }) {
  const t = useTranslations("explore.chat");
  const message = status === "preparing" ? t("preparingPrivateChat") : t("privateChatUnavailable");
  return (
    <div role="status" data-wanderly-avoid={compact ? "" : undefined} className={compact ? "absolute bottom-20 left-4 z-40 flex items-center gap-2 px-3 py-1.5 text-[11px] font-semibold wanderly-cosmos-panel wanderly-r-xs landscape:bottom-24 landscape:left-auto landscape:right-[8.5rem]" : "rounded-[16px] border border-border bg-card p-3 text-sm text-muted-foreground"}>
      <span>{message}</span>
      {status === "error" && onRetry ? <button type="button" onClick={onRetry} className="font-bold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30">{t("retryPrivateChat")}</button> : null}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);
  return (
    <button
      type="button"
      onClick={copy}
      aria-label="Copy"
      className="absolute -bottom-1 right-2 grid size-7 place-items-center rounded-lg border border-transparent bg-transparent text-muted-foreground/0 transition group-hover/msg:border-border group-hover/msg:bg-white group-hover/msg:text-muted-foreground group-hover/msg:shadow-sm focus-visible:border-border focus-visible:bg-white focus-visible:text-muted-foreground focus-visible:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
    >
      {copied ? <Check aria-hidden="true" className="size-3.5 text-primary" /> : <Copy aria-hidden="true" className="size-3.5" />}
    </button>
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
  return !(error instanceof TravelApiError) || error.statusCode === null || [404, 500, 502, 504].includes(error.statusCode);
}

function errorMessage(error: unknown, t: ReturnType<typeof useTranslations>) {
  if (error instanceof TravelApiError) {
    if (error.statusCode === 401 || error.statusCode === 403) return t("authenticationRequired");
    if (error.statusCode === 502 || error.statusCode === 504) return t("providerUnavailable");
    if (error.statusCode === 404) return t("threadMissing");
  }
  return t("genericError");
}
