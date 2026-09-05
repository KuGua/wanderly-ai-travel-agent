"use client";

import { useFormatter, useTranslations } from "next-intl";

/**
 * A year at a glance, with each trip drawn as a run of marked days.
 *
 * This replaces four summary tiles that only restated counts the trip list
 * already showed. A traveller with nineteen trips wants to know *when* the
 * year is busy, which a number cannot say and a calendar says without being
 * read.
 *
 * Dates are handled as plain `YYYY-MM-DD` strings, never `new Date(value)`:
 * that parses a bare date as UTC midnight and then renders it in local time,
 * so a trip starting on the 1st shows on the last day of the previous month
 * for anyone west of Greenwich.
 */

export type CalendarTrip = {
  id: string;
  name: string;
  status: "DRAFT" | "PLANNING" | "STALE" | "CONFIRMED" | "BOOKED" | "CANCELLED";
  travelDateStart: string | null;
  travelDateEnd: string | null;
};

/**
 * Two kinds of run, because "these dates are settled" and "these dates are
 * still being worked out" are different answers to the same question, and a
 * year drawn in one colour cannot tell them apart.
 */
type RunKind = "planning" | "settled";
type Run = { start: string; end: string; kind: RunKind };

const PLANNING_STATUSES = new Set(["DRAFT", "PLANNING", "STALE"]);

/** Days in a month, without constructing a Date in the caller's timezone. */
function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Weekday of the 1st, 0 = Sunday, computed in UTC for the same reason. */
function firstWeekday(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
}

function iso(year: number, monthIndex: number, day: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function tripRuns(trips: readonly CalendarTrip[]): Run[] {
  return trips
    .filter((trip): trip is CalendarTrip & { travelDateStart: string } => Boolean(trip.travelDateStart))
    .map((trip) => ({
      start: trip.travelDateStart,
      // A trip with a start but no end still owns its first day.
      end: trip.travelDateEnd ?? trip.travelDateStart,
      kind: (PLANNING_STATUSES.has(trip.status) ? "planning" : "settled") as RunKind,
    }))
    .filter((run) => run.end >= run.start);
}

/** Which years the trips touch, so an empty year is never drawn. */
export function yearsCovered(runs: readonly Run[], fallbackYear: number): number[] {
  const years = new Set<number>();
  for (const run of runs) {
    years.add(Number(run.start.slice(0, 4)));
    years.add(Number(run.end.slice(0, 4)));
  }
  if (years.size === 0) years.add(fallbackYear);
  return [...years].sort((a, b) => a - b);
}

export function TripYearCalendar({
  year,
  runs,
  today,
}: {
  year: number;
  runs: readonly Run[];
  /** `YYYY-MM-DD` in the reader's own timezone, resolved by the caller. */
  today: string;
}) {
  const t = useTranslations("home.calendar");
  const format = useFormatter();
  const weekdays = [...Array(7).keys()].map((index) =>
    // 2026-02-01 is a Sunday, so this walks Sun..Sat in the reader's locale.
    format.dateTime(new Date(Date.UTC(2026, 1, 1 + index)), { weekday: "narrow", timeZone: "UTC" }),
  );

  return (
    <div>
      <div className="flex items-baseline justify-between px-4 pt-4">
        <p className="text-[13px] font-bold tracking-[.02em]">{t("year", { year })}</p>
        <div className="flex gap-3 text-[10.5px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <i aria-hidden="true" className="inline-block size-[9px] rounded-[2px] bg-[var(--w-cal-planning)]" />
            {t("legendPlanning")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i aria-hidden="true" className="inline-block size-[9px] rounded-[2px] bg-[var(--w-cal-run)]" />
            {t("legendTrip")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i aria-hidden="true" className="inline-block size-[9px] rounded-[2px] bg-[var(--w-cal-today)]" />
            {t("legendToday")}
          </span>
        </div>
      </div>

      <div className="grid gap-[14px_18px] p-4 [grid-template-columns:repeat(auto-fit,minmax(124px,1fr))]">
        {[...Array(12).keys()].map((monthIndex) => {
          const lead = firstWeekday(year, monthIndex);
          const count = daysInMonth(year, monthIndex);
          const previous = daysInMonth(year, monthIndex === 0 ? 11 : monthIndex - 1);
          const cells: Array<{ day: number; outside: boolean }> = [];
          for (let index = lead - 1; index >= 0; index -= 1) cells.push({ day: previous - index, outside: true });
          for (let day = 1; day <= count; day += 1) cells.push({ day, outside: false });
          let trailing = 1;
          while (cells.length % 7 !== 0) cells.push({ day: trailing++, outside: true });

          return (
            <div key={monthIndex} className="min-w-0">
              <p className="text-[11px] font-bold tracking-[.04em] text-muted-foreground">
                {format.dateTime(new Date(Date.UTC(year, monthIndex, 1)), { month: "long", timeZone: "UTC" })}
              </p>
              <div className="wanderly-cal-dows mt-[5px] text-center text-[8.5px] text-muted-foreground/70">
                {weekdays.map((label, index) => <span key={index}>{label}</span>)}
              </div>
              <div className="wanderly-cal-days mt-[2px]">
                {cells.map((cell, index) => {
                  const date = cell.outside ? null : iso(year, monthIndex, cell.day);
                  const run = date ? runs.find((item) => date >= item.start && date <= item.end) : undefined;
                  const isToday = date === today;
                  return (
                    <span
                      key={index}
                      className={[
                        "wanderly-cal-day",
                        cell.outside ? "opacity-40" : "",
                        run ? (run.kind === "planning" ? "bg-[var(--w-cal-planning)]" : "bg-[var(--w-cal-run)]") : "",
                        run && date === run.start ? "rounded-l-[4px]" : "",
                        run && date === run.end ? "rounded-r-[4px]" : "",
                        isToday ? "rounded-[4px] bg-[var(--w-cal-today)] font-bold" : "",
                      ].filter(Boolean).join(" ")}
                    >
                      {cell.day}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
