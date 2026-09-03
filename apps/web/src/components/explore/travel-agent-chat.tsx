"use client";

import { ArrowRight, ArrowUp, Check, ChevronDown, Copy, LoaderCircle, Plus, RotateCw, Sparkles, Square } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormEvent, KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChatMarkdown } from "@/components/ui/chat-markdown";
import { ResearchRunCard } from "@/components/trips/personal-research/research-run-card";
import { TripPreferenceCard } from "./trip-preference-card";
import { PinnedResultCard } from "@/components/trips/personal-research/pinned-result-card";
import { ConversationHandoffCard } from "@/components/trips/personal-research/conversation-handoff-card";

import type {
  AgentStreamEvent,
  ConstraintHandoffConfirmResponse,
  ConversationFlightOffer,
  ConversationHotelOffer,
  ConversationMessage,
  ConversationPlace,
  ConversationTurnRequest,
  PersonalResearchOperationCapability,
} from "@/lib/api/contracts";
import { FlightOfferCard } from "@/components/trips/flight-offer-card";
import { SearchHotelOfferCard } from "@/components/trips/search-hotel-offer-card";
import { useQueryClient } from "@tanstack/react-query";

import { threadKeys } from "@/lib/query/keys";
import { TravelApiError } from "@/lib/api/errors";
import { useActivateTrip, useAgentRun, useCancelAgentRun, useConstraintHandoffBatch, useOwnerConversation, useSubmitConversationTurn, useTrip, useTripPin } from "@/lib/query/hooks";
import { viewerScopedKey } from "@/lib/auth/viewer-scoped-storage";
import { useTravelApi } from "@/lib/query/provider";
import { Link, useRouter } from "@/i18n/navigation";

export const CHAT_ACTIVE_RUN_STORAGE_KEY = "wanderly.privateChatActiveRunId.v1";
type PendingTurn = ConversationTurnRequest;
/**
 * One lookup the assistant made while composing the current reply. Kept in
 * arrival order so the reader sees the sequence of work, and settled entries
 * stay visible — knowing a search came back empty is the useful part.
 */
type ToolActivity = {
  capability: PersonalResearchOperationCapability;
  outcome: "RUNNING" | "AVAILABLE" | "UNAVAILABLE" | "NEEDS_CONFIRMATION";
  currency?: string;
  flightOffers?: ConversationFlightOffer[];
  hotelOffers?: ConversationHotelOffer[];
};

type StreamState = {
  attempt: number;
  nextSequence: number;
  pending: Record<number, string>;
  text: string;
  phase: string | null;
  tools: ToolActivity[];
};

type FlightPreferenceDraft = {
  tripType: "ONE_WAY" | "ROUND_TRIP" | null;
  adults: number | null;
  cabin: "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST" | null;
  currency: "SGD" | "USD" | "CNY" | null;
};

const EMPTY_FLIGHT_PREFERENCE_DRAFT: FlightPreferenceDraft = {
  tripType: null,
  adults: null,
  cabin: null,
  currency: null,
};

/**
 * What the private thread behind this chat is doing.
 *
 * `idle` and `preparing` are deliberately separate. The exploration surface
 * provisions its thread lazily — nothing is created until the first Send — so
 * "no thread yet" is the resting state, not work in progress. Folding the two
 * together made the composer sit under a permanent "Preparing your private
 * chat…" banner that described work nobody had started.
 */
export type ChatThreadStatus = "idle" | "preparing" | "ready" | "error";

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
   * Which surface this chat is. Stamped on every turn so the server can keep
   * exploration out of long-term memory — turning the globe and asking about a
   * city is browsing, not stating how you travel. Defaults to EXPLORE so a
   * caller that forgets it errs toward remembering nothing.
   */
  surface?: "EXPLORE" | "TRIP_WORKSPACE";
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
  /**
   * Phase 2 — fired exactly when the member confirms a handoff batch and
   * the server returns a fresh PLAN/REPLAN run. The workspace uses this
   * to auto-switch the *triggering* member to the shared view once the
   * run reaches a terminal status. Other members discover the same run
   * via `useLatestPlanningRun`'s 60s polling — they are NOT auto-switched
   * (§1.7).
   *
   * The chat calls this with `{ runId, operation }` only; the workspace
   * owns the terminal-status decision and the URL navigation.
   */
  onSharedRunStarted?: (input: { runId: string; operation: "PLAN" | "REPLAN" }) => void;
};

/**
 * Whether this Enter is finishing a word rather than a message.
 *
 * Typing "sgd" with a Chinese IME active leaves the letters uncommitted until
 * Enter lands them. That Enter reached the form and sent the draft
 * mid-sentence — the traveller pressed a key meaning "keep what I typed" and
 * the message went out.
 *
 * `isComposing` is the standard signal. `keyCode === 229` is the older one
 * some engines still send while a composition is open, and costs nothing to
 * check: 229 is never a real key.
 */
function isComposingKey(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
  return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
}

