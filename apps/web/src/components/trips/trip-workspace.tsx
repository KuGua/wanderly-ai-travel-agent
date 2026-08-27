"use client";

import { CalendarDays, ListChecks, MapPinned, MessageSquarePlus, Pin, Plus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { FormEvent, useCallback, useEffect, useMemo, useRef } from "react";

import { TravelAgentChat } from "@/components/explore/travel-agent-chat";
import { ErrorState, LoadingState } from "@/components/ui/data-state";
import { Link, useRouter } from "@/i18n/navigation";
import {
  useCreateTripThread,
  useGetOrCreateDefaultTripThread,
  useTrip,
  useTripThreads,
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

  const handleCreateThread = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const title = String(formData.get("title") ?? "").trim();
    if (title.length === 0 || title.length > 256) return;
    try {
      const created = await createThread.mutateAsync({ title });
      const params = new URLSearchParams(searchParams.toString());
      params.set(DEFAULT_THREAD_QUERY, created.id);
      event.currentTarget.reset();
      router.push(`/trips/${tripId}?${params.toString()}` as Parameters<typeof router.push>[0]);
    } catch {
      // surfaced through the threads query error state.
    }
  }, [createThread, router, searchParams, tripId]);

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
  if (!trip) {
    return (
      <main className="mx-auto w-full max-w-[1240px] px-5 py-8 sm:px-8 md:px-[clamp(2rem,4vw,3.5rem)] md:py-[42px]">
        <p className="text-sm text-muted-foreground">{t("notFound")}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-[1240px] px-5 py-8 sm:px-8 md:px-[clamp(2rem,4vw,3.5rem)] md:py-[42px]">
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.11em] text-primary">{t("kicker")}</p>
          <h1 className="mt-2 text-[clamp(2.25rem,5vw,3rem)] font-bold leading-none tracking-[-0.055em]">{trip.name}</h1>
          <p className="mt-3 max-w-xl text-base text-muted-foreground">{t("body")}</p>
        </div>
        <Link href="/home" className="inline-flex min-h-11 items-center rounded-[14px] px-3 text-sm font-bold text-primary hover:underline focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30">
          {t("backToHome")}
        </Link>
      </header>

      <section className="my-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label={t("kicker")}>
        <article className="rounded-[22px] border bg-card p-[18px] shadow-[0_8px_24px_#102a4308]">
          <p className="text-[13px] text-muted-foreground">{t("header.status")}</p>
          <strong className="mt-0.5 block text-lg tracking-[-0.04em]">
            {t(`header.statusValue.${trip.status}` as `header.statusValue.${typeof trip.status}`)}
          </strong>
        </article>
        <article className="rounded-[22px] border bg-card p-[18px] shadow-[0_8px_24px_#102a4308]">
          <p className="text-[13px] text-muted-foreground">{t("header.dates")}</p>
          <strong className="mt-0.5 block text-lg tracking-[-0.04em]">
            {trip.travelDateStart && trip.travelDateEnd
              ? t("header.datesRange", { start: trip.travelDateStart, end: trip.travelDateEnd })
              : t("header.datesUnknown")}
          </strong>
        </article>
        <article className="rounded-[22px] border bg-card p-[18px] shadow-[0_8px_24px_#102a4308]">
          <p className="text-[13px] text-muted-foreground">{t("header.destinations")}</p>
          <strong className="mt-0.5 block text-lg tracking-[-0.04em]">
            {trip.destinationCandidates.length > 0
              ? trip.destinationCandidates.join(" · ")
              : t("header.datesUnknown")}
          </strong>
        </article>
      </section>

      <section className="grid gap-6 lg:grid-cols-[minmax(280px,360px)_1fr]" aria-label={t("threads.heading")}>
        <aside className="rounded-[22px] border bg-card p-4 shadow-[0_8px_24px_#102a4308]">
          <header className="mb-3 flex items-center justify-between gap-2">
            <h2 className="inline-flex items-center gap-2 text-sm font-black tracking-[-0.025em] text-sidebar">
              <ListChecks aria-hidden="true" className="size-4" /> {t("threads.heading")}
            </h2>
          </header>

          {threadsQuery.isPending ? (
            <LoadingState label={t("threads.loading")} />
          ) : threadsQuery.isError ? (
            <ErrorState error={threadsQuery.error} title={t("threads.errorTitle")} />
          ) : threads.length === 0 ? (
            <div className="rounded-[14px] border border-dashed p-4 text-center text-sm text-muted-foreground">
              <p className="font-bold text-foreground">{t("threads.emptyTitle")}</p>
              <p className="mt-1">{t("threads.emptyBody")}</p>
            </div>
          ) : (
            <ul className="space-y-1.5" role="list">
              {threads.map((thread) => {
                const selected = thread.id === activeThread?.id;
                return (
                  <li key={thread.id}>
                    <button
                      type="button"
                      onClick={() => {
                        const params = new URLSearchParams(searchParams.toString());
                        params.set(DEFAULT_THREAD_QUERY, thread.id);
                        router.push(`/trips/${tripId}?${params.toString()}` as Parameters<typeof router.push>[0]);
                      }}
                      aria-pressed={selected}
                      className={`flex w-full items-center gap-2 rounded-[12px] px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30 ${selected ? "bg-secondary text-primary" : "hover:bg-secondary/60"}`}
                    >
                      <Pin aria-hidden="true" className="size-3.5 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm font-bold">{thread.title}</span>
                      {thread.isDefault ? (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-primary">{t("threads.defaultBadge")}</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <form onSubmit={handleCreateThread} className="mt-4 space-y-2" aria-label={t("threads.newThread.label")}>
            <label className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.11em] text-muted-foreground" htmlFor="new-thread-title">
              <MessageSquarePlus aria-hidden="true" className="size-3.5" /> {t("threads.newThread.label")}
            </label>
            <div className="flex items-center gap-2">
              <input
                id="new-thread-title"
                name="title"
                type="text"
                required
                minLength={1}
                maxLength={256}
                placeholder={t("threads.newThread.placeholder")}
                disabled={createThread.isPending}
                className="min-w-0 flex-1 rounded-[10px] border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/30"
              />
              <button
                type="submit"
                disabled={createThread.isPending}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-[10px] bg-primary px-3 text-xs font-bold text-primary-foreground transition hover:brightness-110 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30"
              >
                <Plus aria-hidden="true" className="size-3.5" /> {createThread.isPending ? t("threads.newThread.submitting") : t("threads.newThread.submit")}
              </button>
            </div>
          </form>
        </aside>

        <section className="relative isolate min-h-[60dvh] overflow-hidden rounded-[22px] border bg-card shadow-[0_8px_24px_#102a4308]">
          <header className="flex items-center gap-3 border-b border-[#dbe8e5] px-5 py-3">
            <MapPinned aria-hidden="true" className="size-5 text-primary" />
            <div className="min-w-0">
              <p className="text-[11px] font-black uppercase tracking-[0.11em] text-muted-foreground">{t("threads.heading")}</p>
              <h3 className="min-w-0 truncate text-base font-bold tracking-[-0.025em]">
                {activeThread?.title ?? trip.name}
              </h3>
            </div>
            {activeThread?.createdAt ? (
              <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <CalendarDays aria-hidden="true" className="size-3.5" />
                <time dateTime={activeThread.createdAt}>{formatDate(locale, activeThread.createdAt)}</time>
              </span>
            ) : null}
          </header>
          <TravelAgentChat
            threadId={activeThread?.id ?? null}
            onThreadInvalidated={() => threadsQuery.refetch()}
          />
        </section>
      </section>
    </main>
  );
}

function formatDate(locale: string, iso: string): string {
  try {
    return new Intl.DateTimeFormat(locale || "en", { dateStyle: "medium" }).format(new Date(iso));
  } catch {
    return iso;
  }
}
