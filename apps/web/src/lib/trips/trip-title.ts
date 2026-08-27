export type TripTitleLocale = "en" | "zh";

// UI-only preview of the server-authoritative title rule. It intentionally
// accepts only the explicit draft fields; no conversation content is read.
export function buildTripTitlePreview(input: {
  destinationCandidates: string[];
  travelDateStart?: string | null;
  travelDateEnd?: string | null;
  locale: TripTitleLocale;
}): string {
  const destinations = input.destinationCandidates.map((value) => value.trim()).filter(Boolean).join(" · ");
  const days = inclusiveDays(input.travelDateStart, input.travelDateEnd);
  const planner = input.locale === "zh" ? "行程规划" : "Trip Planner";
  const suffix = input.locale === "zh" ? "天" : " Days";
  const destinationPlanner = input.locale === "zh" ? `${destinations}${planner}` : `${destinations} ${planner}`;
  if (destinations && days !== null) return `${destinationPlanner}｜${days}${suffix}`;
  if (destinations) return destinationPlanner;
  if (days !== null) return `${planner}｜${days}${suffix}`;
  return planner;
}

function inclusiveDays(start?: string | null, end?: string | null): number | null {
  const startMs = parseDate(start);
  const endMs = parseDate(end);
  if (startMs === null || endMs === null || endMs < startMs) return null;
  return Math.floor((endMs - startMs) / 86_400_000) + 1;
}

function parseDate(value?: string | null): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? ms : null;
}
