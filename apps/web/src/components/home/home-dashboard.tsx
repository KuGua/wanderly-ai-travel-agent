"use client";

import { ArrowRight, Heart, LockKeyhole, MapPinned, Search, Settings2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ErrorState, LoadingState } from "@/components/ui/data-state";
import { Link, useRouter } from "@/i18n/navigation";
import { useMyProfile, useTrips } from "@/lib/query/hooks";
import { useTravelApi } from "@/lib/query/provider";
import { tripKeys } from "@/lib/query/keys";
import { useOptionalAuth } from "@/lib/auth/auth-provider";
import type { TripSummary } from "@/lib/api/contracts";

import { TripList } from "./trip-list";
import { TripYearCalendar, tripRuns, yearsCovered } from "./trip-year-calendar";

type StatusFilter = "active" | "all" | "completed" | "archived";

const STATUS_GROUPS: Record<StatusFilter, TripSummary["status"][]> = {
  // A DRAFT is a private, unfinished trip, not an archived one. It must be
  // discoverable from the default list after the first Explore message.
  active: ["DRAFT", "PLANNING", "STALE", "CONFIRMED", "BOOKED"],
  completed: ["CONFIRMED", "BOOKED"],
  archived: ["CANCELLED"],
  all: ["DRAFT", "PLANNING", "STALE", "CONFIRMED", "BOOKED", "CANCELLED"],
};

function matchesSearch(trip: TripSummary, query: string): boolean {
  if (!query) return true;
  const lower = query.toLowerCase();
  return (
    trip.name.toLowerCase().includes(lower) ||
    trip.destinationCandidates.some((d) => d.toLowerCase().includes(lower)) ||
    trip.departureCities.some((d) => d.toLowerCase().includes(lower))
  );
}

function isArchivedTrip(trip: TripSummary): boolean {
  if (trip.archivedAt) return true;
  if (!trip.travelDateEnd) return false;
  return trip.travelDateEnd < new Date().toISOString().slice(0, 10);
}