export function TravelAgentChat({
  open = true,
  onOpen = () => {},
  onDismiss = () => {},
  variant = "floating",
  surface = "EXPLORE",
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
  onSharedRunStarted,
}: TravelAgentChatProps) {
  const t = useTranslations("explore.chat");
  const router = useRouter();
  // The same card serves the globe and the workspace, and only one of them
  // has a planner to open — saying "opens the planner" to someone already
  // standing in it is just wrong.
  const onGlobe = surface !== "TRIP_WORKSPACE";
  const docked = variant === "docked";
  const effectiveThreadId = controlledThreadId;
  // Absent an explicit status, a missing thread means "none yet", not "one is
  // being built": only the owner of the provisioning request knows which, and
  // it tells us through `threadStatus`.
  const resolvedThreadStatus = threadStatus ?? (effectiveThreadId ? "ready" : "idle");
  // Quick orchestration — read the server-managed pinned session for the
  // current trip. Renders above the messages (only when not actively
  // handling a research intent draft). The card is read-only in MVP.
  const tripPin = useTripPin(tripId ?? null);
  const trip = useTrip(tripId);
  const activateTrip = useActivateTrip(tripId ?? "");
  const pinnedSession = tripPin.data ?? null;
  // Send is allowed when we already have a thread, or when the parent
  // has supplied a provisioner the first send can use (exploration
  // flow). It is blocked only when there is no thread AND no provisioner,
  // or when the last provision attempt errored.
  const canSend = (Boolean(effectiveThreadId) || Boolean(onEnsureThreadForFirstSend))
    && resolvedThreadStatus !== "error";

  const [draft, setDraft] = useState("");
  const [sessionMessages, setSessionMessages] = useState<ConversationMessage[]>([]);
  /**
   * Which thread the buffer above belongs to.
   *
   * The buffer holds messages this tab sent or restored, merged over what the
   * server returns so a reply appears without waiting for a refetch. Nothing
   * cleared it when the thread changed, so opening a new thread rendered the
   * previous one's conversation inside it: the database held two messages and
   * the screen showed a dozen. Worse than cosmetic — the server builds the
   * model's context from the real thread, so the traveller could ask about a
   * flight that was on their screen and nowhere in the assistant's context.
   *
   * Compared rather than cleared on a change: a cleanup effect renders the
   * stale messages once before it runs.
   */
  const [sessionThreadId, setSessionThreadId] = useState<string | null>(null);
  /**
   * A selection inside an assistant message, and where it sits, so the
   * "remember this" control can be put next to it.
   *
   * Held only while the selection exists: the browser clears it on the next
   * click, and a stale button offering to remember text nobody has selected
   * would remember the wrong thing.
   */
  const [highlight, setHighlight] = useState<{ text: string; x: number; y: number; messageId: string } | null>(null);
  /**
   * The trip's preference card, shown once per member per trip. `null` once
   * answered or when the server says this member has already been asked.
   */
  const [preferenceCard, setPreferenceCard] = useState<import("@/lib/api/contracts").PreferenceCard | null>(null);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [preferenceSaveFailed, setPreferenceSaveFailed] = useState(false);
  const [preferenceSaved, setPreferenceSaved] = useState(false);
  const [rememberState, setRememberState] = useState<{ status: "saving" | "done"; message?: string } | null>(null);
  const [refusalMessageIds, setRefusalMessageIds] = useState<Set<string>>(new Set());
  const [pendingTurn, setPendingTurn] = useState<PendingTurn | null>(null);
  const [requestError, setRequestError] = useState<unknown>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<StreamState>(emptyStreamState);
  const [pendingFlightConfirmation, setPendingFlightConfirmation] = useState(false);
  // This is intentionally a local draft. Selecting a chip does not create a
  // preference version, invalidate a plan, or authorize a provider call; the
  // explicit Save button below is the sole durable write.
  const [showFlightPreferenceCard, setShowFlightPreferenceCard] = useState(false);
  const [flightPreferenceDraft, setFlightPreferenceDraft] = useState<FlightPreferenceDraft>(EMPTY_FLIGHT_PREFERENCE_DRAFT);
  const [isSavingFlightPreferences, setIsSavingFlightPreferences] = useState(false);
  const [flightPreferenceSaveError, setFlightPreferenceSaveError] = useState<unknown>(null);
  const [flightPreferencesSaved, setFlightPreferencesSaved] = useState(false);
  const [briefProposal, setBriefProposal] = useState<Extract<AgentStreamEvent, { event: "trip.brief_proposed" }>["proposal"] | null>(null);
  const [isConfirmingBrief, setIsConfirmingBrief] = useState(false);
  const [isStartingSharedPlan, setIsStartingSharedPlan] = useState(false);
  // The assistant already has every field it needs for a flight search but
  // won't spend the metered provider call without a person's say-so. Rather
  // than have the user type "确认搜索", a persistent button does it — it
  // survives past the streaming run (unlike `streamState.tools`) so it is
  // still there once the assistant's "please confirm" reply has settled.
  // Member conversation handoff — a fresh candidate batch arrives via SSE
  // (`conversation.handoff_ready`). We keep only the latest batchId; older
  // ones are cleared once the actor confirms or dismisses. Nothing is
  // persisted to localStorage / Zustand.
  const [handoffBatchId, setHandoffBatchId] = useState<string | null>(null);
  const [handoffDismissed, setHandoffDismissed] = useState(false);
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
  const queryClient = useQueryClient();
  const agentRun = useAgentRun(activeRunId);
  const refetchAgentRun = agentRun.refetch;
  const cancelRun = useCancelAgentRun();
  const submitTurn = useSubmitConversationTurn();
  const isSending = submitTurn.isPending || Boolean(activeRunId);
  const inputDisabled = !canSend || isSending;

  const clearLocalSessionState = useCallback(() => {
    clearStoredActiveRunId();
    setSessionMessages([]);
    setSessionThreadId(null);
    setRefusalMessageIds(new Set());
    setPendingTurn(null);
    setActiveRunId(null);
    setStreamState(emptyStreamState());
    setRequestError(null);
    setBriefProposal(null);
    setPendingFlightConfirmation(false);
    setShowFlightPreferenceCard(false);
    setFlightPreferenceDraft(EMPTY_FLIGHT_PREFERENCE_DRAFT);
    setIsSavingFlightPreferences(false);
    setFlightPreferenceSaveError(null);
    setFlightPreferencesSaved(false);
    setHandoffBatchId(null);
    setHandoffDismissed(false);
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
      // Any new turn — typed or via the confirm/cancel buttons below —
      // supersedes whatever the previous turn was waiting on.
      setPendingFlightConfirmation(false);
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

        const response = await submitTurn.mutateAsync({
          threadId: activeThreadId,
          // Stamped here rather than at each call site so the confirm and
          // cancel buttons carry it too, not just typed messages.
          input: { ...turn, surface },
        });
        setSessionThreadId(activeThreadId);
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
      surface,
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
      if (event.event === "trip.brief_proposed") {
        // A traveller often supplies the brief across several turns (city and
        // duration first, departure/date next). Keep the unconfirmed card as
        // an accumulating review, rather than discarding earlier fields.
        setBriefProposal((current) => ({ ...current, ...event.proposal }));
      }
      if (event.event === "turn.completed" && event.responseMode === "SAFE_REFUSAL" && event.assistantMessageId) {
        setRefusalMessageIds((current) => new Set(current).add(event.assistantMessageId!));
      }
      if (event.event === "tool.settled" && event.capability === "flight.search" && event.outcome === "NEEDS_CONFIRMATION") {
        setPendingFlightConfirmation(true);
      }
      if (event.event === "conversation.handoff_ready") {
        // Replace any previous card — the latest batch is the only one the
        // member can act on, and the worker has already invalidated earlier
        // candidate_versions server-side via the unique partial index.
        setHandoffBatchId(event.batchId);
        setHandoffDismissed(false);
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

  useEffect(() => {
    // 404 is the run being gone; 403 is it belonging to somebody else. Both
    // mean the pointer this browser kept is not one the current viewer can
    // follow, and the second happens the moment two people sign in on the
    // same browser — the key is not scoped per user, so the previous
    // traveller's run id survives the sign-out.
    //
    // Only 404 used to clear it, so a switched account polled a stranger's
    // run forever: `isSending` stays true while `activeRunId` is set, which
    // left the composer disabled under "Wanderly is thinking…" that could
    // never finish.
    const unusable = agentRun.error instanceof TravelApiError
      && (agentRun.error.statusCode === 404 || agentRun.error.statusCode === 403);
    if (!activeRunId || !unusable) {
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
        // Into the SHARED cache first, and unconditionally — this must land
        // even when `active` is false, i.e. when this instance is already
        // unmounting. Switching surface mid-run (the globe's "Back to trip",
        // say) races: whichever chat instance sees COMPLETED first clears the
        // stored run pointer, so the instance that mounts afterwards has
        // nothing left to poll. Writing only to local state meant the reply
        // died with the instance that fetched it, and the new surface showed
        // the question with no answer under it until something unrelated
        // refetched — measured at ~26s. The cache outlives both instances, so
        // the surviving one renders the reply immediately.
        queryClient.setQueryData(threadKeys.conversation(effectiveThreadId), restored);
        if (active) {
          setSessionThreadId(effectiveThreadId);
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
        if (status === "FAILED") {
          setRequestError(new AgentRunFailure(
            agentRun.data?.operation ?? "CONVERSATION",
            agentRun.data?.errorCode ?? null,
          ));
        }
      }, 0);
      return () => window.clearTimeout(clearTerminalRun);
    }
  }, [activeRunId, agentRun.data?.status, agentRun.data?.operation, agentRun.data?.errorCode, api, effectiveThreadId, queryClient]);

  // Backstop for the confirm panel: `useAgentRun` polls this run every 1.5s
  // regardless of the SSE stream's health, so a dropped or reconnected
  // stream — routine over a LAN Wi-Fi hop, and this one has no replay —
  // still surfaces the pending confirmation once the next poll lands.
  //
  // `undefined` and `false` are not the same answer. A completed run is
  // cleared from `activeRunId`, so there is nothing left to poll and the
  // panel has to stay on its own — that is the normal case, the model asks
  // and then the turn ends. But this used to latch on true and never come
  // down, so a traveller who typed 确认搜索 instead of clicking got their
  // flights and kept the card, asking whether to run a search whose results
  // were on screen above it. A run that says it is no longer waiting is
  // answering the question, and is taken at its word.
  useEffect(() => {
    const pending = agentRun.data?.pendingFlightConfirmation;
    if (pending === undefined) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingFlightConfirmation(pending);
  }, [agentRun.data?.pendingFlightConfirmation]);

  // The trip carries the unconfirmed brief too, and unlike the run it is still
  // there after a reload or on another device. This is the copy that makes the
  // card dependable; the run and the notification are just faster.
  useEffect(() => {
    const proposed = trip.data?.trip.pendingBriefProposal;
    if (!proposed) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBriefProposal((current) => ({ ...current, ...proposed }));
  }, [trip.data?.trip.pendingBriefProposal]);

  // Same reason as the confirmation above: `trip.brief_proposed` is published
  // once and never replayed, so a client that finishes subscribing after the
  // worker published it — which is what happens on a fast turn — never learns
  // the brief exists. The run carries it, and the run is already polled.
  // Merged rather than replaced so a brief built across several turns keeps
  // the fields earlier turns contributed.
  useEffect(() => {
    const proposed = agentRun.data?.tripBriefProposal;
    if (!proposed) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBriefProposal((current) => ({ ...current, ...proposed }));
  }, [agentRun.data?.tripBriefProposal]);

  // The classifier is server-owned. Only its explicit flight-preference gap
  // can open this card; a phrase that merely mentions a flight cannot cause a
  // durable preference form to appear or be written against a trip.
  useEffect(() => {
    const intent = agentRun.data?.researchIntentDraft;
    const needsFlightPreferences = intent?.requestedCapabilities.includes("flight")
      && intent.missing.includes("FLIGHT_PREFERENCES_MISSING");
    // The server classifier is an external signal; the card intentionally
    // latches open until the traveller saves or dismisses it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (tripId && needsFlightPreferences) setShowFlightPreferenceCard(true);
  }, [agentRun.data?.researchIntentDraft, tripId]);

  const messages = useMemo(
    () => mergeMessages(
      conversation.data?.messages ?? [],
      sessionThreadId === effectiveThreadId ? sessionMessages : [],
    ),
    [conversation.data?.messages, sessionMessages, sessionThreadId, effectiveThreadId],
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

    // Answered here rather than sent: there is nothing for the model to do
    // with a request to open a card.
    if (opensPreferenceCard(question)) {
      setDraft("");
      void reopenPreferenceCard();
      return;
    }
    dismissPreferenceCardOnSend();

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

  function collapseConversation() {
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
      await api.updateDraftTripBrief(tripId, {
        ...briefProposal,
        // The extractor is instructed to return the full updated destination
        // set (not just newly-added ones) whenever it proposes this field —
        // replace rather than merge-append so a corrected list actually wins.
        replaceDestinationCandidates: briefProposal.destinationCandidates ? true : undefined,
        titleLocale,
      });
      await trip.refetch();
      setBriefProposal(null);
      // Saving the destination and then leaving the traveller on the globe
      // made them find the planner themselves, with no sign the answer had
      // landed anywhere. Choosing to plan is choosing to go there, so the
      // same click does. The thread comes along so the conversation they were
      // just having is the one waiting for them.
      if (onGlobe) {
        router.push(
          (effectiveThreadId
            ? `/trips/${tripId}?thread=${effectiveThreadId}`
            : `/trips/${tripId}`) as "/trips/[tripId]",
        );
      } else {
        setIsConfirmingBrief(false);
      }
    } catch (error) {
      setRequestError(error);
      // Only cleared here: on the way to the planner this component unmounts,
      // and dropping the flag first would flash the button back to its resting
      // label mid-navigation.
      setIsConfirmingBrief(false);
    }
  }

  async function startSharedPlanning() {
    const currentTrip = trip.data?.trip;
    if (!tripId || !currentTrip || currentTrip.status !== "DRAFT" || isStartingSharedPlan) return;
    setIsStartingSharedPlan(true);
    setRequestError(null);
    try {
      await activateTrip.mutateAsync({
        departureCities: currentTrip.departureCities,
        destinationCandidates: currentTrip.destinationCandidates,
        travelDateStart: currentTrip.travelDateStart,
        travelDateEnd: currentTrip.travelDateEnd,
        travelDays: currentTrip.travelDays ?? undefined,
        titleLocale,
      }).then((result) => {
        if (result.planningRun) {
          setActiveRunId(result.planningRun.runId);
          storeActiveRunId(result.planningRun.runId);
        }
      });
      await trip.refetch();
    } catch (error) {
      setRequestError(error);
    } finally {
      setIsStartingSharedPlan(false);
    }
  }

  const canStartSharedPlanning = trip.data?.trip.status === "DRAFT"
    && trip.data.trip.departureCities.length > 0
    && trip.data.trip.destinationCandidates.length > 0
    && Boolean(trip.data.trip.travelDateStart)
    && Boolean(trip.data.trip.travelDateEnd || trip.data.trip.travelDays);

  function confirmFlightSearch() {
    if (isSending) return;
    // The server's confirmation gate reads the literal phrase from the user
    // message (see `conversation-task-handler.ts`'s `CONFIRMATION_PATTERN`) —
    // sending it here is what actually authorizes the metered provider call.
    //
    // It names flights. The bare "确认搜索" authorised whichever search the
    // model then chose, and in a thread that had also discussed hotels the
    // hotel readiness rule won: pressing this button ran a hotel search. A
    // button means one search, so it says which.
    void sendTurn({ requestId: crypto.randomUUID(), question: "确认搜索机票" });
  }

  function cancelFlightSearch() {
    if (isSending) return;
    void sendTurn({ requestId: crypto.randomUUID(), question: "取消这次机票搜索" });
  }

  async function saveFlightPreferences() {
    if (
      !tripId
      || !flightPreferenceDraft.tripType
      || !flightPreferenceDraft.adults
      || !flightPreferenceDraft.cabin
      || !flightPreferenceDraft.currency
      || isSavingFlightPreferences
    ) return;

    setIsSavingFlightPreferences(true);
    setFlightPreferenceSaveError(null);
    try {
      await api.saveTripSearchPreferences(tripId, {
        tripType: flightPreferenceDraft.tripType,
        adults: flightPreferenceDraft.adults,
        cabin: flightPreferenceDraft.cabin,
        currency: flightPreferenceDraft.currency,
        // This is a product freshness bound, not an inferred traveller
        // preference. It keeps the existing endpoint contract intact.
        offerFreshnessMinutes: 60,
      });
      setFlightPreferencesSaved(true);
    } catch (error) {
      setFlightPreferenceSaveError(error);
    } finally {
      setIsSavingFlightPreferences(false);
    }
  }

  function updateFlightPreference<K extends keyof FlightPreferenceDraft>(key: K, value: FlightPreferenceDraft[K]) {
    setFlightPreferenceDraft((current) => ({ ...current, [key]: value }));
    setFlightPreferencesSaved(false);
    setFlightPreferenceSaveError(null);
  }

  const rowClass = docked ? "mx-auto mb-[18px] max-w-[640px]" : "mb-2.5";
  // Bubbles and inline cards keep the same illustrated shape in both modes,
  // but not the same fill: the docked Trip workspace sits on paper, while the
  // floating Explore panel sits in the cosmic scene, where a white card is
  // ruled out (docs/prototype-design-system.md). `wanderly-cosmos-surface` is
  // that card's deep-space counterpart, so only fill and outline differ.
  const surfaceClass = docked
    ? "bg-card text-[var(--w-ink)] wanderly-edge"
    : "wanderly-cosmos-surface";
  const userBubbleClass = docked
    ? "ml-auto max-w-[86%] bg-[var(--w-info)] px-3.5 py-3 text-sm leading-[1.45] text-[var(--w-ink)] wanderly-edge wanderly-r-md wanderly-shadow-sm"
    : "ml-auto w-fit max-w-[86%] bg-[var(--w-info)] px-3.5 py-2 text-sm leading-[1.45] text-[var(--w-ink)] wanderly-edge wanderly-r-md";
  // On the globe, assistant replies sit directly on the conversation ground:
  // the panel is already a readable surface, so wrapping every answer in a
  // second framed card makes the narrow column feel dense. The Trip workspace
  // keeps its illustrated card treatment because it lives on a paper surface.
  const agentBubbleClass = docked
    ? `group/msg relative max-w-[86%] px-3.5 py-3 ${surfaceClass} wanderly-r-md wanderly-shadow-sm`
    : "group/msg relative max-w-[86%] py-1 text-[var(--w-fog)]";
  const streamingAgentClass = docked
    ? `max-w-[86%] px-3.5 py-3 ${surfaceClass} wanderly-r-md wanderly-shadow-sm`
    : "max-w-[86%] py-1 text-[var(--w-fog)]";
  // The destination now names the action instead of sitting in a list above
  // it, so the option reads as the decision rather than as a record change.
  // Absent — the model proposed only dates, say — the label stays generic
  // rather than rendering an empty gap.
  const briefDestination = briefProposal?.destinationCandidates?.length
    ? briefProposal.destinationCandidates.join(" · ")
    : null;
  const briefPrimaryLabel = isConfirmingBrief
    ? t(onGlobe ? "briefProposalOpening" : "briefProposalSaving")
    : onGlobe
      ? t("briefProposalPlanCompact")
      : briefDestination
        ? t("briefProposalSaveTitle", { destination: briefDestination })
        : t("briefProposalSaveTitleNoDestination");
  const briefSecondaryLabel = t(onGlobe ? "briefProposalExploreCompact" : "briefProposalKeepTitle");

  const actionCardClass = `px-3.5 py-3 text-sm ${surfaceClass} wanderly-r-md wanderly-shadow-sm`;
  const actionPrimaryClass = "min-h-10 px-3 text-xs font-extrabold wanderly-edge-thin wanderly-r-xs wanderly-shadow-xs wanderly-press wanderly-action disabled:cursor-not-allowed disabled:opacity-50";
  const actionSecondaryClass = docked
    ? "min-h-10 bg-[var(--w-mist)] px-3 text-xs font-extrabold text-[var(--w-ink)] wanderly-edge-thin wanderly-r-xs wanderly-press disabled:cursor-not-allowed disabled:opacity-50"
    : "min-h-10 px-3 text-xs font-extrabold wanderly-cosmos-control wanderly-r-xs wanderly-press disabled:cursor-not-allowed disabled:opacity-50";

  const agentLabel = docked ? (
    <div className={`mb-1.5 flex items-center gap-2.5 text-xs font-black ${docked ? "text-[var(--w-ink)]" : "text-[var(--w-fog)]"}`}>
      <span aria-hidden="true" className="grid size-[23px] place-items-center bg-[var(--w-highlight)] text-[10px] text-[var(--w-ink)] wanderly-edge-thin wanderly-r-xs">W</span>
      {t("agentName")}
    </div>
  ) : null;

  // Only inside a trip. The card asks how this trip should differ from the
  // traveller's usual preferences, which is not a question the globe is
  // entitled to ask: someone turning it and typing a city is looking around,
  // and a DRAFT trip exists at that moment only because the first message
  // created one. Asking there interrupts browsing with a form about a trip the
  // traveller has not decided to take.
  useEffect(() => {
    if (surface !== "TRIP_WORKSPACE") return;
    if (!tripId || !api.getPreferenceCard) return;
    let active = true;
    void api.getPreferenceCard(tripId)
      .then((card) => { if (active && card.show) setPreferenceCard(card); })
      // A card that cannot be fetched is not worth failing the chat over.
      .catch(() => undefined);
    return () => { active = false; };
  }, [tripId, api, surface]);

  /**
   * Typing past the card is an answer too.
   *
   * Someone who reads it, decides their profile is right and just asks their
   * question has said so as clearly as if they had pressed the button. Leaving
   * the card up would make them dismiss something they had already moved past.
   * Recorded as no adjustments, so the trip keeps inheriting.
   */
  function dismissPreferenceCardOnSend() {
    if (!preferenceCard) return;
    setPreferenceCard(null);
    if (tripId && api.resolvePreferenceCard) {
      void api.resolvePreferenceCard(tripId, []).catch(() => undefined);
    }
  }

  async function resolvePreferences(adjustments: Array<{ fieldKey: string; value: unknown }>) {
    if (!tripId || !api.resolvePreferenceCard) return;
    setPreferenceSaveFailed(false);
    setPreferenceSaved(false);
    setSavingPreferences(true);
    try {
      await api.resolvePreferenceCard(tripId, adjustments);
      // The card is meant to go once it is answered, but going *silently*
      // reads exactly like the failure it used to be: the traveller fills it
      // in, it vanishes, and nothing says whether anything was kept.
      if (adjustments.length > 0) setPreferenceSaved(true);
    } catch {
      // Dismissing is the common answer and must not be blocked by a failed
      // write; the server will offer the card again next time if it did not
      // record this. But a save the traveller actually made is different —
      // swallowing that is how a rejected preference stayed invisible while
      // the card kept reappearing and the model never saw the answer.
      //
      // Reported as its own message rather than through `setRequestError`:
      // that path words every failure as one about the message just sent, so
      // a rejected preference read as "This message could not be accepted"
      // next to a chat the traveller had not typed in.
      //
      // The card stays up. Clearing it on a rejection left the traveller with
      // a red line and nothing to correct — their answer gone and no way to
      // put it back.
      if (adjustments.length > 0) {
        setPreferenceSaveFailed(true);
        setSavingPreferences(false);
        return;
      }
    }
    setSavingPreferences(false);
    setPreferenceCard(null);
  }

  function captureHighlight(messageId: string) {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? "";
    if (!selection || text.length === 0 || selection.rangeCount === 0) {
      setHighlight(null);
      return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    setHighlight({ text, x: rect.left + rect.width / 2, y: rect.top, messageId });
    setRememberState(null);
  }

  async function rememberSelection() {
    if (!highlight || !api.rememberHighlight) return;
    const selected = highlight;
    setRememberState({ status: "saving" });
    try {
      const result = await api.rememberHighlight({
        highlight: selected.text,
        sourceThreadId: effectiveThreadId ?? null,
        sourceMessageId: selected.messageId,
      });
      // Every branch is an answer worth showing, including the refusals: a
      // highlight past the limit is told so rather than quietly cut.
      const message = result.outcome === "REMEMBERED_FIELD" ? t("rememberedField")
        : result.outcome === "REMEMBERED_NOTE" ? t("rememberedNote", { remaining: result.remaining })
        : result.outcome === "TOO_LONG" ? t("rememberTooLong", { length: result.length, limit: result.limit })
        : result.outcome === "LIST_FULL" ? t("rememberListFull", { limit: result.limit })
        : result.outcome === "SENSITIVE_FIELD" ? t("rememberSensitive")
        : t("rememberFailed");
      setRememberState({ status: "done", message });
    } catch {
      setRememberState({ status: "done", message: t("rememberFailed") });
    }
    setHighlight(null);
    window.getSelection()?.removeAllRanges();
  }

  /**
   * The phrase the card's own hint tells the traveller to type. Matched on the
   * whole message so it cannot fire inside a real question, and answered here
   * rather than sent: there is nothing for the model to do with it.
   */
  function opensPreferenceCard(text: string): boolean {
    return text.trim().toLowerCase() === t("prefCardTrigger").toLowerCase();
  }

  async function reopenPreferenceCard() {
    setPreferenceSaved(false);
    if (!tripId || !api.getPreferenceCard) return;
    try {
      // Whatever applies now, which after an adjustment is the trip's value
      // and not the profile's. `show` is about the first offer; asking for it
      // is its own reason to see it.
      setPreferenceCard(await api.getPreferenceCard(tripId));
    } catch {
      // Nothing to show is better than an error where a card was expected.
    }
  }

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
        <button type="button" onClick={onOpen} data-wanderly-avoid className="absolute bottom-20 right-4 z-40 px-3 py-1.5 text-[11px] font-extrabold wanderly-cosmos-control wanderly-r-xs wanderly-press landscape:bottom-24 landscape:right-6">{t("history")}</button>
        <ThreadStatus status={resolvedThreadStatus} onRetry={onRetryThread} compact />
        <form data-wanderly-perch="composer" data-wanderly-avoid onSubmit={submitMessage} className="absolute bottom-3 left-1/2 z-40 flex min-h-14 w-[calc(100%-3rem)] -translate-x-1/2 items-center gap-2 p-1.5 pl-4 wanderly-cosmos-surface wanderly-r-lg wanderly-shadow sm:left-[94px] sm:right-3 sm:w-auto sm:translate-x-0 landscape:bottom-6 landscape:left-auto landscape:right-6 landscape:w-[min(calc(40vw-1.5rem),calc(66.667dvh-3.5rem),596px)]" aria-label={t("startAria")}>
          <Sparkles aria-hidden="true" className="size-4 shrink-0 text-primary" />
          <input value={draft} disabled={inputDisabled} onChange={(event) => setDraft(event.target.value)} aria-label={t("startInputAria")} placeholder={t("startPlaceholder")} className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-[var(--w-fog)] placeholder:text-[var(--w-space-muted)] focus:outline-none disabled:opacity-60" />
          {submitButton}
        </form>
      </>
    );
  }

  const conversationPanel = (
    <aside role={docked ? undefined : "dialog"} data-wanderly-avoid={docked ? undefined : ""} aria-label={t("dialogAria")} className={docked ? "flex min-h-0 flex-1 flex-col overflow-visible bg-background" : "wanderly-cosmos-chat absolute inset-x-3 bottom-3 z-50 flex h-[60dvh] min-h-[300px] flex-col overflow-hidden text-[var(--w-fog)] wanderly-cosmos-panel wanderly-r-lg sm:left-[94px] sm:right-3 landscape:inset-x-auto landscape:bottom-6 landscape:left-auto landscape:right-6 landscape:h-[min(60vw,calc(100dvh-3rem),852px)] landscape:min-h-0 landscape:w-[min(40vw,calc(66.667dvh-2rem),620px)]"}>
      {/* The panel paints its own deep-space ground, so the inner column stays
          transparent rather than laying a second surface over it. */}
      <div className={`flex min-h-0 flex-1 flex-col overflow-hidden ${docked ? "bg-background" : "bg-transparent"}`}>
        {/* Two controls at the two edges, and nothing between them competing for
            the eye: put the conversation away on the left, open it in the trip
            planner on the right. The agent names itself on every reply, so the
            header repeating the name and the icon was saying it twice. */}
        {docked ? null : (
        <header className="flex items-center gap-2.5 border-b-2 border-[var(--w-space-line)] px-3 pb-2 pt-3">
          <button type="button" onClick={collapseConversation} aria-label={t("collapse")} className="grid size-8 shrink-0 place-items-center wanderly-cosmos-control wanderly-r-xs wanderly-press"><ChevronDown aria-hidden="true" className="size-4" /></button>
          <div className="min-w-0 flex-1" />
          {/* Icon-only, matching the collapse and trip-planner controls either
              side of it. The label stays as the accessible name and tooltip, so
              the control keeps its meaning for a screen reader and on hover. */}
          {onStartNewExploration ? <button type="button" onClick={startNewExploration} disabled={isSending} aria-label={t("startNewExploration")} title={t("startNewExploration")} className="grid size-8 shrink-0 place-items-center wanderly-cosmos-control wanderly-r-xs wanderly-press disabled:cursor-not-allowed disabled:opacity-50"><Plus aria-hidden="true" className="size-4" /></button> : null}
          {tripId && effectiveThreadId ? (
            <Link
              href={`/trips/${tripId}?thread=${effectiveThreadId}` as "/trips/[tripId]"}
              aria-label={t("goToTripPlanner")}
              className="group relative grid size-8 shrink-0 place-items-center wanderly-cosmos-control wanderly-r-xs wanderly-press"
            >
              <ArrowRight aria-hidden="true" className="size-4" />
              <span role="tooltip" className="pointer-events-none absolute right-0 top-[calc(100%+0.5rem)] z-10 w-max px-2 py-1 text-[11px] font-semibold opacity-0 wanderly-cosmos-surface wanderly-r-xs wanderly-shadow-xs transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                {t("goToTripPlanner")}
              </span>
            </Link>
          ) : null}
        </header>
        )}

        <div ref={panelScrollRef} className={docked
          ? "flex-1 overflow-y-auto bg-background px-[clamp(16px,3vw,34px)] pb-10 pt-6 xl:[&>*]:translate-x-1"
          : "flex-1 overflow-y-auto px-5 py-5"} aria-live="polite">
          <ThreadStatus status={resolvedThreadStatus} onRetry={onRetryThread} />
          {conversation.isLoading ? <p role="status" className="text-sm text-muted-foreground">{t("restoring")}</p> : null}
          {!conversation.isLoading && messages.length === 0 && !pendingTurn ? (
            <div className={docked ? "mx-auto flex max-w-[640px] flex-col items-start pb-4 pt-1 text-left" : "mb-4 flex flex-col items-start text-left"}>
              <div aria-hidden="true" className={`mb-2 flex items-center gap-2 ${docked ? "text-primary" : "text-[var(--w-highlight)]"}`}>
                <Sparkles className="size-3.5" />
                <span className="h-px w-8 bg-current opacity-70" />
              </div>
              <p className="max-w-[36rem] text-balance text-base font-bold leading-snug tracking-[-0.025em] text-primary sm:text-lg">
                {t("introTitle")}
              </p>
              <p className={`mt-2 max-w-[36rem] text-pretty text-[13px] leading-5 ${docked ? "text-muted-foreground" : "text-[var(--w-fog)]"}`}>
                {t("introBody")}
              </p>
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
                  <div
                    className={agentBubbleClass}
                    onMouseUp={() => captureHighlight(message.id)}
                    onTouchEnd={() => captureHighlight(message.id)}
                  >
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
              <div className={streamingAgentClass}>
              {streamState.tools.length > 0 ? <ToolActivityList items={streamState.tools} /> : null}
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
                <button type="button" onClick={stopActiveRun} disabled={cancelRun.isPending} className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-card px-3 py-1 text-xs font-bold text-primary disabled:opacity-50">
                  <Square aria-hidden="true" className="size-3 fill-current" />{t("stop")}
                </button>
              </div>
              </div>
            </article>
          ) : isSending ? <p role="status" className={`${rowClass} inline-flex items-center gap-2 text-xs font-semibold text-muted-foreground`}><LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />{t("sending")}</p> : null}
          {visibleError ? (
            <div role="alert" className={`${rowClass} rounded-[16px] border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive`}>
              <p className="font-bold">{errorMessage(visibleError, t)}</p>
              {pendingTurn && isRetryable(visibleError)
                && !(visibleError instanceof AgentRunFailure && !isRetryableFailure(visibleError))
                ? <button type="button" onClick={retryPendingTurn} disabled={isSending} className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-card px-3 py-1.5 text-xs font-bold text-destructive shadow-sm disabled:opacity-50"><RotateCw aria-hidden="true" className="size-3.5" />{t("retry")}</button> : null}
            </div>
          ) : null}
          {briefProposal && tripId ? (
            /* A question with two answers. The primary carries the weight
               because one of them is the decision being invited; the other is
               a way to decline it, not a symmetrical alternative. */
            <section
              aria-label={t("briefProposalTitle")}
              /* The globe uses one compact decision row. The workspace keeps
                 the narrower centred card because it is part of the planner. */
              className={onGlobe
                ? "mb-2 w-full"
                : `mx-auto ${docked ? "mb-[18px]" : ""} w-full max-w-[380px]`}
            >
              <div className={onGlobe ? "grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 py-1" : undefined}>
                <p className={`${onGlobe ? "min-w-0 text-xs leading-4" : "mb-2 px-0.5 text-sm"} font-bold ${docked ? "text-[var(--w-ink)]" : "text-[var(--w-fog)]"}`}>
                  {briefDestination
                    ? t("briefProposalQuestion", { destination: briefDestination })
                    : t("briefProposalQuestionNoDestination")}
                </p>
                <div className={onGlobe ? "contents" : "grid gap-2"}>
                  <button
                    type="button"
                    onClick={() => void confirmBriefProposal()}
                    disabled={isConfirmingBrief}
                    className={onGlobe
                      ? "bg-transparent px-0 py-1 text-xs font-extrabold text-[var(--w-highlight)] underline decoration-1 underline-offset-4 transition-opacity hover:opacity-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--w-highlight)] disabled:opacity-50"
                      : `${actionPrimaryClass} w-full px-3 py-2.5 text-left`}
                  >
                    {briefPrimaryLabel}
                  </button>
                  <button
                    type="button"
                    onClick={() => setBriefProposal(null)}
                    disabled={isConfirmingBrief}
                    className={onGlobe
                      ? "bg-transparent px-0 py-1 text-xs font-extrabold text-[var(--w-fog)] underline decoration-1 underline-offset-4 transition-opacity hover:opacity-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--w-highlight)] disabled:opacity-50"
                      : `${actionSecondaryClass} w-full px-3 py-2.5 text-left`}
                  >
                    {briefSecondaryLabel}
                  </button>
                </div>
              </div>
            </section>
          ) : null}
          {canStartSharedPlanning && !briefProposal ? (
            <section aria-label={t("startSharedPlanTitle")} className={`${docked ? "mx-auto mb-[18px] max-w-[640px]" : "max-w-[86%]"} ${actionCardClass}`}>
              <p className="font-bold text-primary">{t("startSharedPlanTitle")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("startSharedPlanBody")}</p>
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={() => void startSharedPlanning()} disabled={isStartingSharedPlan} className={actionPrimaryClass}>{isStartingSharedPlan ? t("startSharedPlanStarting") : t("startSharedPlanConfirm")}</button>
              </div>
            </section>
          ) : null}
          {showFlightPreferenceCard && tripId ? (
            <section aria-label={t("flightPreferenceTitle")} className={`${docked ? "mx-auto mb-[18px] max-w-[640px]" : "max-w-[86%]"} ${actionCardClass}`}>
              <p className="font-bold text-primary">{t("flightPreferenceTitle")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("flightPreferenceBody")}</p>
              <FlightPreferenceOptions
                draft={flightPreferenceDraft}
                disabled={isSavingFlightPreferences}
                onChange={updateFlightPreference}
                labels={{
                  tripType: t("flightPreferenceTripType"),
                  oneWay: t("flightPreferenceOneWay"),
                  roundTrip: t("flightPreferenceRoundTrip"),
                  adults: t("flightPreferenceAdults"),
                  cabin: t("flightPreferenceCabin"),
                  economy: t("flightPreferenceEconomy"),
                  premiumEconomy: t("flightPreferencePremiumEconomy"),
                  business: t("flightPreferenceBusiness"),
                  first: t("flightPreferenceFirst"),
                  currency: t("flightPreferenceCurrency"),
                }}
              />
              <p className="mt-3 text-xs text-muted-foreground">{t("flightPreferenceDatesNote")}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void saveFlightPreferences()}
                  disabled={isSavingFlightPreferences || !isFlightPreferenceComplete(flightPreferenceDraft)}
                  className={actionPrimaryClass}
                >
                  {isSavingFlightPreferences
                    ? t("flightPreferenceSaving")
                    : flightPreferencesSaved ? t("flightPreferenceUpdate") : t("flightPreferenceSave")}
                </button>
                <button type="button" onClick={() => setShowFlightPreferenceCard(false)} disabled={isSavingFlightPreferences} className={actionSecondaryClass}>{t("flightPreferenceLater")}</button>
              </div>
              {flightPreferencesSaved ? <p role="status" className="mt-2 text-xs font-semibold text-primary">{t("flightPreferenceSaved")}</p> : null}
              {flightPreferenceSaveError ? <p role="alert" className="mt-2 text-xs text-destructive">{errorMessage(flightPreferenceSaveError, t)}</p> : null}
            </section>
          ) : null}
          {/* Only once the turn is over. The tool settles mid-reply, so the
              card used to slide in under a half-written answer and then sit
              there through the next turn's "thinking…" — pressing Search left
              it on screen while the search it had just authorised ran.
              `activeRunId` clears when the run completes, so this both waits
              for the answer to finish and takes the card away the moment the
              traveller acts on it. */}
          {pendingFlightConfirmation && !isSending ? (
            <section aria-label={t("flightConfirmTitle")} className={`${docked ? "mx-auto mb-[18px] max-w-[640px]" : "max-w-[86%]"} ${actionCardClass}`}>
              <p className="font-bold text-primary">{t("flightConfirmTitle")}</p>
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={confirmFlightSearch} disabled={isSending} className={actionPrimaryClass}>{t("flightConfirmButton")}</button>
                <button type="button" onClick={cancelFlightSearch} disabled={isSending} className={actionSecondaryClass}>{t("flightCancelButton")}</button>
              </div>
            </section>
          ) : null}
          {/* Quick orchestration — server-managed pinned session card.
              Surfaces the latest owner-accepted terminal run. Renders only
              when (a) we are bound to a trip, (b) the server has pinned a
              session, and (c) the current view is not mid-classification
              for an unrelated draft. The card is read-only — no manual
              pin/unpin UI in MVP. */}
          {tripId && pinnedSession ? (
            <div className={`${docked ? "mx-auto mb-[18px] max-w-[640px]" : "max-w-[86%]"}`}>
              <PinnedResultCard tripId={tripId} pinned={pinnedSession} />
            </div>
          ) : null}
          {tripId && handoffBatchId && !handoffDismissed ? (
            <div className={`${docked ? "mx-auto mb-[18px] max-w-[640px]" : "max-w-[86%]"}`}>
              <HandoffCardHost
                tripId={tripId}
                batchId={handoffBatchId}
                onConfirmed={(result) => {
                  setHandoffBatchId(null);
                  setHandoffDismissed(false);
                  // Surface the new run to the workspace so it can decide
                  // whether to auto-switch the triggering user to the shared
                  // surface (only when the run is already terminal, §1.7).
                  onSharedRunStarted?.({
                    runId: result.runId,
                    operation: result.operation,
                  });
                }}
                onDismissed={() => setHandoffDismissed(true)}
              />
            </div>
          ) : null}
          {preferenceCard ? (
            <TripPreferenceCard
              fields={preferenceCard.fields}
              saving={savingPreferences}
              onSubmit={(adjustments) => void resolvePreferences(adjustments)}
            />
          ) : null}
          {preferenceSaveFailed ? (
            <p role="alert" className={`${docked ? "mx-auto mb-[18px] max-w-[640px]" : "max-w-[86%]"} rounded-[18px] border border-destructive/20 bg-destructive/5 p-3 text-xs font-bold text-destructive`}>
              {t("prefCardSaveFailed")}
            </p>
          ) : null}
          {preferenceSaved ? (
            <p role="status" className={`${docked ? "mx-auto mb-[18px] max-w-[640px]" : "max-w-[86%]"} text-xs font-semibold text-primary`}>
              {t("prefCardSaved")}
            </p>
          ) : null}
          {/* Sits at the selection, not in the flow: it has to be reachable
              without clicking anywhere else, because clicking clears the
              selection it is about to act on. `onMouseDown` + preventDefault
              keeps the selection alive long enough for the click. */}
          {highlight ? (
            <button
              type="button"
              data-testid="remember-highlight"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void rememberSelection()}
              style={{ position: "fixed", left: highlight.x, top: Math.max(highlight.y - 44, 8), transform: "translateX(-50%)", zIndex: 60 }}
              className={docked
                ? "px-3 py-1.5 text-[11px] font-extrabold wanderly-edge-thin wanderly-r-xs wanderly-shadow-xs wanderly-press wanderly-action"
                : "rounded-full bg-primary px-3 py-1.5 text-[11px] font-bold text-[var(--w-ink)] shadow-md"}
            >
              {rememberState?.status === "saving" ? t("rememberSaving") : t("rememberHighlight")}
            </button>
          ) : null}
          {rememberState?.status === "done" && rememberState.message ? (
            <p
              role="status"
              data-testid="remember-result"
              className={`${docked ? "mx-auto mb-[18px] max-w-[640px]" : "max-w-[86%]"} text-xs font-semibold text-muted-foreground`}
            >
              {rememberState.message}
            </p>
          ) : null}
          {/* A research run has stages; an ordinary chat turn has none, and
              this was rendering "研究运行 #… / 等待阶段…" under every reply for
              a run that was never going to report a stage. */}
          {activeRunId && (researchStages.length > 0 || researchOutcome) ? (
            <div className={`${docked ? "mx-auto mb-[18px] max-w-[640px]" : "max-w-[86%]"}`}>
              <ResearchRunCard
                runId={activeRunId}
                stages={researchStages}
                outcome={researchOutcome}
              />
              {/* Post-P0 (planner-resilience §3.5): when the run finishes with a
                  plan but with capability gaps, or finishes with no plan at all
                  (research-summary branch), surface that explicitly in the chat
                  rather than letting the user infer it from `resultPlanId`. */}
              {(() => {
                const run = agentRun.data;
                if (!run || run.status === "RUNNING" || run.status === "QUEUED") return null;
                if (run.status === "COMPLETED_WITH_GAPS" && run.resultPlanId !== null) {
                  return (
                    <p role="status" className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      {t("planningCompletedWithGaps.message", {
                        gaps: t("planningCompletedWithGaps.detail"),
                      })}
                    </p>
                  );
                }
                if (run.status === "COMPLETED_WITH_GAPS" && run.resultPlanId === null) {
                  return (
                    <p role="status" className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      {t("planningResearchSummaryOnly.message", {
                        reason: t("planningResearchSummaryOnly.reasonFlight"),
                      })}
                    </p>
                  );
                }
                return null;
              })()}
            </div>
          ) : null}
        </div>
      </div>

      <form data-testid={docked ? "docked-chat-composer" : undefined} onSubmit={submitMessage} className={docked ? "relative z-10 mx-[clamp(16px,3vw,34px)] mb-5 xl:translate-x-1" : "border-t-2 border-[var(--w-space-line)] px-3 pb-3 pt-2"}>
        {selectedPlace ? <button type="button" onClick={askAboutSelectedPlace} className={`mb-1.5 flex h-6 max-w-full items-center px-2.5 text-[10px] font-extrabold wanderly-r-xs wanderly-press ${docked ? "bg-[var(--w-mist)] text-primary wanderly-edge-thin" : "wanderly-cosmos-control"}`}><span className="truncate">{t("askAbout", { name: selectedPlace.place.name, context: selectedPlace.context })}</span></button> : null}
        <div className={`${docked ? "mx-auto max-w-[640px]" : ""} flex min-h-14 items-center gap-2 p-1.5 pl-4 ${surfaceClass} wanderly-r-md wanderly-shadow-sm`}>
          <textarea ref={panelInputRef} value={draft} disabled={inputDisabled} rows={1} enterKeyHint="send" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !isComposingKey(event)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} aria-label={t("messageInputAria")} placeholder={t("messagePlaceholder")} className={docked ? "max-h-[100px] min-w-0 flex-1 resize-none bg-transparent text-sm font-semibold leading-[1.4] text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-60" : "min-w-0 flex-1 resize-none bg-transparent text-sm font-semibold text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-60"} />
          {submitButton}
        </div>
      </form>
    </aside>
  );

  return conversationPanel;
}

