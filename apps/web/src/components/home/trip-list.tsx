"use client";

import { ArrowRight, CalendarDays, MapPin, UsersRound } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";
import type { TripSummary } from "@/lib/api/contracts";

const artStyles = [
  "from-[var(--w-info)] to-[var(--w-highlight)]",
  "from-[var(--w-moss)] to-[var(--w-info)]",
  "from-[var(--w-fog)] to-[var(--w-moss)]",
  "from-[var(--w-highlight)] to-[var(--w-fog)]",
  "from-[var(--w-primary)] to-[var(--w-moss)]",
] as const;

type StatusStyle = { bg: string; text: string };

const STATUS_STYLES: Record<TripSummary["status"], StatusStyle> = {
  DRAFT: { bg: "bg-[var(--w-fog)]", text: "text-[var(--w-ink)]" },
  PLANNING: { bg: "bg-[var(--w-highlight)]", text: "text-[var(--w-ink)]" },
  STALE: { bg: "bg-[var(--w-fog)]", text: "text-[var(--w-ink)]" },
  CONFIRMED: { bg: "bg-[var(--w-mist)]", text: "text-[var(--w-ink)]" },
  BOOKED: { bg: "bg-[var(--w-mist)]", text: "text-[var(--w-ink)]" },
  CANCELLED: { bg: "bg-[var(--w-white)]", text: "text-[var(--w-ink)]" },
};

type Translator = ReturnType<typeof useTranslations>;
type Formatter = ReturnType<typeof useFormatter>;

export function TripList({ trips }: { trips: TripSummary[] }) {
  const t: Translator = useTranslations("home");
  const fmt: Formatter = useFormatter();

  if (trips.length === 0) {
    return (
      <div className="border-2 border-dashed border-[var(--w-ink)] bg-card p-10 text-center wanderly-r-lg">
        <MapPin aria-hidden="true" className="mx-auto size-8 text-[var(--w-ink)]" />
        <h3 className="mt-4 font-bold">{t("trips.emptyTitle")}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{t("trips.emptyBody")}</p>
      </div>
    );
  }

  return (
    <div className="grid gap-[15px] sm:grid-cols-2 xl:grid-cols-3">
      {trips.map((trip, index) => {
        const style = STATUS_STYLES[trip.status];
        return (
          <article
            key={trip.id}
            className={`group flex min-h-[245px] flex-col overflow-hidden bg-card wanderly-edge wanderly-r-lg wanderly-shadow wanderly-press wanderly-press-lg ${
              index % 3 === 1 ? "wanderly-tilt-a" : index % 3 === 2 ? "wanderly-tilt-b" : ""
            }`}
          >
            <div
              className={`relative h-[87px] shrink-0 overflow-hidden border-b-2 border-[var(--w-ink)] bg-gradient-to-br ${artStyles[index % artStyles.length]}`}
              aria-hidden="true"
            >
              <span className="absolute -right-8 -top-[68px] size-[125px] rounded-full border-2 border-[var(--w-ink)]/65" />
              <span className="absolute bottom-[-23px] left-[6%] h-[35px] w-[90%] -rotate-[5deg] rounded-[50%] border border-dashed border-[var(--w-ink)]/70" />
            </div>
            <div className="flex flex-1 flex-col p-4">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-[19px] font-bold tracking-[-0.035em]">{trip.name}</h3>
                <span
                  className={`shrink-0 px-2 py-1 text-[11px] font-black whitespace-nowrap wanderly-edge-thin wanderly-r-xs ${style.bg} ${style.text}`}
                >
                  {formatStatus(trip.status, t)}
                </span>
              </div>
              <div className="mt-2 space-y-2 text-[13px] text-[var(--w-ink)]">
                {trip.status === "DRAFT" ? (
                  <p className="flex gap-2">
                    <MapPin aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    <span>{t("trip.draft.short")}</span>
                  </p>
                ) : (
                  <>
                    <p className="flex gap-2">
                      <MapPin aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                      <span>
                        {trip.departureCities.join(" + ")} →{" "}
                        {fmt.list(trip.destinationCandidates, { type: "unit" })}
                      </span>
                    </p>
                    <p className="flex gap-2">
                      <CalendarDays aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                      <span>{formatTripDates(trip.travelDateStart, trip.travelDateEnd, t, fmt)}</span>
                    </p>
                  </>
                )}
              </div>
              <div className="mt-auto flex items-center justify-between gap-3 pt-4 text-xs text-[var(--w-ink)]">
                <span className="flex items-center gap-1.5">
                  <UsersRound aria-hidden="true" className="size-3.5" />
                  {t("trip.members", { count: trip.memberCount })} ·{" "}
                  {trip.role === "CREATOR"
                    ? t("trip.membersRoleOrganizer")
                    : t("trip.membersRoleMember")}
                </span>
                <Link
                  href={`/trips/${trip.id}` as "/trips/[tripId]"}
                  className="inline-flex min-h-11 items-center gap-1 font-black text-[var(--w-ink)] wanderly-underline hover:decoration-[var(--w-ink)]"
                >
                  {trip.status === "DRAFT" ? t("trip.draft.continueCta") : t("trip.open")}
                  <ArrowRight aria-hidden="true" className="size-3.5" />
                </Link>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function formatStatus(status: TripSummary["status"], t: Translator) {
  return t(`trip.status.${status}`);
}

function formatTripDates(
  start: string | null,
  end: string | null,
  t: Translator,
  fmt: Formatter,
) {
  if (!start && !end) return t("trip.dates.notSet");
  if (!end) return fmt.dateTime(new Date(start as string), { dateStyle: "medium" });
  if (!start) return fmt.dateTime(new Date(end as string), { dateStyle: "medium" });
  return t("trip.dates.range", {
    start: fmt.dateTime(new Date(start as string), { dateStyle: "medium" }),
    end: fmt.dateTime(new Date(end as string), { dateStyle: "medium" }),
  });
}