export function HomeDashboard() {
  const tHome = useTranslations("home");
  const tCommon = useTranslations("common");
  const auth = useOptionalAuth();
  // Private Home data must fail closed when the app-level AuthProvider is
  // unavailable as well as when it reports a signed-out session.
  const isAuthenticated = auth?.status === "SIGNED_IN" || auth?.status === "LOCAL_DEV";
  const isCheckingSession = auth?.status === "CHECKING";
  const profileQuery = useMyProfile({ enabled: isAuthenticated });
  const tripsQuery = useTrips({ enabled: isAuthenticated });
  const api = useTravelApi();
  const queryClient = useQueryClient();
  const router = useRouter();
  const fmt = useFormatter();

  const [filter, setFilter] = useState<StatusFilter>("active");
  const [searchQuery, setSearchQuery] = useState("");
  const createRequestId = useRef<string | null>(null);
  const startTrip = useMutation({
    mutationFn: async () => {
      createRequestId.current ??= crypto.randomUUID();
      return api.startExploration({ requestId: createRequestId.current });
    },
    onSuccess: async (response) => {
      createRequestId.current = null;
      await queryClient.invalidateQueries({ queryKey: tripKeys.all });
      router.push(`/trips/${response.trip.id}?thread=${response.defaultThread.id}` as Parameters<typeof router.push>[0]);
    },
  });

  // Memoised, not `?? []`: that literal is a new array on every render, and it
  // feeds four `useMemo` dependency lists below — each of which then recomputed
  // every time regardless.
  const trips = useMemo(() => tripsQuery.data?.trips ?? [], [tripsQuery.data]);
  // `YYYY-MM-DD` in the reader's own zone. `toISOString()` would answer in UTC
  // and highlight yesterday for anyone east of Greenwich after 00:00 local.
  const todayIso = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }, []);
  const calendarRuns = useMemo(() => tripRuns(trips), [trips]);
  // The year the traveller is most likely asking about: this one when it has
  // trips, otherwise the nearest year that does.
  const calendarYear = useMemo(() => {
    const current = Number(todayIso.slice(0, 4));
    const years = yearsCovered(calendarRuns, current);
    return years.includes(current) ? current : years[years.length - 1];
  }, [calendarRuns, todayIso]);

  const statusCounts = useMemo(() => {
    const counts = { active: 0, completed: 0, archived: 0 };
    for (const trip of trips) {
      if (isArchivedTrip(trip) || STATUS_GROUPS.archived.includes(trip.status)) counts.archived++;
      else if (STATUS_GROUPS.completed.includes(trip.status)) counts.completed++;
      else if (STATUS_GROUPS.active.includes(trip.status)) counts.active++;
    }
    return counts;
  }, [trips]);

  const filteredTrips = useMemo(() => {
    const allowed = STATUS_GROUPS[filter];
    return trips
      .filter((trip) => filter === "archived"
        ? isArchivedTrip(trip) || allowed.includes(trip.status)
        : !isArchivedTrip(trip) && allowed.includes(trip.status))
      .filter((trip) => matchesSearch(trip, searchQuery));
  }, [trips, filter, searchQuery]);

  const heroTrip = useMemo(() => {
    const visibleTrips = trips.filter((trip) => !isArchivedTrip(trip));
    // Returning to an unfinished private exploration is the most immediate
    // action, so surface a Draft before an in-progress or stale plan.
    return visibleTrips.find((trip) => trip.status === "DRAFT")
      ?? visibleTrips.find((trip) => trip.status === "STALE" || trip.status === "PLANNING")
      ?? null;
  }, [trips]);

  const filters: { key: StatusFilter; count: number }[] = [
    { key: "active", count: statusCounts.active },
    { key: "all", count: trips.length },
    { key: "completed", count: statusCounts.completed },
    { key: "archived", count: statusCounts.archived },
  ];

  return (
    <main className="mx-auto w-full max-w-[1240px] px-5 py-8 sm:px-8 md:px-[clamp(2rem,4vw,3.5rem)] md:py-[42px]">
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.11em] wanderly-underline">
            {tHome("kicker")}
          </p>
          <h1 className="mt-2 text-[clamp(2.25rem,5vw,3rem)] font-bold leading-none tracking-[-0.055em]">
            <span className="wanderly-brush">{tHome("title")}</span>
          </h1>
          <p className="mt-3 max-w-xl text-base text-muted-foreground">
            {tHome("subtitle")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => startTrip.mutate()}
          disabled={startTrip.isPending}
          className="inline-flex min-h-12 items-center gap-2 px-5 text-sm font-extrabold wanderly-edge wanderly-r-md wanderly-shadow wanderly-press wanderly-action disabled:cursor-not-allowed disabled:opacity-60"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-[17px] fill-none stroke-current stroke-[2.4px]">
            <path d="M12 5v14M5 12h14" />
          </svg>
          {startTrip.isPending ? tCommon("loadingTrips") : tHome("newTrip")}
        </button>
      </header>
      {startTrip.isError ? <p role="alert" className="mt-3 text-sm font-semibold text-destructive">{tHome("newTripError")}</p> : null}

      {/* The year, where four tiles used to restate counts the trip list already
          shows. Nineteen trips make "when is the year busy" the question a
          number cannot answer. */}
      <section className="my-8" aria-label={tHome("calendar.ariaLabel")}>
        <div className="bg-card wanderly-edge wanderly-r-lg wanderly-shadow">
          <TripYearCalendar year={calendarYear} runs={calendarRuns} today={todayIso} />
        </div>
      </section>

      {/* Profile snapshot */}
      <section aria-labelledby="profile-heading">
        <div className="mb-3 flex items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.11em] wanderly-underline">
              {tHome("profile.kicker")}
            </p>
            <h2 id="profile-heading" className="mt-1 text-xl font-bold tracking-[-0.035em]">
              {tHome("profile.heading")}
            </h2>
          </div>
          <Link
            href="/profile"
            className="inline-flex min-h-11 items-center gap-2 rounded-[14px] px-3 text-sm font-bold text-primary hover:underline focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30"
          >
            <Settings2 aria-hidden="true" className="size-4" /> {tHome("profile.edit")}
          </Link>
        </div>
        {isCheckingSession || (isAuthenticated && profileQuery.isPending) ? <LoadingState label={tCommon("loadingProfile")} /> : null}
        {!isCheckingSession && !isAuthenticated ? <PrivateDataSignInRequired subject="profile" /> : null}
        {isAuthenticated && profileQuery.isError ? (
          <ErrorState error={profileQuery.error} title={tHome("errorStateProfileUnavailable")} />
        ) : null}
        {isAuthenticated && profileQuery.data?.profile ? (
          <div className="grid gap-0.5 overflow-hidden bg-[var(--w-ink)] wanderly-edge wanderly-r-lg wanderly-shadow sm:grid-cols-3">
            <SummaryItem
              icon={MapPinned}
              label={tHome("profile.departure")}
              value={profileQuery.data.profile.departureCity ?? tHome("summary.notSet")}
            />
            <SummaryItem
              icon={Heart}
              label={tHome("profile.interests")}
              value={
                profileQuery.data.profile.interests?.length
                  ? profileQuery.data.profile.interests.join(", ")
                  : tHome("summary.notSet")
              }
            />
            <SummaryItem
              icon={Settings2}
              label={tHome("profile.stayStyle")}
              value={
                profileQuery.data.profile.accommodationStyle
                  ? tHome(
                      `trip.accommodation.${profileQuery.data.profile.accommodationStyle}`,
                    )
                  : tHome("summary.notSet")
              }
            />
          </div>
        ) : null}
        {isAuthenticated && profileQuery.data?.profile === null ? (
          <div className="border-2 border-dashed border-[var(--w-ink)] bg-card p-7 wanderly-r-lg">
            <h3 className="font-bold">{tHome("profile.emptyTitle")}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{tHome("profile.emptyBody")}</p>
            <Link
              href="/profile"
              className="mt-4 inline-flex min-h-11 items-center font-bold text-primary hover:underline focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30"
            >
              {tHome("profile.emptyAction")}
            </Link>
          </div>
        ) : null}
      </section>

      {/* Trips section */}
      <section className="mt-10" aria-labelledby="trips-heading">
        {/* Hero "continue" card */}
        {heroTrip && filter === "active" && !searchQuery ? (
          <section className="mb-6" aria-label={tHome("hero.ariaLabel")}>
            <div className="mb-3 flex items-center justify-between gap-4">
              <h2 className="text-xl font-bold tracking-[-0.035em]">{tHome("hero.heading")}</h2>
              <span className="text-[13px] font-bold text-muted-foreground">{tHome("hero.needsAction")}</span>
            </div>
            <article className="grid overflow-hidden bg-card wanderly-edge wanderly-r-lg wanderly-shadow-lg sm:grid-cols-[170px_minmax(0,1fr)_auto] lg:grid-cols-[200px_minmax(0,1fr)_auto]">
              <div className="relative min-h-[120px] overflow-hidden border-b-2 border-[var(--w-ink)] bg-[var(--w-fog)] sm:min-h-0 sm:border-b-0 sm:border-r-2" aria-hidden="true">
                <span className="absolute -left-5 top-[30px] h-[110px] w-[210px] -rotate-[18deg] rounded-[50%] border-2 border-dashed border-[var(--w-primary)]" />
                <span className="absolute left-[74px] top-[69px] size-[21px] -rotate-45 rounded-[50%_50%_50%_5px] border-[3px] border-[var(--w-ink)] bg-[var(--w-highlight)]" />
              </div>
              <div className="p-5 sm:p-6">
                <span className="inline-flex items-center gap-1.5 bg-[var(--w-fog)] px-2.5 py-1 text-xs font-black text-[var(--w-ink)] wanderly-edge wanderly-r-xs">
                  <span className="size-[7px] rounded-full bg-current" />
                  {heroTrip.status === "DRAFT"
                    ? tHome("hero.draftBadge")
                    : heroTrip.status === "STALE"
                      ? tHome("hero.staleBadge")
                      : tHome("hero.planningBadge")}
                </span>
                <h3 className="mt-2 text-2xl font-bold tracking-[-0.045em]">{heroTrip.name}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {heroTrip.status === "DRAFT"
                    ? tHome("hero.draftBody")
                    : heroTrip.status === "STALE"
                      ? tHome("hero.staleBody")
                      : tHome("hero.planningBody")}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {heroTrip.departureCities.length > 0 || heroTrip.memberCount > 0 ? (
                    <span className="bg-card px-2 py-1 text-xs font-bold text-[var(--w-ink)] wanderly-edge-thin wanderly-r-xs">
                      {tHome("trip.members", { count: heroTrip.memberCount })}
                    </span>
                  ) : null}
                  {heroTrip.travelDateStart && heroTrip.travelDateEnd ? (
                    <span className="rounded-lg bg-secondary px-2 py-1 text-xs font-bold text-secondary-foreground">
                      {fmt.dateTime(new Date(heroTrip.travelDateStart), { dateStyle: "medium" })}
                      {" – "}
                      {fmt.dateTime(new Date(heroTrip.travelDateEnd), { dateStyle: "medium" })}
                    </span>
                  ) : null}
                  {heroTrip.destinationCandidates.length > 0 ? (
                    <span className="rounded-lg bg-secondary px-2 py-1 text-xs font-bold text-secondary-foreground">
                      {heroTrip.destinationCandidates.join(" · ")}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="flex items-center justify-center p-5">
                <Link
                  href={`/trips/${heroTrip.id}` as "/trips/[tripId]"}
                  className="inline-flex min-h-[45px] items-center gap-2 px-4 text-sm font-extrabold wanderly-edge wanderly-r-md wanderly-shadow wanderly-press wanderly-action"
                >
                  {heroTrip.status === "DRAFT"
                    ? tHome("hero.draftCta")
                    : heroTrip.status === "STALE"
                      ? tHome("hero.reviewCta")
                      : tHome("hero.continueCta")}
                  <ArrowRight aria-hidden="true" className="size-4" />
                </Link>
              </div>
            </article>
          </section>
        ) : null}

        {/* Trip grid. The filters live on this heading rather than beside the
            "continue planning" card: that card only renders for the active
            filter with no search, so filters placed there would disappear the
            moment someone chose "archived" — the control removing itself. */}
        <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="trips-heading" className="text-xl font-bold tracking-[-0.035em]">
              {tHome("trips.heading")}
            </h2>
          <div className="flex flex-wrap gap-2" role="group" aria-label={tHome("filter.ariaLabel")}>
            {filters.map(({ key, count }) => (
              <button
                key={key}
                type="button"
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
                className={`inline-flex min-h-[39px] items-center gap-1.5 px-3.5 py-[7px] text-sm font-extrabold text-[var(--w-ink)] wanderly-edge wanderly-r-sm wanderly-press ${
                  filter === key
                    ? "bg-[var(--w-cal-run)] wanderly-shadow-xs"
                    : "bg-card hover:bg-[var(--w-mist)]"
                }`}
              >
                {tHome(`filter.${key}`)}
                <span className="tabular-nums opacity-70">
                  {count}
                </span>
              </button>
            ))}
          </div>
          </div>
          <div className="flex items-center gap-4">
          <label className="flex min-h-[42px] w-full items-center gap-2 bg-card px-3 wanderly-edge wanderly-r-sm sm:w-[min(250px,100%)]">
            <Search aria-hidden="true" className="size-[17px] text-[var(--w-ink)]" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={tHome("filter.searchPlaceholder")}
              aria-label={tHome("filter.searchPlaceholder")}
              className="min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-[var(--w-ink)] placeholder:opacity-60"
            />
          </label>
            <span className="shrink-0 text-[13px] font-bold text-muted-foreground" role="status" aria-atomic="true">
              {tHome("trips.showing", { count: filteredTrips.length })}
            </span>
          </div>
        </div>
        {isCheckingSession || (isAuthenticated && tripsQuery.isPending) ? <LoadingState label={tCommon("loadingTrips")} /> : null}
        {!isCheckingSession && !isAuthenticated ? <PrivateDataSignInRequired subject="trips" /> : null}
        {isAuthenticated && tripsQuery.isError ? (
          <ErrorState error={tripsQuery.error} title={tHome("errorStateTripsUnavailable")} />
        ) : null}
        {isAuthenticated && tripsQuery.data ? <TripList trips={filteredTrips} /> : null}
      </section>
    </main>
  );
}

