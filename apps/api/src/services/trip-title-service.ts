export type TripTitleLocale = "en" | "zh";

export type TripTitleInput = {
  destinationCandidates: string[];
  travelDateStart?: string | null;
  travelDateEnd?: string | null;
  locale: TripTitleLocale;
};

/**
 * Creates the persisted title from the explicit trip brief only.  This must
 * not receive conversation text, profile data, or inferred travel facts.
 */
export function buildTripTitle(input: TripTitleInput): string {
  const destinations = input.destinationCandidates
    .map((destination) => destination.trim())
    .filter(Boolean)
    .join(" · ");
  const days = tripDays(input.travelDateStart, input.travelDateEnd);
  const isChinese = input.locale === "zh";
  const planner = isChinese ? "行程规划" : "Trip Planner";
  const daySuffix = isChinese ? "天" : " Days";

  const destinationPlanner = isChinese ? `${destinations}${planner}` : `${destinations} ${planner}`;
  if (destinations && days !== null) return `${destinationPlanner}｜${days}${daySuffix}`;
  if (destinations) return destinationPlanner;
  if (days !== null) return `${planner}｜${days}${daySuffix}`;
  return planner;
}

/** Returns inclusive calendar days, or null if either ISO date is absent/invalid. */
export function tripDays(start?: string | null, end?: string | null): number | null {
  const startMs = isoDateAtUtc(start);
  const endMs = isoDateAtUtc(end);
  if (startMs === null || endMs === null || endMs < startMs) return null;
  return Math.floor((endMs - startMs) / 86_400_000) + 1;
}

export function isValidTripDate(value?: string | null): boolean {
  return isoDateAtUtc(value) !== null;
}

function isoDateAtUtc(value?: string | null): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? timestamp
    : null;
}
