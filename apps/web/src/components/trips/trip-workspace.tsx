"use client";

import { ExternalLink, PanelRight, Pencil, Plus, UserPlus, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { TravelAgentChat } from "@/components/explore/travel-agent-chat";
import { TripMiniGlobe } from "@/components/trips/trip-mini-globe";
import { ResearchGapBanner } from "@/components/trips/research-gap-banner";
import { ErrorState, LoadingState } from "@/components/ui/data-state";
import { Link, useRouter } from "@/i18n/navigation";
import {
  useActivateTrip,
  useCreateTripThread,
  useGetOrCreateDefaultTripThread,
  useResearchResult,
  useTrip,
  useTripThreads,
  useUpdateTripTitle,
} from "@/lib/query/hooks";
import { TravelApiError } from "@/lib/api/errors";

const DEFAULT_THREAD_QUERY = "thread";

function isUnauthorizedOrRevoked(error: unknown): boolean {
  if (!(error instanceof TravelApiError)) return false;
  if (error.isUnauthorized) return true;
  return error.statusCode === 410;
}

export function TripWorkspace({ tripId }: { tripId: string }) {
  const t = useTranslations("trips");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryThreadId = searchParams.get(DEFAULT_THREAD_QUERY);

  const tripQuery = useTrip(tripId);
  const threadsQuery = useTripThreads(tripId);
  const createThread = useCreateTripThread(tripId);
  const ensureDefault = useGetOrCreateDefaultTripThread(tripId);
  const updateTitle = useUpdateTripTitle(tripId);
  const activate = useActivateTrip(tripId);
  const [editingTitle, setEditingTitle] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [activationError, setActivationError] = useState(false);

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

  const liveThreads = useMemo(() => threads.filter((thread) => !thread.archivedAt), [threads]);
  const archivedThreads = useMemo(() => threads.filter((thread) => thread.archivedAt), [threads]);

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
  useEffect(() => {
    if (!threadsQuery.data) return;
    if (membershipRevoked) return;
    const knownIds = new Set(threads.map((thread) => thread.id));
    if (queryThreadId && knownIds.has(queryThreadId)) return;
    if (threads.length === 0) return;
    const fallback = threads.find((thread) => thread.isDefault) ?? threads[0];
    const params = new URLSearchParams(searchParams.toString());
    params.set(DEFAULT_THREAD_QUERY, fallback.id);
    router.replace(`/trips/${tripId}?${params.toString()}` as Parameters<typeof router.replace>[0]);
  }, [threads, threadsQuery.data, queryThreadId, router, searchParams, tripId, membershipRevoked]);

  // "New thread" opens a fresh session straight away — no title prompt.
  // The server-side title is auto-numbered so the rail stays readable.
  const handleCreateThread = useCallback(async () => {
    if (createThread.isPending) return;
    try {
      const created = await createThread.mutateAsync({
        title: t("threads.newThread.autoTitle", { index: threads.length + 1 }),
      });
      const params = new URLSearchParams(searchParams.toString());
      params.set(DEFAULT_THREAD_QUERY, created.id);
      router.push(`/trips/${tripId}?${params.toString()}` as Parameters<typeof router.push>[0]);
    } catch {
      // surfaced through the threads query error state.
    }
  }, [createThread, router, searchParams, t, threads.length, tripId]);

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
  const destinationsLabel = trip.destinationCandidates.length > 0
    ? trip.destinationCandidates.join(" · ")
    : t("header.datesUnknown");
  const departureLabel = trip.departureCities.length > 0
    ? trip.departureCities.join(" · ")
    : t("header.datesUnknown");
  const canActivateDraft = trip.status === "DRAFT"
    && trip.departureCities.length >= 1
    && trip.destinationCandidates.length >= (members.length > 1 ? 2 : 1)
    && trip.destinationCandidates.length <= (members.length > 1 ? 3 : 5);

  async function activateDraft() {
    if (!canActivateDraft || activate.isPending) return;
    setActivationError(false);
    try {
      await activate.mutateAsync({
        departureCities: trip.departureCities,
        destinationCandidates: trip.destinationCandidates,
        travelDateStart: trip.travelDateStart,
        travelDateEnd: trip.travelDateEnd,
        titleLocale: locale === "zh" ? "zh" : "en",
      });
    } catch {
      setActivationError(true);
    }
  }

  // Every place the selected plan touches; the globe merges these onto countries.
  const globePlaces = [...trip.departureCities, ...trip.destinationCandidates];

  const renderThread = (thread: (typeof threads)[number]) => {
    const selected = thread.id === activeThread?.id;
    return (
      <li key={thread.id}>
        <button
          type="button"
          onClick={() => {
            const params = new URLSearchParams(searchParams.toString());
            params.set(DEFAULT_THREAD_QUERY, thread.id);
            setInspectorOpen(false);
            router.push(`/trips/${tripId}?${params.toString()}` as Parameters<typeof router.push>[0]);
          }}
          aria-current={selected ? "page" : undefined}
          className={`relative min-h-[82px] w-full bg-card px-3 py-[11px] text-left text-[var(--w-ink)] wanderly-edge wanderly-r-md wanderly-press ${selected ? "bg-[var(--w-highlight)] wanderly-shadow" : "wanderly-shadow-sm hover:bg-[var(--w-mist)]"}`}
        >
          <b className="block truncate pr-[42px] text-[13px] font-bold">{thread.title}</b>
          <span className="mt-1 block truncate text-xs">
            {thread.isDefault ? t("threads.defaultSubtitle") : t("threads.threadSubtitle")}
          </span>
          <time dateTime={thread.createdAt} className="mt-[7px] inline-block bg-[var(--w-fog)] px-1.5 py-0.5 text-[11px] font-extrabold wanderly-edge-thin wanderly-r-xs">
            {formatThreadTime(locale, thread.createdAt)}
          </time>
          {selected ? (
            <span className="absolute right-2 top-2.5 bg-card px-1.5 py-0.5 text-[10px] font-black wanderly-edge-thin wanderly-r-xs">
              {t("threads.currentBadge")}
            </span>
          ) : null}
        </button>
      </li>
    );
  };

  return (
    <main className="grid h-[calc(100dvh-62px)] min-h-[620px] grid-cols-1 overflow-hidden bg-background sm:h-dvh md:grid-cols-[minmax(220px,0.82fr)_minmax(420px,1.55fr)] xl:grid-cols-[minmax(220px,0.82fr)_minmax(420px,1.55fr)_minmax(280px,0.9fr)]">
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
            <strong className="block truncate text-[15px] tracking-[-0.02em]">{activeThread?.title ?? trip.name}</strong>
            <p className="truncate text-xs text-muted-foreground">
              {trip.name} · {t("header.members", { count: members.length })}
            </p>
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

        <TravelAgentChat
          variant="docked"
          threadId={activeThread?.id ?? null}
          tripId={tripId}
          onThreadInvalidated={() => threadsQuery.refetch()}
        />
      </section>

      {inspectorOpen ? (
        <button type="button" aria-label={t("workspace.closeInspector")} onClick={() => setInspectorOpen(false)} className="fixed inset-0 z-20 bg-[#102a4320] xl:hidden" />
      ) : null}

      <aside
        id="trip-inspector"
        aria-label={t("workspace.inspectorTitle")}
        className={`relative grid min-h-0 min-w-0 grid-rows-[66px_minmax(0,1fr)_auto] border-l-2 border-[var(--w-ink)] bg-[var(--w-mist)] max-xl:fixed max-xl:inset-y-0 max-xl:right-0 max-xl:z-30 max-xl:w-[min(360px,88vw)] max-xl:shadow-[-20px_0_50px_#102a4320] max-xl:transition-transform ${inspectorOpen ? "max-xl:translate-x-0" : "max-xl:translate-x-full"}`}
      >
        {/* Deliberately untitled: the spec keeps a bar here purely so the
            inspector's rule lines up with the history and chat headers. */}
        <header className="flex h-[66px] items-center justify-end gap-2 border-b-2 border-[var(--w-ink)] px-3.5" aria-label={t("workspace.inspectorTitle")}>
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

        <div className="min-h-0 overflow-y-auto p-3">
          <div className="grid gap-[11px]">
            <section className="overflow-hidden bg-card wanderly-edge wanderly-r-md wanderly-shadow">
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
                  <div className="bg-[var(--w-mist)] p-2 text-[11px] text-[var(--w-ink)] wanderly-edge-thin wanderly-r-xs">
                    <b className="block text-xs">{t("header.destinations")}</b>
                    {destinationsLabel}
                  </div>
                  <div className="bg-[var(--w-mist)] p-2 text-[11px] text-[var(--w-ink)] wanderly-edge-thin wanderly-r-xs">
                    <b className="block text-xs">{t("workspace.membersWindow")}</b>
                    {t("header.members", { count: members.length })}
                  </div>
                  <div className="bg-[var(--w-mist)] p-2 text-[11px] text-[var(--w-ink)] wanderly-edge-thin wanderly-r-xs">
                    <b className="block text-xs">{t("header.status")}</b>
                    {trip.status}
                  </div>
                </div>
                {trip.status === "DRAFT" && callerRole === "CREATOR" ? (
                  <div className="mt-3">
                    <p className="text-[11px] leading-4 text-muted-foreground">{t("workspace.draftActivationHint")}</p>
                    <button
                      type="button"
                      disabled={!canActivateDraft || activate.isPending}
                      onClick={() => void activateDraft()}
                      className="mt-2 inline-flex min-h-10 w-full items-center justify-center bg-[var(--w-highlight)] px-3 text-xs font-extrabold text-[var(--w-ink)] wanderly-edge-thin wanderly-r-sm wanderly-press disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {activate.isPending ? tCommon("loadingTrips") : t("workspace.activateDraft")}
                    </button>
                    {activationError ? <p role="alert" className="mt-2 text-[11px] text-destructive">{t("workspace.activateDraftError")}</p> : null}
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

        <section className="mx-3 mb-3 overflow-hidden bg-card wanderly-edge wanderly-r-md wanderly-shadow" aria-label={t("workspace.mapWindow")}>
          <div className="flex items-center justify-between gap-[7px] border-b-2 border-[var(--w-ink)] bg-[var(--w-fog)] px-2.5 py-2.5">
            <div className="flex min-w-0 items-center gap-[7px] text-xs font-extrabold">
              <span aria-hidden="true" className="grid size-[21px] place-items-center bg-[var(--w-highlight)] text-[var(--w-ink)] wanderly-edge-thin wanderly-r-xs">◎</span>
              <span className="truncate">{t("workspace.mapWindow")}</span>
              <span className="shrink-0 bg-[var(--w-fog)] px-[7px] py-1 text-[10px] font-extrabold text-[var(--w-ink)] wanderly-edge-thin wanderly-r-xs">{t("workspace.mapPinned")}</span>
            </div>
            <Link href="/home" aria-label={t("workspace.openFullMap")} className="grid size-[25px] shrink-0 place-items-center bg-card text-[var(--w-ink)] wanderly-edge-thin wanderly-r-xs wanderly-press">
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </Link>
          </div>
          <TripMiniGlobe places={globePlaces} fallbackLabel={destinationsLabel} tripId={tripId} />
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
  const research = useResearchResult(tripId);
  if (!research.data || research.isLoading) return null;
  return <ResearchGapBanner result={research.data} />;
}
