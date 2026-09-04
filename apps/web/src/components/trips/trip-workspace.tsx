"use client";

import { ExternalLink, PanelRight, Pencil, Plus, UserPlus, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { TravelAgentChat, type ChatThreadStatus } from "@/components/explore/travel-agent-chat";
import { TripMiniGlobe } from "@/components/trips/trip-mini-globe";
import { SharedPlanView } from "@/components/trips/shared-plan/shared-plan-view";
import { ResearchGapBanner } from "@/components/trips/research-gap-banner";
import { ErrorState, LoadingState } from "@/components/ui/data-state";
import { Link, useRouter } from "@/i18n/navigation";
import { recordUiDiagnostic } from "@/lib/observability/ui-diagnostics";
import {
  useCreateTripThread,
  useGetOrCreateDefaultTripThread,
  useLatestResearchResult,
  useLatestPlanningRun,
  useRenameThread,
  useSuggestThreadTitle,
  useTrip,
  useTripPlans,
  useTripThreads,
  useUpdateDraftTripBrief,
  useUpdateTripTitle,
} from "@/lib/query/hooks";
import { TravelApiError } from "@/lib/api/errors";
import { readLastSeenVersion } from "@/lib/trips/shared-plan-read-state";

const DEFAULT_THREAD_QUERY = "thread";
const SHARED_VIEW_QUERY = "view";
const SHARED_VIEW_VALUE = "shared";

function isUnauthorizedOrRevoked(error: unknown): boolean {
  if (!(error instanceof TravelApiError)) return false;
  if (error.isUnauthorized) return true;
  return error.statusCode === 410;
}

export function TripWorkspace({ tripId }: { tripId: string }) {
  const t = useTranslations("trips");
  const tCommon = useTranslations("common");
  const tShared = useTranslations("trips.sharedPlan");
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryThreadId = searchParams.get(DEFAULT_THREAD_QUERY);
  const querySharedView = searchParams.get(SHARED_VIEW_QUERY) === SHARED_VIEW_VALUE;

  const tripQuery = useTrip(tripId);
  const threadsQuery = useTripThreads(tripId);
  const plansQuery = useTripPlans(tripId);
  const createThread = useCreateTripThread(tripId);
  const ensureDefault = useGetOrCreateDefaultTripThread(tripId);
  const updateTitle = useUpdateTripTitle(tripId);
  const renameThread = useRenameThread(tripId);
  const suggestTitle = useSuggestThreadTitle(tripId);
  const [editingTitle, setEditingTitle] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  // Per-thread UI state for the rail overflow menu + inline rename form.
  const [openMenuFor, setOpenMenuFor] = useState<string | null>(null);
  const [renamingFor, setRenamingFor] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [aiNameFeedback, setAiNameFeedback] = useState<
    { threadId: string; reason: "MANUAL_LOCKED" | "NO_MATERIAL" | "REJECTED" | "UNAVAILABLE" } | null
  >(null);

  const autoProvisionAttemptedRef = useRef(false);

  // Derive membership-revoked state directly from the trip detail query
  // result instead of mirroring it into a `useState` — this avoids a
  // cascading render and keeps the failure path obvious in JSX.
  const membershipRevoked = useMemo(
    () => Boolean(tripQuery.error && isUnauthorizedOrRevoked(tripQuery.error)),
    [tripQuery.error],
  );

  const threads = useMemo(
    () => threadsQuery.data?.threads ?? [],
    [threadsQuery.data?.threads],
  );

  const activeThread = useMemo(() => {
    if (!queryThreadId) return null;
    return threads.find((thread) => thread.id === queryThreadId) ?? null;
  }, [queryThreadId, threads]);

  /**
   * Unlike the exploration surface, the workspace never rests without a
   * thread: it either has one, is fetching the list, or is auto-provisioning
   * the default below. So every non-ready, non-failed state here really is
   * work in flight and is reported as `preparing`.
   *
   * Passed explicitly rather than left to the chat's own default, which
   * cannot tell "no thread yet" from "thread on its way".
   */
  const chatThreadStatus = useMemo<ChatThreadStatus>(() => {
    if (activeThread) return "ready";
    // The rail already renders this failure in full; the chat panel only
    // needs to stop claiming a thread is coming.
    if (threadsQuery.isError) return "error";
    return "preparing";
  }, [activeThread, threadsQuery.isError]);

  const liveThreads = useMemo(() => threads.filter((thread) => !thread.archivedAt), [threads]);
  const archivedThreads = useMemo(() => threads.filter((thread) => !!thread.archivedAt), [threads]);

  // Phase 4 — unread badge on the rail pinned entry. Computed here (above
  // the early returns) so the hooks order stays stable for the rest of
  // the render. The badge reads the same `plansQuery` already mounted by
  // the shared view, so this introduces no extra HTTP request.
  const hasUnreadSharedPlan = useMemo(() => {
    const plans = plansQuery.data;
    if (!plans) return false;
    const maxVersion = Math.max(
      0,
      ...plans.proposed.map((p) => p.version),
      ...plans.active.map((p) => p.version),
      ...plans.stale.map((p) => p.version),
    );
    if (maxVersion === 0) return false;
    return maxVersion > readLastSeenVersion(tripId);
  }, [plansQuery.data, tripId]);

  // Auto-provision: when the threads list is loaded and empty, get or
  // create the caller's default scratchpad in a single round trip.
  // Per docs/trip-scoped-private-threads-implementation.md §8.1, this is
  // the documented UX — the workspace always lands on a thread.
  // The ref guard keeps the effect from re-firing across renders.
  useEffect(() => {
    if (autoProvisionAttemptedRef.current) return;
    if (!threadsQuery.data) return;
    if (threads.length !== 0) return;
    autoProvisionAttemptedRef.current = true;
    void ensureDefault.mutateAsync()
      .then((created) => {
        if (queryThreadId !== created.id) {
          const params = new URLSearchParams(searchParams.toString());
          params.set(DEFAULT_THREAD_QUERY, created.id);
          router.replace(`/trips/${tripId}?${params.toString()}` as Parameters<typeof router.replace>[0]);
        }
      })
      .catch(() => {
        // surfaced through threadsQuery / tripQuery error states; no
        // additional UX noise here.
      });
  }, [threadsQuery.data, threads.length, ensureDefault, queryThreadId, router, searchParams, tripId]);

  // If the URL points at a thread that is no longer in our list (it was
  // deleted or it belongs to a different trip), fall back to the most
  // recent default or first thread and patch the URL.
  //
  // Skip when the URL selects `view=shared`: the shared surface is
  // intentionally thread-less (see docs/shared-plan-surface-implementation.md
  // §1.1), so the fallback would otherwise bounce the user out of the
  // shared view every time a thread disappears.
  useEffect(() => {
    if (!threadsQuery.data) return;
    if (membershipRevoked) return;
    if (querySharedView) return;
    const knownIds = new Set(threads.map((thread) => thread.id));
    if (queryThreadId && knownIds.has(queryThreadId)) return;
    if (threads.length === 0) return;
    const fallback = threads.find((thread) => thread.isDefault) ?? threads[0];
    const params = new URLSearchParams(searchParams.toString());
    params.set(DEFAULT_THREAD_QUERY, fallback.id);
    router.replace(`/trips/${tripId}?${params.toString()}` as Parameters<typeof router.replace>[0]);
  }, [threads, threadsQuery.data, queryThreadId, querySharedView, router, searchParams, tripId, membershipRevoked]);

  // "New thread" opens a fresh session straight away — no title prompt.
  // The server is the authority on the auto-numbered title; the client only
  // sends its locale so the server can pick the right language family
  // (docs/thread-title-lifecycle-implementation.md D1 + §7.3).
  const handleCreateThread = useCallback(async () => {
    if (createThread.isPending) return;
    try {
      const created = await createThread.mutateAsync({
        titleLocale: locale === "zh" ? "zh" : "en",
      });
      const params = new URLSearchParams(searchParams.toString());
      params.delete(SHARED_VIEW_QUERY);
      params.set(DEFAULT_THREAD_QUERY, created.id);
      router.push(`/trips/${tripId}?${params.toString()}` as Parameters<typeof router.push>[0]);
    } catch {
      // surfaced through the threads query error state.
    }
  }, [createThread, locale, router, searchParams, tripId]);

  // Select the shared plan surface in the rail. Mutually exclusive with
  // the `thread=` query parameter (spec §1.9): setting one clears the
  // other, so a refresh cannot land the user in a half-selected state.
  const handleSelectSharedView = useCallback(() => {
    recordUiDiagnostic("shared_plan.view_open");
    const params = new URLSearchParams(searchParams.toString());
    params.delete(DEFAULT_THREAD_QUERY);
    params.set(SHARED_VIEW_QUERY, SHARED_VIEW_VALUE);
    router.push(`/trips/${tripId}?${params.toString()}` as Parameters<typeof router.push>[0]);
  }, [router, searchParams, tripId]);

  // Phase 2 — auto-switch the triggering user to the shared view when
  // the run they just kicked off reaches a terminal status. The decision
  // belongs to the workspace (URL + state), not the chat card; the chat
  // only announces that a run was queued.
  //
  // §1.7: only the triggering user is auto-switched; other members
  // discover the same run via the rail's 60s polling / unread badge.
  // §1.7 cont.: the switch is gated on the run reaching a terminal
  // status — switching mid-run would pre-empt the chat input draft.
  const latestRun = useLatestPlanningRun(tripId, { enabled: true });
  const triggerRunIdRef = useRef<string | null>(null);
  const handleSharedRunStarted = useCallback((input: { runId: string; operation: "PLAN" | "REPLAN" }) => {
    triggerRunIdRef.current = input.runId;
  }, []);
  useEffect(() => {
    const triggerId = triggerRunIdRef.current;
    if (!triggerId) return;
    if (querySharedView) {
      // Already on the shared view; clear the latch so a later manual
      // exit doesn't accidentally re-trigger the auto-switch.
      triggerRunIdRef.current = null;
      return;
    }
    const observed = latestRun.data?.run;
    if (!observed || observed.runId !== triggerId) return;
    const terminal = observed.status === "COMPLETED"
      || observed.status === "COMPLETED_WITH_GAPS"
      || observed.status === "FAILED"
      || observed.status === "CANCELLED"
      || observed.status === "STALE";
    if (!terminal) return;
    triggerRunIdRef.current = null;
    const params = new URLSearchParams(searchParams.toString());
    params.delete(DEFAULT_THREAD_QUERY);
    params.set(SHARED_VIEW_QUERY, SHARED_VIEW_VALUE);
    router.push(`/trips/${tripId}?${params.toString()}` as Parameters<typeof router.push>[0]);
  }, [latestRun.data, querySharedView, router, searchParams, tripId]);

  // Rail-level actions. The overflow menu is per-thread; the inline rename
  // form replaces the title cell while active so the rail keeps a single
  // visual line. Declared before the early returns below so the hook count
  // stays stable across all render paths.
  const beginRename = useCallback((thread: (typeof threads)[number]) => {
    setOpenMenuFor(null);
    setRenamingFor(thread.id);
    setRenameDraft(thread.title);
    setAiNameFeedback(null);
  }, []);
  const cancelRename = useCallback(() => {
    setRenamingFor(null);
    setRenameDraft("");
  }, []);
  const submitRename = useCallback(async (threadId: string) => {
    const trimmed = renameDraft.trim();
    if (!trimmed) return;
    try {
      await renameThread.mutateAsync({ threadId, input: { title: trimmed } });
      cancelRename();
    } catch {
      // surfaced via the threads query error state; keep the form open so the
      // user can retry without retyping.
    }
  }, [cancelRename, renameDraft, renameThread]);

  const triggerAiName = useCallback(async (thread: (typeof threads)[number]) => {
    setOpenMenuFor(null);
    setAiNameFeedback(null);
    const overwriteManual = thread.titleSource === "MANUAL"
      ? window.confirm(t("threads.aiName.overwriteConfirm"))
      : false;
    if (thread.titleSource === "MANUAL" && !overwriteManual) {
      setAiNameFeedback({ threadId: thread.id, reason: "MANUAL_LOCKED" });
      return;
    }
    try {
      const result = await suggestTitle.mutateAsync({
        threadId: thread.id,
        input: {
          requestId: crypto.randomUUID(),
          locale: locale === "zh" ? "zh" : "en",
          overwriteManual,
        },
      });
      if (!result.applied && result.reason) {
        setAiNameFeedback({ threadId: thread.id, reason: result.reason });
      }
    } catch {
      setAiNameFeedback({ threadId: thread.id, reason: "UNAVAILABLE" });
    }
  }, [locale, suggestTitle, t]);

  if (membershipRevoked) {
    return (
      <main className="mx-auto flex min-h-[60vh] w-full max-w-[640px] flex-col items-center justify-center gap-4 px-5 py-12 text-center">
        <h1 className="text-2xl font-bold tracking-tight">{t("errors.membershipRevoked")}</h1>
        <Link href="/home" className="inline-flex min-h-11 items-center gap-2 rounded-xl font-semibold text-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30">
          {t("backToHome")}
        </Link>
      </main>
    );
  }

  if (tripQuery.isPending) {
    return (
      <main className="mx-auto w-full max-w-[1240px] px-5 py-8 sm:px-8 md:px-[clamp(2rem,4vw,3.5rem)] md:py-[42px]">
        <LoadingState label={tCommon("loadingTrips")} />
      </main>
    );
  }

  if (tripQuery.isError) {
    return (
      <main className="mx-auto w-full max-w-[1240px] px-5 py-8 sm:px-8 md:px-[clamp(2rem,4vw,3.5rem)] md:py-[42px]">
        <ErrorState error={tripQuery.error} title={t("notFound")} />
      </main>
    );
  }

  const trip = tripQuery.data?.trip;
  const callerRole = tripQuery.data?.callerRole ?? "MEMBER";
  if (!trip) {
    return (
      <main className="mx-auto w-full max-w-[1240px] px-5 py-8 sm:px-8 sm:px-8 md:px-[clamp(2rem,4vw,3.5rem)] md:py-[42px]">
        <p className="text-sm text-muted-foreground">{t("notFound")}</p>
      </main>
    );
  }

  const members = tripQuery.data?.members ?? [];
  const datesLabel = trip.travelDateStart && trip.travelDateEnd
    ? t("header.datesRange", { start: trip.travelDateStart, end: trip.travelDateEnd })
    : t("header.datesUnknown");
  // Both used to fall back to the *dates* string, so an empty departure and an
  // empty destination list each read "Dates not set" — under headings that say
  // nothing about dates.
  const destinationsLabel = trip.destinationCandidates.length > 0
    ? trip.destinationCandidates.join(" · ")
    : t("header.placeUnknown");
  const departureLabel = trip.departureCities.length > 0
    ? trip.departureCities.join(" · ")
    : t("header.placeUnknown");

  // Phase 4 — unread badge on the rail pinned entry. The computation is
  // hoisted to the top of the render (above the early returns) so the
  // hooks order stays stable; see the early definition for details.

  // Every place the selected plan touches; the globe merges these onto countries.
  const globePlaces = [...trip.departureCities, ...trip.destinationCandidates];

  // Rail-level actions were hoisted above the early returns to keep the
  // hook order stable. The renderThread function is defined further below
  // and closes over the hooks defined here.

  const renderThread = (thread: (typeof threads)[number]) => {
    const selected = thread.id === activeThread?.id;
    const menuOpen = openMenuFor === thread.id;
    const renaming = renamingFor === thread.id;
    const feedback = aiNameFeedback?.threadId === thread.id ? aiNameFeedback : null;
    return (
      <li key={thread.id} className="relative">
        <button
          type="button"
          onClick={() => {
            if (renaming) return; // don't navigate while the inline form is open
            const params = new URLSearchParams(searchParams.toString());
            // Picking a thread clears `view=shared`; the two are mutually
            // exclusive (§1.9 / §7.1).
            params.delete(SHARED_VIEW_QUERY);
            params.set(DEFAULT_THREAD_QUERY, thread.id);
            setInspectorOpen(false);
            router.push(`/trips/${tripId}?${params.toString()}` as Parameters<typeof router.push>[0]);
          }}
          aria-current={selected ? "page" : undefined}
          className={`relative min-h-[82px] w-full bg-card px-3 py-[11px] text-left text-[var(--w-ink)] wanderly-edge wanderly-r-md wanderly-press ${selected ? "bg-[var(--w-highlight)] wanderly-shadow" : "wanderly-shadow-sm hover:bg-[var(--w-mist)]"}`}
        >
          {renaming ? (
            <form
              className="flex min-w-0 items-center gap-1.5 pr-[42px]"
              onClick={(event) => event.stopPropagation()}
              onSubmit={(event) => {
                event.preventDefault();
                void submitRename(thread.id);
              }}
            >
              <input
                aria-label={t("threads.rename.inputLabel")}
                autoFocus
                maxLength={80}
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                className="min-w-0 flex-1 rounded-[10px] border bg-background px-2 py-1.5 text-[13px] font-bold focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30"
              />
              <button
                type="submit"
                disabled={renameThread.isPending}
                className="rounded-[9px] bg-primary px-2 py-1.5 text-xs font-bold text-primary-foreground disabled:opacity-50"
              >
                {t("threads.rename.save")}
              </button>
              <button
                type="button"
                onClick={cancelRename}
                className="rounded-[9px] px-1.5 py-1.5 text-xs font-bold text-muted-foreground hover:bg-secondary"
              >
                {t("threads.rename.cancel")}
              </button>
            </form>
          ) : (
            <b className="block truncate pr-[42px] text-[13px] font-bold">{thread.title}</b>
          )}
          <span className="mt-1 block truncate text-xs">
            {thread.isDefault ? t("threads.defaultSubtitle") : t("threads.threadSubtitle")}
          </span>
          {/*
           * The "current" badge sits with the timestamp rather than in the
           * top-right corner it used to share with the menu trigger. Both
           * claimed that corner with `absolute right-2 top-2`, so on the
           * selected thread — always exactly one, and the one people are
           * looking at — the opaque trigger was drawn straight over the badge
           * and erased it.
           *
           * Reserving corner space for the badge instead would mean padding
           * the title by a guessed width that changes with the locale
           * ("Current" is nearly twice "当前"). Down here the row sizes itself,
           * the corner has a single owner, and the badge keeps doing its real
           * job: saying in words what the highlighted background says in
           * colour alone.
           */}
          <span className="mt-[7px] flex flex-wrap items-center gap-1.5">
            <time dateTime={thread.createdAt} className="inline-block bg-[var(--w-fog)] px-1.5 py-0.5 text-[11px] font-extrabold wanderly-edge-thin wanderly-r-xs">
              {formatThreadTime(locale, thread.createdAt)}
            </time>
            {selected ? (
              <span className="inline-block bg-card px-1.5 py-0.5 text-[10px] font-black wanderly-edge-thin wanderly-r-xs">
                {t("threads.currentBadge")}
              </span>
            ) : null}
          </span>
        </button>
        {!renaming ? (
          <button
            type="button"
            aria-label={t("threads.menu.triggerLabel")}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(event) => {
              event.stopPropagation();
              setOpenMenuFor(menuOpen ? null : thread.id);
            }}
            className="absolute right-2 top-2 grid size-7 place-items-center bg-card text-[var(--w-ink)] wanderly-edge-thin wanderly-r-xs wanderly-press hover:bg-[var(--w-mist)]"
          >
            <Pencil aria-hidden="true" className="size-3.5" />
          </button>
        ) : null}
        {menuOpen ? (
          <div
            role="menu"
            className="absolute right-2 top-10 z-20 grid min-w-[160px] gap-1 border bg-card p-1 text-sm shadow-md wanderly-edge wanderly-r-sm"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => beginRename(thread)}
              className="rounded-[6px] px-2 py-1.5 text-left text-xs font-bold hover:bg-[var(--w-mist)]"
            >
              {t("threads.menu.rename")}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={suggestTitle.isPending}
              onClick={() => void triggerAiName(thread)}
              className="rounded-[6px] px-2 py-1.5 text-left text-xs font-bold hover:bg-[var(--w-mist)] disabled:opacity-50"
            >
              {suggestTitle.isPending
                ? t("threads.aiName.pending")
                : t("threads.menu.aiName")}
            </button>
          </div>
        ) : null}
        {feedback ? (
          <p
            role="status"
            className="mt-1 px-3 text-[11px] font-bold text-muted-foreground"
          >
            {t(`threads.aiName.reason${feedback.reason.charAt(0)}${feedback.reason.slice(1).toLowerCase()}` as never)}
          </p>
        ) : null}
      </li>
    );
  };

  return (
    <main className="grid h-[calc(100dvh-62px)] min-h-[620px] grid-cols-1 overflow-x-hidden bg-background sm:h-dvh md:grid-cols-[minmax(220px,0.82fr)_minmax(420px,1.55fr)] xl:grid-cols-[minmax(220px,0.82fr)_minmax(420px,1.55fr)_minmax(280px,0.9fr)]">
      <aside className="relative hidden min-h-0 min-w-0 flex-col border-r-2 border-[var(--w-ink)] bg-background md:flex" aria-label={t("threads.heading")}>
        <header className="flex h-[66px] shrink-0 items-center justify-between gap-2 border-b-2 border-[var(--w-ink)] px-4">
          {editingTitle ? (
            <form
              className="flex min-w-0 flex-1 items-center gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                const name = manualTitle.trim();
                if (!name) return;
                void updateTitle.mutateAsync({ name }).then(() => setEditingTitle(false));
              }}
            >
              <input aria-label={t("title.editLabel")} autoFocus maxLength={256} value={manualTitle} onChange={(event) => setManualTitle(event.target.value)} className="min-w-0 flex-1 rounded-[10px] border bg-background px-2 py-1.5 text-sm font-bold focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30" />
              <button type="submit" disabled={updateTitle.isPending} className="rounded-[9px] bg-primary px-2 py-1.5 text-xs font-bold text-primary-foreground disabled:opacity-50">{t("title.save")}</button>
              <button type="button" onClick={() => setEditingTitle(false)} className="rounded-[9px] px-1.5 py-1.5 text-xs font-bold text-muted-foreground hover:bg-secondary">{t("title.cancel")}</button>
            </form>
          ) : (
            <>
              <div className="min-w-0">
                <Link href="/projects" className="block truncate text-[11px] font-bold text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30">
                  ← {t("backToHome")}
                </Link>
                <strong className="mt-0.5 block truncate text-[15px] tracking-[-0.02em]">{trip.name}</strong>
              </div>
              {callerRole === "CREATOR" ? (
                <button type="button" aria-label={t("title.edit")} onClick={() => { setManualTitle(trip.name); setEditingTitle(true); }} className="grid size-[34px] shrink-0 place-items-center bg-card text-[var(--w-ink)] wanderly-edge wanderly-r-sm wanderly-shadow-sm wanderly-press">
                  <Pencil aria-hidden="true" className="size-4" />
                </button>
              ) : null}
            </>
          )}
        </header>

        <button
          type="button"
          onClick={handleCreateThread}
          disabled={createThread.isPending}
          className="mx-3 mb-1.5 mt-3.5 inline-flex min-h-10 items-center gap-2 px-[11px] py-2 text-sm font-extrabold disabled:cursor-not-allowed wanderly-edge wanderly-r-md wanderly-shadow-sm wanderly-press wanderly-action"
        >
          <Plus aria-hidden="true" className="size-5" />
          {createThread.isPending ? t("threads.newThread.submitting") : t("threads.newThread.label")}
        </button>

        {/* Pinned shared-plan entry — Phase 1 of
            docs/shared-plan-surface-implementation.md §7.1. Always
            visible so the trip-scoped read-only view is discoverable
            even when no plan exists yet (empty state lands here). The
            unread dot is the Phase 4 (§7.5) badge; the button label is
            unchanged for sighted users. */}
        <button
          type="button"
          aria-current={querySharedView ? "page" : undefined}
          onClick={handleSelectSharedView}
          data-testid="shared-plan-rail-item"
          className={`relative mx-3 mb-1.5 mt-1 flex w-[calc(100%-1.5rem)] min-h-[64px] flex-col items-start gap-0.5 bg-card px-3 py-2 text-left text-[var(--w-ink)] wanderly-edge wanderly-r-md wanderly-press ${querySharedView ? "bg-[var(--w-highlight)] wanderly-shadow" : "wanderly-shadow-sm hover:bg-[var(--w-mist)]"}`}
        >
          <b className="block truncate pr-[42px] text-[13px] font-bold">{tShared("railTitle")}</b>
          <span className="block truncate text-xs">{tShared("railSubtitle")}</span>
          {hasUnreadSharedPlan ? (
            <span
              aria-label="Unread shared plan update"
              data-testid="shared-plan-unread"
              className="absolute right-2 top-2 inline-flex size-[10px] rounded-full bg-[var(--w-highlight)]"
            />
          ) : null}
        </button>

        <p className="mx-4 mb-2 mt-[18px] text-[11px] font-black uppercase tracking-[0.09em] wanderly-underline">{t("threads.sectionLabel")}</p>

        <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-[18px]">
          {threadsQuery.isPending ? (
            <LoadingState label={t("threads.loading")} />
          ) : threadsQuery.isError ? (
            <ErrorState error={threadsQuery.error} title={t("threads.errorTitle")} />
          ) : threads.length === 0 ? (
            <div className="mx-1 border-2 border-dashed border-[var(--w-ink)] p-4 text-center text-sm wanderly-r-md">
              <p className="font-bold text-foreground">{t("threads.emptyTitle")}</p>
              <p className="mt-1">{t("threads.emptyBody")}</p>
            </div>
          ) : (
            <>
              <ul role="list" className="grid gap-2.5">{liveThreads.map(renderThread)}</ul>
              {archivedThreads.length > 0 ? (
                <>
                  <p className="mx-2 mb-2 mt-[18px] text-[11px] font-black uppercase tracking-[0.09em] wanderly-underline">{t("threads.archivedLabel")}</p>
                  <ul role="list" className="grid gap-2.5">{archivedThreads.map(renderThread)}</ul>
                </>
              ) : null}
            </>
          )}
        </div>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-col bg-background">
        <header className="flex h-[66px] shrink-0 items-center justify-between gap-2 border-b-2 border-[var(--w-ink)] px-[18px]">
          <div className="min-w-0">
            {querySharedView ? (
              <>
                <strong className="block truncate text-[15px] tracking-[-0.02em]">{tShared("headerTitle")}</strong>
                <p className="truncate text-xs text-muted-foreground">
                  {tShared("headerSubtitle")} · {t("header.members", { count: members.length })}
                </p>
              </>
            ) : (
              <>
                <strong className="block truncate text-[15px] tracking-[-0.02em]">{activeThread?.title ?? trip.name}</strong>
                <p className="truncate text-xs text-muted-foreground">
                  {trip.name} · {t("header.members", { count: members.length })}
                </p>
              </>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-[7px]">
            <span className="inline-flex items-center gap-1.5 bg-card px-2 py-1.5 text-xs font-bold text-[var(--w-ink)] wanderly-edge-thin wanderly-r-xs">
              <i aria-hidden="true" className="size-[7px] rounded-full bg-[var(--w-highlight)]" />
              <span className="hidden sm:inline">{t("workspace.agentChip")}</span>
            </span>
            {callerRole === "CREATOR" ? (
              <Link href={`/trips/${tripId}/invite`} aria-label={t("workspace.invitation.compactTrigger")} className="inline-flex min-h-11 items-center gap-2 px-2.5 text-xs font-extrabold wanderly-edge wanderly-r-sm wanderly-press wanderly-action focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30 xl:hidden">
                <UserPlus aria-hidden="true" className="size-4" />
                <span className="hidden sm:inline">{t("workspace.invitation.trigger")}</span>
              </Link>
            ) : null}
            <button
              type="button"
              onClick={() => setInspectorOpen(true)}
              aria-controls="trip-inspector"
              aria-expanded={inspectorOpen}
              className="grid size-[34px] place-items-center bg-card text-[var(--w-ink)] wanderly-edge wanderly-r-sm wanderly-shadow-sm wanderly-press xl:hidden"
            >
              <PanelRight aria-hidden="true" className="size-4" />
              <span className="sr-only">{t("workspace.openInspector")}</span>
            </button>
          </div>
        </header>

        {querySharedView ? (
          <div className="min-h-0 flex-1 overflow-y-auto bg-background px-[clamp(16px,3vw,34px)] pb-6 pt-4">
            <SharedPlanView tripId={tripId} />
          </div>
        ) : (
          <TravelAgentChat
            variant="docked"
            surface="TRIP_WORKSPACE"
            threadId={activeThread?.id ?? null}
            threadStatus={chatThreadStatus}
            // The chat writes the trip's auto title when the traveller confirms
            // a brief or starts shared planning, and the server can only write
            // the language it is told. Without this the workspace fell back to
            // the prop default and named a Chinese traveller's trip
            // "新加坡 Trip Planner｜4 Days" — half-translated, because the
            // destination came from their own words and the rest did not.
            titleLocale={locale === "zh" ? "zh" : "en"}
            tripId={tripId}
            onThreadInvalidated={() => threadsQuery.refetch()}
            onSharedRunStarted={handleSharedRunStarted}
          />
        )}
      </section>

      {inspectorOpen ? (
        <button type="button" aria-label={t("workspace.closeInspector")} onClick={() => setInspectorOpen(false)} className="fixed inset-0 z-20 bg-[#102a4320] xl:hidden" />
      ) : null}

      <aside
        id="trip-inspector"
        aria-label={t("workspace.inspectorTitle")}
        className={`relative grid min-h-0 min-w-0 grid-rows-[66px_minmax(0,1fr)_auto] bg-transparent max-xl:fixed max-xl:inset-y-0 max-xl:right-0 max-xl:z-30 max-xl:w-[min(360px,88vw)] max-xl:border-l-2 max-xl:border-[var(--w-ink)] max-xl:bg-[var(--w-mist)] max-xl:shadow-[-20px_0_50px_#102a4320] max-xl:transition-transform ${inspectorOpen ? "max-xl:translate-x-0" : "max-xl:translate-x-full"}`}
      >
        {/* The desktop inspector is a group of floating cards. Its short
            divider continues the centre header only through the invite action. */}
        <header className="relative flex h-[66px] items-center justify-end gap-2 px-3.5 max-xl:border-b-2 max-xl:border-[var(--w-ink)] xl:px-4 xl:after:absolute xl:after:bottom-0 xl:after:left-0 xl:after:right-4 xl:after:h-[2px] xl:after:bg-[var(--w-ink)]" aria-label={t("workspace.inspectorTitle")}>
          {callerRole === "CREATOR" ? (
            <Link href={`/trips/${tripId}/invite`} className="inline-flex min-h-11 items-center justify-center gap-2 px-3 text-sm font-extrabold wanderly-edge wanderly-r-md wanderly-shadow-sm wanderly-press wanderly-action focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30">
              <UserPlus aria-hidden="true" className="size-4" />
              {t("workspace.invitation.trigger")}
            </Link>
          ) : null}
          <button
            type="button"
            onClick={() => setInspectorOpen(false)}
            aria-label={t("workspace.closeInspector")}
            className="grid size-[34px] place-items-center bg-card text-[var(--w-ink)] wanderly-edge wanderly-r-sm wanderly-shadow-sm wanderly-press xl:hidden"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </header>

        <div className="min-h-0 overflow-y-auto p-3 xl:px-4 xl:py-4">
          <div className="grid gap-[11px]">
            <section aria-label={t("workspace.overviewWindow")} className="overflow-hidden bg-card wanderly-edge wanderly-r-md wanderly-shadow">
              <div className="flex items-center justify-between gap-[7px] border-b-2 border-[var(--w-ink)] bg-[var(--w-fog)] px-2.5 py-2.5">
                <div className="flex min-w-0 items-center gap-[7px] text-xs font-extrabold">
                  <span aria-hidden="true" className="grid size-[21px] place-items-center bg-[var(--w-highlight)] text-[var(--w-ink)] wanderly-edge-thin wanderly-r-xs">◎</span>
                  <span className="truncate">{t("workspace.overviewWindow")}</span>
                </div>
              </div>
              <div className="p-3">
                <span className={`inline-flex items-center gap-1.5 px-[7px] py-1 text-[10px] font-extrabold wanderly-edge-thin wanderly-r-xs ${STATUS_PILL[trip.status]}`}>
                  <i aria-hidden="true" className="size-1.5 rounded-full bg-current" />
                  {t(`header.statusValue.${trip.status}` as `header.statusValue.${typeof trip.status}`)}
                </span>
                <h2 className="mb-1 mt-2 truncate text-base tracking-[-0.025em]">{trip.name}</h2>
                <p className="text-xs">{datesLabel}</p>
                <div className="mt-3 grid grid-cols-2 gap-[7px]">
                  <div className="bg-[var(--w-mist)] p-2 text-[11px] text-[var(--w-ink)] wanderly-edge-thin wanderly-r-xs">
                    <b className="block text-xs">{t("header.departure")}</b>
                    {departureLabel}
                  </div>
                  <DestinationsCell
                    tripId={tripId}
                    destinations={trip.destinationCandidates}
                    label={destinationsLabel}
                    // The draft-brief route is the only writer for this field
                    // and it accepts DRAFT trips only, so the pencil appears
                    // exactly where the save can succeed.
                    editable={trip.status === "DRAFT" && callerRole === "CREATOR"}
                    locale={locale === "zh" ? "zh" : "en"}
                    t={t}
                  />
                </div>
                {trip.status === "DRAFT" && callerRole === "CREATOR" ? (
                  <div className="mt-3">
                    <p className="text-[11px] leading-4 text-muted-foreground">{t("workspace.draftActivationHint")}</p>
                  </div>
                ) : null}
              </div>
            </section>

            <section className="overflow-hidden bg-card wanderly-edge wanderly-r-md wanderly-shadow">
              <div className="flex items-center justify-between gap-[7px] border-b-2 border-[var(--w-ink)] bg-[var(--w-fog)] px-2.5 py-2.5">
                <div className="flex min-w-0 items-center gap-[7px] text-xs font-extrabold">
                  <span aria-hidden="true" className="grid size-[21px] place-items-center bg-[var(--w-highlight)] text-[var(--w-ink)] wanderly-edge-thin wanderly-r-xs">⌁</span>
                  <span className="truncate">{t("workspace.membersWindow")}</span>
                </div>
              </div>
              <div className="px-3 py-[11px]">
                {members.map((member) => (
                  <div key={member.userId} className="flex items-center gap-2 border-b border-[var(--w-line)] py-[7px] text-xs text-[var(--w-ink)] last:border-0">
                    <span className="min-w-0 truncate">{member.displayName}</span>
                    <b className="ml-auto shrink-0 text-[10px]">{t(`workspace.roleValue.${member.role}` as `workspace.roleValue.${typeof member.role}`)}</b>
                  </div>
                ))}
              </div>
            </section>

            <ResearchGapBannerWrapper tripId={trip.id} />
          </div>
        </div>

        <section className="mx-3 mb-3 overflow-hidden bg-card wanderly-edge wanderly-r-md wanderly-shadow xl:mx-4 xl:mb-4" aria-label={t("workspace.mapWindow")}>
          <div className="flex items-center justify-between gap-[7px] border-b-2 border-[var(--w-ink)] bg-[var(--w-fog)] px-2.5 py-2.5">
            <div className="flex min-w-0 items-center gap-[7px] text-xs font-extrabold">
              <span aria-hidden="true" className="grid size-[21px] place-items-center bg-[var(--w-highlight)] text-[var(--w-ink)] wanderly-edge-thin wanderly-r-xs">◎</span>
              <span className="truncate">{t("workspace.mapWindow")}</span>
              <span className="shrink-0 bg-[var(--w-fog)] px-[7px] py-1 text-[10px] font-extrabold text-[var(--w-ink)] wanderly-edge-thin wanderly-r-xs">{t("workspace.mapPinned")}</span>
            </div>
            <Link
              href={activeThread ? `/home?fromTrip=${tripId}&thread=${activeThread.id}` as "/home" : "/home"}
              aria-label={t("workspace.openFullMap")}
              className="grid size-[25px] shrink-0 place-items-center bg-card text-[var(--w-ink)] wanderly-edge-thin wanderly-r-xs wanderly-press"
            >
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </Link>
          </div>
          <TripMiniGlobe places={globePlaces} fallbackLabel={destinationsLabel} tripId={tripId} threadId={activeThread?.id ?? null} />
        </section>
      </aside>
    </main>
  );
}

