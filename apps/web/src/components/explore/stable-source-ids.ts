/**
 * Frontend-only best-effort mapping from display name → stable
 * `sourceId` for the cached location-introduction feature.
 *
 * The server is the authoritative source of truth. The browser only
 * uses this map to decide whether the map drawer should render the
 * `LocationIntroductionPanel` for a given resolved place. Passing the
 * resulting `sourceId` to `POST /api/v1/explore/location-introductions`
 * is validated again server-side; an unknown sourceId returns 400.
 *
 * The list mirrors `apps/api/data/location-introduction/catalog.json`.
 * If the catalog is updated, update this map in lock-step — but the
 * map may fall behind. Mismatches simply cause the panel to not render.
 */
export const STABLE_SOURCE_IDS_BY_NAME: ReadonlyMap<string, string> = new Map<string, string>([
  ["tokyo", "tokyo"],
  ["kyoto", "kyoto"],
  ["osaka", "osaka"],
  ["paris", "paris"],
  ["lyon", "lyon"],
  ["lisbon", "lisbon"],
  ["barcelona", "barcelona"],
  ["madrid", "madrid"],
  ["rome", "rome"],
  ["florence", "florence"],
  ["amsterdam", "amsterdam"],
  ["berlin", "berlin"],
  ["vienna", "vienna"],
  ["prague", "prague"],
  ["reykjavík", "reykjavik"],
  ["reykjavik", "reykjavik"],
  ["london", "london"],
  ["edinburgh", "edinburgh"],
  ["new york", "newyork"],
  ["san francisco", "sanfrancisco"],
  ["mexico city", "mexicocity"],
  ["ciudad de mé", "mexicocity"],
  ["cape town", "capetown"],
  ["johannesburg", "johannesburg"],
  ["bali", "bali"],
  ["denpasar", "bali"],
  ["singapore", "singapore"],
  ["seoul", "seoul"],
  ["taipei", "taipei"],
  ["shanghai", "shanghai"],
  ["hong kong", "hongkong"],
  ["sydney", "sydney"],
  ["melbourne", "melbourne"],
]);

export function resolveStableSourceIdForName(displayName: string | null | undefined): string | null {
  if (!displayName) return null;
  const normalized = displayName.trim().toLocaleLowerCase();
  const direct = STABLE_SOURCE_IDS_BY_NAME.get(normalized);
  if (direct) return direct;
  // Strip common suffixes ("City", "Prefecture", "Province") so
  // "Tokyo Prefecture" still resolves to the same `tokyo` sourceId.
  const stripped = normalized
    .replace(/ city$/u, "")
    .replace(/ prefecture$/u, "")
    .replace(/ province$/u, "")
    .replace(/ region$/u, "")
    .trim();
  return STABLE_SOURCE_IDS_BY_NAME.get(stripped) ?? null;
}