function isFlightPreferenceComplete(draft: FlightPreferenceDraft): draft is Required<FlightPreferenceDraft> {
  return Boolean(draft.tripType && draft.adults && draft.cabin && draft.currency);
}

function FlightPreferenceOptions({
  draft,
  disabled,
  onChange,
  labels,
}: {
  draft: FlightPreferenceDraft;
  disabled: boolean;
  onChange: <K extends keyof FlightPreferenceDraft>(key: K, value: FlightPreferenceDraft[K]) => void;
  labels: {
    tripType: string;
    oneWay: string;
    roundTrip: string;
    adults: string;
    cabin: string;
    economy: string;
    premiumEconomy: string;
    business: string;
    first: string;
    currency: string;
  };
}) {
  const chipClass = (selected: boolean) => `min-h-8 px-2.5 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50 ${selected
    ? "bg-primary text-[var(--w-ink)]"
    : "border border-primary/20 bg-card text-primary hover:bg-secondary"}`;
  return (
    <div className="mt-3 grid gap-3">
      <fieldset disabled={disabled}>
        <legend className="mb-1.5 text-xs font-bold text-foreground">{labels.tripType}</legend>
        <div className="flex flex-wrap gap-2">
          <button type="button" aria-pressed={draft.tripType === "ONE_WAY"} onClick={() => onChange("tripType", "ONE_WAY")} className={chipClass(draft.tripType === "ONE_WAY")}>{labels.oneWay}</button>
          <button type="button" aria-pressed={draft.tripType === "ROUND_TRIP"} onClick={() => onChange("tripType", "ROUND_TRIP")} className={chipClass(draft.tripType === "ROUND_TRIP")}>{labels.roundTrip}</button>
        </div>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend className="mb-1.5 text-xs font-bold text-foreground">{labels.adults}</legend>
        <div className="flex flex-wrap gap-2">
          {[1, 2, 3, 4].map((adults) => <button key={adults} type="button" aria-pressed={draft.adults === adults} onClick={() => onChange("adults", adults)} className={chipClass(draft.adults === adults)}>{adults}</button>)}
        </div>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend className="mb-1.5 text-xs font-bold text-foreground">{labels.cabin}</legend>
        <div className="flex flex-wrap gap-2">
          {([
            ["ECONOMY", labels.economy],
            ["PREMIUM_ECONOMY", labels.premiumEconomy],
            ["BUSINESS", labels.business],
            ["FIRST", labels.first],
          ] as const).map(([cabin, label]) => <button key={cabin} type="button" aria-pressed={draft.cabin === cabin} onClick={() => onChange("cabin", cabin)} className={chipClass(draft.cabin === cabin)}>{label}</button>)}
        </div>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend className="mb-1.5 text-xs font-bold text-foreground">{labels.currency}</legend>
        <div className="flex flex-wrap gap-2">
          {(["SGD", "USD", "CNY"] as const).map((currency) => <button key={currency} type="button" aria-pressed={draft.currency === currency} onClick={() => onChange("currency", currency)} className={chipClass(draft.currency === currency)}>{currency}</button>)}
        </div>
      </fieldset>
    </div>
  );
}