function PrivateDataSignInRequired({ subject }: { subject: "profile" | "trips" }) {
  const tHome = useTranslations("home");
  const isProfile = subject === "profile";
  const title = tHome(isProfile ? "signInRequired.profileTitle" : "signInRequired.tripsTitle");
  const body = tHome(isProfile ? "signInRequired.profileBody" : "signInRequired.tripsBody");

  return (
    <section className="w-full border-2 border-dashed border-[var(--w-ink)]/55 bg-[var(--w-mist)] p-5 wanderly-r-lg sm:px-6" aria-label={title}>
      <div className="flex min-h-[108px] flex-col justify-between gap-4 sm:flex-row sm:items-center sm:gap-8">
        <div className="flex min-w-0 max-w-2xl items-start gap-3">
          <LockKeyhole aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <h3 className="text-base font-bold tracking-[-0.025em]">{title}</h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{body}</p>
          </div>
        </div>
        <Link
          href="/login"
          className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 self-start bg-[var(--w-fog)] px-3 text-sm font-bold text-[var(--w-ink)] wanderly-edge-thin wanderly-r-sm wanderly-press hover:bg-[var(--w-highlight)] hover:wanderly-shadow-xs focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30 sm:self-auto"
        >
          {tHome("signInRequired.action")} <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
      </div>
    </section>
  );
}

function SummaryItem({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Heart;
  label: string;
  value: string;
}) {
  return (
    <div className="bg-card p-5">
      <Icon aria-hidden="true" className="mb-3 size-5 text-[var(--w-ink)]" />
      <p className="text-[11px] font-black uppercase tracking-[0.11em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 capitalize">{value}</p>
    </div>
  );
}
