"use client";

import { ArrowRight, Heart, LockKeyhole, MapPinned, Search, Settings2 } from "lucide-react";
import Image from "next/image";
import { useTranslations } from "next-intl";
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
  /* The plan the reader is most likely coming back to finish. Restored from
     the hero card that used to sit above the calendar: the card itself said
     little the trip's own note does not, but "take me back to the one I was
     in the middle of" was the one thing on it the list cannot do — the list
     is sorted, not ranked, and with twenty notes the live one is not on top.
     An unfinished private exploration outranks a plan already under way,
     because it is the one still waiting on the traveller rather than on us. */
  const currentTrip = useMemo(() => {
    const live = trips.filter((trip) => !isArchivedTrip(trip));
    return live.find((trip) => trip.status === "DRAFT")
      ?? live.find((trip) => trip.status === "STALE" || trip.status === "PLANNING")
      ?? null;
  }, [trips]);
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
          {/* No kicker. The brushed title carries the page on its own, and the
              line said what the sign-in copy and the profile column already do. */}
          <h1 className="text-[clamp(1.75rem,3.6vw,2.35rem)] font-semibold leading-none tracking-[-0.04em] text-[var(--w-ink)]/85">
            <span className="wanderly-brush">{tHome("title")}</span>
          </h1>
        </div>
        {/* The two ways into a plan, in the filter chips' outline: the heavy
            edge and hard shadow made one button shout across a page whose
            every other control had just been quietened. Fill still separates
            them — starting something new is the page's own action, resuming
            is a link into a trip. */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => startTrip.mutate()}
            disabled={startTrip.isPending}
            /* The selected filter's blue, not the mint `wanderly-action`. Scoped
               to this page: that class is shared by twelve other files, and the
               brief was these two controls, not every primary button. */
            className="inline-flex min-h-12 items-center gap-2 rounded-[10px] border border-[var(--w-ink)]/10 bg-[var(--w-cal-run)] px-5 text-sm font-semibold text-[var(--w-ink)] transition-colors hover:bg-[color-mix(in_srgb,var(--w-cal-run),var(--w-ink)_10%)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="size-[17px] fill-none stroke-current stroke-[2.4px]">
              <path d="M12 5v14M5 12h14" />
            </svg>
            {startTrip.isPending ? tCommon("loadingTrips") : tHome("newTrip")}
          </button>
          {/* Absent rather than disabled when there is nothing in progress: a
              greyed-out "no plan yet" is a control explaining its own
              uselessness, and a reader with no trips has the new-plan button
              right beside it. */}
          {currentTrip ? (
            <Link
              href={`/trips/${currentTrip.id}` as "/trips/[tripId]"}
              className="inline-flex min-h-12 items-center gap-2 rounded-[10px] border border-[var(--w-ink)]/10 bg-card px-5 text-sm font-semibold text-[var(--w-ink)] transition-colors hover:bg-[var(--w-mist)]"
            >
              <ArrowRight aria-hidden="true" className="size-[15px]" />
              <span>{tHome("continueTrip")}</span>
              {/* The trip's own name, so the control says which plan it will
                  open rather than making the reader click to find out. */}
              <span className="max-w-[13ch] truncate font-normal text-[var(--w-ink)]/60">{currentTrip.name}</span>
            </Link>
          ) : null}
        </div>
      </header>
      {startTrip.isError ? <p role="alert" className="mt-3 text-sm font-semibold text-destructive">{tHome("newTripError")}</p> : null}

      {/* The year, and the profile beside it. Four summary tiles and three
          profile tiles used to stack down the page restating counts the trip
          list already showed; the calendar answers "when is the year busy",
          which a number cannot, and the profile rides along in the space that
          leaves rather than claiming a band of its own. */}
      <section
        className="wanderly-pad my-8 overflow-hidden bg-card wanderly-edge"
        aria-label={tHome("calendar.ariaLabel")}
      >
        {/* One panel, the two halves the same height because grid rows stretch.
            Two separate cards left a gutter between things that are read
            together, and let the shorter one end early. The margin column is a
            fixed width rather than a fraction: it holds three short fields, so
            it should not grow with the window the way the year does. */}
        <div className="grid lg:grid-cols-[minmax(0,1fr)_296px]">
          <div className="min-w-0">
            <TripYearCalendar year={calendarYear} runs={calendarRuns} today={todayIso} />
          </div>

          <section
            aria-labelledby="profile-heading"
            /* The facing page. Fog grey read as "the space left over beside
               the calendar"; a warm tint reads as a page of its own, and the
               year keeps the plain white it is printed on. */
            className="min-w-0 border-t-2 border-[var(--w-ink)] bg-[var(--w-sheet-yellow)] p-4 lg:border-l-2 lg:border-t-0"
          >
            <div className="mb-3 flex items-end justify-between gap-3">
            {/* No kicker here. In a 268px column it wrapped to two lines and
                took more room than the heading it was labelling, and the page
                already says "private by default" over its own title. */}
            <h2 id="profile-heading" className="text-lg font-bold tracking-[-0.035em]">
              {tHome("profile.heading")}
            </h2>
            <Link
              href="/profile"
              /* The same hue as the button, taken 52% toward ink: at the
                 button's own value this is 1.6:1 on paper and unreadable. */
              className="inline-flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[14px] px-2 text-[13px] font-bold text-[color-mix(in_srgb,var(--w-cal-run),var(--w-ink)_52%)] hover:underline focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30"
            >
              <Settings2 aria-hidden="true" className="size-4" /> {tHome("profile.edit")}
            </Link>
          </div>
          {isCheckingSession || (isAuthenticated && profileQuery.isPending) ? <LoadingState label={tCommon("loadingProfile")} /> : null}
          {!isCheckingSession && !isAuthenticated ? <PrivateDataSignInRequired subject="profile" /> : null}
          {isAuthenticated && profileQuery.isError ? (
            <ErrorState error={profileQuery.error} title={tHome("errorStateProfileUnavailable")} />
          ) : null}
          {/* Rows on the panel, not a card inside a card: the ink-gap grid and
              its own edge and shadow were a second frame drawn just inside the
              first one. */}
          {isAuthenticated && profileQuery.data?.profile ? (
            <div className="divide-y divide-[var(--w-ink)]/12">
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
            <div className="border-2 border-dashed border-[var(--w-ink)] bg-card p-5 wanderly-r-lg">
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
        </div>
      </section>

      {/* The trips get a leaf of their own, lighter than the year above: a
          hairline and a soft drop rather than the pad's ink edge and page
          stack, so the notes still read as pinned onto it rather than framed
          by a second heavy panel. */}
      <div className="relative mt-8">
        {/* A real translucent fibre texture, placed outside the masked felt so
            its torn ends can cross the board edge without being clipped. */}
        <Image
          src="/images/washi-tape-blue.png"
          alt=""
          aria-hidden="true"
          width={768}
          height={256}
          className="pointer-events-none absolute -left-6 -top-9 z-10 h-auto w-[165px] select-none rotate-[-11deg] opacity-90 sm:-left-10 sm:-top-10 sm:w-[200px]"
        />
        <section
          /* Felt, not a second sheet of paper. The pad above is the notebook;
             this is the board its pages get pinned to, which is also why the
             torn edge is here and the rounded card corner is not. */
          className="wanderly-felt px-6 pb-11 pt-9 sm:px-8"
          aria-labelledby="trips-heading"
        >
        {/* Trip grid. The filters live on this heading rather than beside the
            "continue planning" card: that card only renders for the active
            filter with no search, so filters placed there would disappear the
            moment someone chose "archived" — the control removing itself. */}
        <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="trips-heading" className="text-lg font-semibold tracking-[-0.025em] text-[var(--w-felt-ink)]">
              {tHome("trips.heading")}
            </h2>
          <div className="flex flex-wrap gap-2" role="group" aria-label={tHome("filter.ariaLabel")}>
            {filters.map(({ key, count }) => (
              <button
                key={key}
                type="button"
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
                /* Colour alone marks the selection. The hard shadow and the
                   press offset made choosing a filter feel like throwing a
                   switch, four of which sat in a row above a list that simply
                   redraws. */
                /* Square, framed by a drawn box. Selection is still colour
                   alone — it moves the frame's fill, not its weight. */
                className={`wanderly-drawn inline-flex min-h-[36px] items-center gap-1.5 px-4 py-[7px] text-sm font-bold transition-colors ${
                  filter === key
                    ? "text-[var(--w-ink)] [--w-drawn-fill:var(--w-cal-run)]"
                    : "text-[#3a2c14] hover:[--w-drawn-fill:color-mix(in_srgb,var(--w-cal-run),var(--w-white)_55%)]"
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
          <label className="wanderly-drawn flex min-h-[42px] w-full items-center gap-2 px-3.5 sm:w-[min(250px,100%)]">
            <Search aria-hidden="true" className="size-[17px] text-[#3a2c14]" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={tHome("filter.searchPlaceholder")}
              aria-label={tHome("filter.searchPlaceholder")}
              className="min-w-0 flex-1 border-0 bg-transparent text-sm text-[#3a2c14] outline-none placeholder:text-[#3a2c14] placeholder:opacity-75"
            />
          </label>
            <span className="shrink-0 text-[13px] font-bold text-[var(--w-felt-ink)]" role="status" aria-atomic="true">
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
      </div>
    </main>
  );
}

/**
 * Container queries, not `sm:`. This block appears both full-width under the
 * trip grid and inside a 296px margin column, and a viewport breakpoint cannot
 * tell those apart: on a wide screen the narrow copy still laid itself out
 * side-by-side and squeezed its own text to one word a line.
 */
function PrivateDataSignInRequired({ subject }: { subject: "profile" | "trips" }) {
  const tHome = useTranslations("home");
  const isProfile = subject === "profile";
  const title = tHome(isProfile ? "signInRequired.profileTitle" : "signInRequired.tripsTitle");
  const body = tHome(isProfile ? "signInRequired.profileBody" : "signInRequired.tripsBody");

  return (
    <section className="@container w-full border-2 border-dashed border-[var(--w-ink)]/55 bg-[var(--w-mist)] p-5 wanderly-r-lg @lg:px-6" aria-label={title}>
      <div className="flex min-h-[108px] flex-col justify-between gap-4 @lg:flex-row @lg:items-center @lg:gap-8">
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
    <div className="py-3.5 first:pt-0 last:pb-0">
      <Icon aria-hidden="true" className="mb-2 size-[18px] text-[var(--w-ink)]" />
      <p className="text-[11px] font-black uppercase tracking-[0.11em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 capitalize">{value}</p>
    </div>
  );
}