/**
 * The thread banner, and the only place that decides whether there is
 * anything worth saying. `ready` needs no banner, and neither does `idle`:
 * the composer's own placeholder already invites the first message, so a
 * standing notice there would just occupy the corner of the map saying
 * nothing.
 */
function ThreadStatus({ status, onRetry, compact = false }: { status: ChatThreadStatus; onRetry?: () => void; compact?: boolean }) {
  const t = useTranslations("explore.chat");
  if (status === "ready" || status === "idle") return null;
  const message = status === "preparing" ? t("preparingPrivateChat") : t("privateChatUnavailable");
  return (
    <div role="status" data-wanderly-avoid={compact ? "" : undefined} className={compact ? "absolute bottom-20 left-4 z-40 flex items-center gap-2 px-3 py-1.5 text-[11px] font-semibold wanderly-cosmos-panel wanderly-r-xs sm:left-[94px] landscape:bottom-24 landscape:left-auto landscape:right-[8.5rem]" : "bg-card p-3 text-sm text-muted-foreground wanderly-edge-thin wanderly-r-sm wanderly-shadow-xs"}>
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
      className="absolute -bottom-1 right-2 grid size-7 place-items-center rounded-lg border border-transparent bg-transparent text-muted-foreground/0 transition group-hover/msg:border-border group-hover/msg:bg-card group-hover/msg:text-muted-foreground group-hover/msg:shadow-sm focus-visible:border-border focus-visible:bg-card focus-visible:text-muted-foreground focus-visible:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
    >
      {copied ? <Check aria-hidden="true" className="size-3.5 text-primary" /> : <Copy aria-hidden="true" className="size-3.5" />}
    </button>
  );
}