const STATUS_PILL: Record<string, string> = {
  DRAFT: "bg-[var(--w-fog)] text-[var(--w-ink)]",
  PLANNING: "bg-[var(--w-highlight)] text-[var(--w-ink)]",
  STALE: "bg-[var(--w-fog)] text-[var(--w-ink)]",
  CONFIRMED: "bg-[var(--w-mist)] text-[var(--w-ink)]",
  BOOKED: "bg-[var(--w-mist)] text-[var(--w-ink)]",
  CANCELLED: "bg-[var(--w-white)] text-[var(--w-ink)]",
};

function formatThreadTime(locale: string, iso: string): string {
  try {
    const date = new Date(iso);
    const sameDay = new Date().toDateString() === date.toDateString();
    return new Intl.DateTimeFormat(locale || "en", sameDay
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric" }).format(date);
  } catch {
    return iso;
  }
}

function ResearchGapBannerWrapper({ tripId }: { tripId: string }) {
  // Post-P0 (planner-resilience §8.2): the workspace now reads from
  // `/trips/:tripId/research/latest` (the only route that exists). The
  // historical `/research-results` endpoint and its dead hook were deleted;
  // see `docs/planner-resilience-and-reflection-implementation.md` §12.3.
  const research = useLatestResearchResult(tripId);
  if (!research.data || research.isLoading) return null;
  return <ResearchGapBanner result={research.data.result} />;
}

/** Accepts either separator so a list pasted from the card round-trips. */
function splitDestinations(value: string): string[] {
  return value.split(/[,，·]/).map((part) => part.trim()).filter(Boolean).slice(0, 5);
}

/**
 * The destinations cell, editable in place while the trip is still a DRAFT.
 *
 * A destination arrives here from two directions — the model's brief proposal
 * and a place pinned on the globe — and neither is guaranteed to be what the
 * traveller meant, so the field they land in has to be correctable without
 * going back through the conversation.
 */
function DestinationsCell({ tripId, destinations, label, editable, locale, t }: {
  tripId: string;
  destinations: string[];
  label: string;
  editable: boolean;
  locale: "en" | "zh";
  t: ReturnType<typeof useTranslations>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [failed, setFailed] = useState(false);
  const update = useUpdateDraftTripBrief(tripId);

  const cellClass = "bg-[var(--w-mist)] p-2 text-[11px] text-[var(--w-ink)] wanderly-edge-thin wanderly-r-xs";

  if (!editing) {
    return (
      <div className={cellClass}>
        <div className="flex items-start justify-between gap-1">
          <b className="block text-xs">{t("header.destinations")}</b>
          {editable ? (
            <button
              type="button"
              aria-label={t("workspace.destinationsEdit")}
              title={t("workspace.destinationsEdit")}
              onClick={() => { setDraft(destinations.join(", ")); setFailed(false); setEditing(true); }}
              className="-mr-0.5 -mt-0.5 grid size-[18px] shrink-0 place-items-center bg-card text-[var(--w-ink)] wanderly-edge-thin wanderly-r-xs wanderly-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            >
              <Pencil aria-hidden="true" className="size-2.5" />
            </button>
          ) : null}
        </div>
        {label}
      </div>
    );
  }

  return (
    <form
      className={cellClass}
      onSubmit={(event) => {
        event.preventDefault();
        const next = splitDestinations(draft);
        if (next.length === 0) return;
        setFailed(false);
        void update.mutateAsync({
          destinationCandidates: next,
          replaceDestinationCandidates: true,
          titleLocale: locale,
        }).then(() => setEditing(false)).catch(() => setFailed(true));
      }}
    >
      <b className="block text-xs">{t("header.destinations")}</b>
      <input
        aria-label={t("workspace.destinationsEditLabel")}
        placeholder={t("workspace.destinationsPlaceholder")}
        autoFocus
        maxLength={330}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="mt-1 w-full bg-card px-1.5 py-1 text-[11px] wanderly-edge-thin wanderly-r-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
      />
      {failed ? <p role="alert" className="mt-1 text-[10px] font-bold text-destructive">{t("workspace.destinationsSaveError")}</p> : null}
      <div className="mt-1.5 flex gap-1">
        <button type="submit" disabled={update.isPending} className="bg-primary px-1.5 py-1 text-[10px] font-black text-primary-foreground disabled:opacity-50 wanderly-edge-thin wanderly-r-xs">{t("title.save")}</button>
        <button type="button" onClick={() => setEditing(false)} disabled={update.isPending} className="px-1.5 py-1 text-[10px] font-black text-[var(--w-ink)]">{t("title.cancel")}</button>
      </div>
    </form>
  );
}
