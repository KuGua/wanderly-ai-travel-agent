"use client";

import { ArrowRight, CalendarDays, MapPin, Trash2, UsersRound } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { Link } from "@/i18n/navigation";
import type { TripSummary } from "@/lib/api/contracts";
import { useDeleteTrip } from "@/lib/query/hooks";

/* One note stock per trip, chosen from the id so a trip keeps its paper
   between renders. Replaces five header gradients that were the same on every
   card and so decorated without distinguishing. */
const STOCKS = ["band", "holes", "ticket"] as const;

/**
 * Picks a card's tilt and gradient from the trip's own id rather than its
 * position in the list.
 *
 * Keyed by position, deleting a card restyled every card after it: they each
 * inherited the look of the one before, so the gap appeared at the end of the
 * list instead of where the deletion happened, and it read as though the wrong
 * trip had been removed. A trip's id does not move, so neither does its card.
 */
function styleSeed(tripId: string): number {
  let hash = 0;
  for (let index = 0; index < tripId.length; index += 1) {
    hash = (hash * 31 + tripId.charCodeAt(index)) >>> 0;
  }
  return hash;
}

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
      {trips.map((trip) => {
        const style = STATUS_STYLES[trip.status];
        const seed = styleSeed(trip.id);
        const stock = STOCKS[seed % STOCKS.length];
        return (
          <article
            key={trip.id}
            className={`wanderly-note wanderly-note--${stock} group relative flex min-h-[190px] flex-col wanderly-press ${
              stock === "band" ? "pt-[26px]" : stock === "holes" ? "pl-[18px]" : "pl-[16px]"
            }`}
          >
            <Link
              href={`/trips/${trip.id}` as "/trips/[tripId]"}
              aria-label={`${trip.status === "DRAFT" ? t("trip.draft.continueCta") : t("trip.open")}: ${trip.name}`}
              className="absolute inset-0 z-[1] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)]/30"
            />
            <span aria-hidden="true" className="pointer-events-none wanderly-clip" />
            {stock === "ticket" ? <span aria-hidden="true" className="pointer-events-none wanderly-notch" /> : null}
            <div className="pointer-events-none relative z-[2] flex flex-1 flex-col p-4">
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
                  <>
                    <p className="flex gap-2">
                      <MapPin aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                      <span>{t("trip.draft.short")}</span>
                    </p>
                    {/* The card title can already name a country while the
                        brief still has no city, so say so here rather than
                        letting the name imply a complete brief. */}
                    {trip.destinationCandidates.length === 0 ? (
                      <p className="font-bold">{t("trip.draft.destinationPending")}</p>
                    ) : null}
                  </>
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
                  {/* Creator-only, matching the API: a member who wants out of
                      a shared trip is leaving it, not destroying it for
                      everyone. In the footer row rather than floating over it,
                      and always present: revealing it on hover put it on top of
                      this line, and a control nobody can see is one nobody can
                      reach on a touch screen. */}
                  {trip.role === "CREATOR" ? <span className="pointer-events-auto"><DeleteTripControl trip={trip} t={t} /></span> : null}
                  <UsersRound aria-hidden="true" className="size-3.5" />
                  {t("trip.members", { count: trip.memberCount })} ·{" "}
                  {trip.role === "CREATOR"
                    ? t("trip.membersRoleOrganizer")
                    : t("trip.membersRoleMember")}
                </span>
                <span className="inline-flex min-h-11 items-center gap-1 font-black text-[var(--w-ink)] wanderly-underline">
                  {trip.status === "DRAFT" ? t("trip.draft.continueCta") : t("trip.open")}
                  <ArrowRight aria-hidden="true" className="size-3.5" />
                </span>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

/**
 * Deletes a trip, behind an in-place confirmation.
 *
 * This one is not reversible — the itinerary, the private conversations and
 * the research behind them all go — so the first click only arms it. The
 * confirm step is deliberately part of the card rather than a modal: the
 * traveller can see which trip they are about to lose while deciding.
 */
function DeleteTripControl({ trip, t }: { trip: TripSummary; t: Translator }) {
  const [armed, setArmed] = useState(false);
  const remove = useDeleteTrip(trip.id);

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        aria-label={t("trip.delete", { name: trip.name })}
        title={t("trip.delete", { name: trip.name })}
        className="grid size-6 shrink-0 place-items-center rounded-[6px] text-[var(--w-ink)]/55 transition-colors hover:bg-[var(--w-ink)]/8 hover:text-[var(--w-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--w-ink)]/30"
      >
        <Trash2 aria-hidden="true" className="size-[13px]" />
      </button>
    );
  }

  return (
    <div role="group" aria-label={t("trip.deleteConfirmTitle")} className="flex items-center gap-1.5 bg-card px-2 py-1 wanderly-edge-thin wanderly-r-xs">
      <span className="text-[11px] font-bold text-[var(--w-ink)]">{t("trip.deleteConfirmTitle")}</span>
      <button
        type="button"
        onClick={() => remove.mutate()}
        disabled={remove.isPending}
        className="min-h-8 rounded-full bg-destructive px-2 text-[11px] font-black text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40"
      >
        {remove.isPending ? t("trip.deleting") : t("trip.deleteConfirm")}
      </button>
      <button
        type="button"
        onClick={() => setArmed(false)}
        disabled={remove.isPending}
        className="min-h-8 rounded-full px-2 text-[11px] font-black text-[var(--w-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
      >
        {t("trip.deleteCancel")}
      </button>
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