/**
 * Keyed by viewer: two accounts on one browser each get their own pointer,
 * so signing in as someone else cannot hand you a run you are not allowed to
 * read — which answers 403 and used to leave the chat wedged on "thinking".
 */
function activeRunKey(): string {
  return viewerScopedKey(CHAT_ACTIVE_RUN_STORAGE_KEY);
}

function readStoredActiveRunId(): string | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage.getItem(activeRunKey()); } catch { return null; }
}

function storeActiveRunId(runId: string) {
  try { window.localStorage.setItem(activeRunKey(), runId); } catch { /* optional pointer */ }
}

function clearStoredActiveRunId() {
  try { window.localStorage.removeItem(activeRunKey()); } catch { /* optional pointer */ }
}

function mergeMessages(current: ConversationMessage[], incoming: ConversationMessage[]) {
  const messages = new Map(current.map((message) => [message.id, message]));
  incoming.forEach((message) => messages.set(message.id, message));
  return [...messages.values()].sort((a, b) => a.sequence - b.sequence);
}

function emptyStreamState(): StreamState {
  return { attempt: 0, nextSequence: 0, pending: {}, text: "", phase: null, tools: [] };
}

function applyStreamEvent(current: StreamState, event: AgentStreamEvent): StreamState {
  if (event.generationAttempt < current.attempt) return current;
  const base = event.generationAttempt > current.attempt
    ? { ...emptyStreamState(), attempt: event.generationAttempt }
    : current;
  if (event.event === "run.phase") return { ...base, phase: event.phase };
  if (event.event === "tool.started") {
    return { ...base, tools: [...base.tools, { capability: event.capability, outcome: "RUNNING" }] };
  }
  if (event.event === "tool.settled") {
    // Settle the newest still-running entry for this capability. The same
    // tool can legitimately run twice in one reply with different arguments,
    // and settling the oldest would leave the wrong one spinning.
    const index = findLastRunning(base.tools, event.capability);
    if (index < 0) return base;
    const tools = [...base.tools];
    tools[index] = {
      capability: event.capability,
      outcome: event.outcome,
      ...(event.currency ? { currency: event.currency } : {}),
      ...(event.flightOffers ? { flightOffers: event.flightOffers } : {}),
      ...(event.hotelOffers ? { hotelOffers: event.hotelOffers } : {}),
    };
    return { ...base, tools };
  }
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

function findLastRunning(tools: ToolActivity[], capability: string): number {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    if (tools[index].capability === capability && tools[index].outcome === "RUNNING") return index;
  }
  return -1;
}

/**
 * The lookups behind the reply being composed.
 *
 * Above the text because that is the order they happened in: the assistant
 * looked things up, then wrote. Settled rows stay — "found nothing" is what
 * lets a reader judge the answer that follows.
 */
function ToolActivityList({ items }: { items: ToolActivity[] }) {
  const t = useTranslations("explore.chat.tools");
  return (
    <div className="mb-2 grid gap-2 border-b border-[var(--w-line)] pb-2">
      <ul aria-label={t("heading")} className="grid gap-1">
        {items.map((item, index) => (
          <li
            key={`${item.capability}-${index}`}
            data-capability={item.capability}
            data-outcome={item.outcome}
            className="flex items-center gap-2 text-[11px] font-semibold text-muted-foreground"
          >
            <span aria-hidden="true" className={item.outcome === "RUNNING" ? "size-[5px] shrink-0 animate-pulse rounded-full bg-primary motion-reduce:animate-none" : "size-[5px] shrink-0 rounded-full bg-[var(--w-line)]"} />
            <span className="min-w-0 truncate">{t(`capability.${item.capability.replace(".", "_")}` as "capability.places_search")}</span>
            <span className="ml-auto shrink-0 text-[10px] font-black uppercase tracking-[0.08em]">
              {t(`outcome.${item.outcome}` as "outcome.RUNNING")}
            </span>
          </li>
        ))}
      </ul>
      {/* Structured result cards for the two capabilities with real
          per-offer evidence. Rendered right under their activity row so the
          reader sees the concrete offers before the prose summary below. */}
      {items.flatMap((item, index) => {
        const currency = item.currency ?? "USD";
        if (item.flightOffers?.length) {
          return [<div key={`flight-offers-${index}`} className="grid gap-2">{item.flightOffers.map((offer, i) => <FlightOfferCard key={i} offer={offer} currency={currency} />)}</div>];
        }
        if (item.hotelOffers?.length) {
          return [<div key={`hotel-offers-${index}`} className="grid gap-2">{item.hotelOffers.map((offer, i) => <SearchHotelOfferCard key={i} offer={offer} currency={currency} />)}</div>];
        }
        return [];
      })}
    </div>
  );
}

class AgentRunFailure extends Error {
  constructor(
    readonly operation: string,
    readonly errorCode: string | null,
  ) {
    super(`Agent run failed (${operation}${errorCode ? `: ${errorCode}` : ""})`);
    this.name = "AgentRunFailure";
  }
}

function isRetryable(error: unknown) {
  return !(error instanceof TravelApiError) || error.statusCode === null || [404, 500, 502, 504].includes(error.statusCode);
}

function isRetryableFailure(error: AgentRunFailure): boolean {
  // RATE_LIMITED is absent on purpose: the quota does not come back because
  // someone pressed a button again.
  return error.errorCode === null
    || ["NETWORK", "UPSTREAM_5XX", "UPSTREAM_FAILURE", "TIMEOUT", "INTERNAL"].includes(error.errorCode);
}

function errorMessage(error: unknown, t: ReturnType<typeof useTranslations>) {
  if (error instanceof AgentRunFailure) {
    const planning = error.operation !== "CONVERSATION";
    if (error.errorCode === "RATE_LIMITED") return planning ? t("planningRateLimited") : t("providerUnavailable");
    if (error.errorCode === "PLANNING_DATA_UNAVAILABLE") return t("planningDataUnavailable");
    if (error.errorCode === "POLICY_DENIED") return t("planningNotAllowed");
    if (error.errorCode === "SEARCH_PREFERENCES_STALE") return t("planningPreferencesChanged");
    if (error.errorCode === "TOOL_CALL_MAX_TURNS") return t("planningToolBudgetExhausted");
    if (["NETWORK", "UPSTREAM_5XX", "UPSTREAM_FAILURE", "TIMEOUT"].includes(error.errorCode ?? "")) {
      return planning ? t("planningProviderUnavailable") : t("providerUnavailable");
    }
    // `genericError` — "the message could not be sent" — is never true on this
    // path. An AgentRunFailure means a run row exists, so the message was
    // accepted and stored; whatever failed, failed after that. INTERNAL gets
    // its own copy because it is a server-side fault the traveller cannot act
    // on, and `isRetryableFailure` already withholds the Retry button for it.
    if (error.errorCode === "INTERNAL") return planning ? t("planningFailed") : t("conversationInternalError");
    return planning ? t("planningFailed") : t("conversationFailed");
  }
  if (error instanceof TravelApiError) {
    if (error.statusCode === null) return t("networkError");
    if (error.statusCode === 401 || error.statusCode === 403) return t("authenticationRequired");
    if (error.statusCode === 502 || error.statusCode === 504) return t("providerUnavailable");
    if (error.statusCode === 404) return t("threadMissing");
    if (error.statusCode === 409) return t("conversationBusy");
    if (error.statusCode === 400 || error.statusCode === 422) return t("requestInvalid");
  }
  return t("genericError");
}

/**
 * Member conversation handoff host.
 *
 * The chat receives a `batchId` from the SSE event. We pull the batch via
 * React Query; the card itself does the selection UI and the confirm call.
 * On confirm or dismiss we drop the host so the message flow returns to
 * normal; the server-side mutation has already invalidated the affected
 * query keys (constraints / plans).
 */
function HandoffCardHost({
  tripId,
  batchId,
  onConfirmed,
  onDismissed,
}: {
  tripId: string;
  batchId: string;
  onConfirmed: (result: ConstraintHandoffConfirmResponse) => void;
  onDismissed: () => void;
}) {
  // Same as conversation-handoff-card: the `handoff*` strings are under
  // `teamOrchestration`; `trips.workspace` has none of them.
  const t = useTranslations("teamOrchestration");
  const batch = useConstraintHandoffBatch(tripId, batchId);
  if (batch.isLoading) {
    return (
      <div data-testid="handoff-card-loading" className="rounded-[18px] border border-border bg-card/60 p-3 text-xs text-muted-foreground">
        {t("handoffLoading")}
      </div>
    );
  }
  if (batch.error) {
    return (
      <div role="alert" data-testid="handoff-card-error" className="rounded-[18px] border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">
        {t("handoffLoadError")}
      </div>
    );
  }
  if (!batch.data) return null;
  return (
    <ConversationHandoffCard
      tripId={tripId}
      batch={batch.data}
      onConfirmed={onConfirmed}
      onDismissed={onDismissed}
    />
  );
}
