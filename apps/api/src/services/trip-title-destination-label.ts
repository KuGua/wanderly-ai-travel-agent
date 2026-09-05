import { getLocationReferenceResolver } from "../location-reference/location-reference-resolver.js";

export type TitleDestinationLabelSource = "REFERENCE";

export type TitleDestinationLabel = {
  label: string;
  source: TitleDestinationLabelSource;
};

/**
 * Pure function. Resolves a candidate string into a display-only trip
 * destination label. The label is **country/region only** — never a city —
 * and lives in `shared_trips.title_destination_label`, never in
 * `destinationCandidates`, `constraint_snapshot`, or any provider query.
 * See docs/trip-title-destination-label-implementation.md §D2/D3 and §6.3.
 *
 * Returns `null` when:
 *   - the candidate resolves as a known city (the existing
 *     `destinationCandidates` path handles cities, no label needed), or
 *   - the candidate is neither a city nor a country in the reference data.
 *
 * Reference data load failure surfaces as `null`: this function is pure and
 * does not throw on missing datasets, matching the rest of the resolver's
 * fail-soft posture.
 */
export function resolveTitleDestinationLabel(params: {
  candidate: string;
  locale: "en" | "zh";
}): TitleDestinationLabel | null {
  const resolver = getLocationReferenceResolver();
  // Step 1: a city match short-circuits. Cities are not labels — they are
  // already a fact that the planner owns, so the title goes through the
  // existing destinationCandidates path.
  const cityMatch = resolver.resolveDestinationReference({
    destinationId: "title-destination-label",
    cityName: params.candidate,
  });
  if (cityMatch) return null;

  // Step 2: try the country label resolver. Picks the locale-appropriate
  // canonical name from the dataset; falls back to English when the
  // dataset has no Chinese entry for this country.
  const countryLabel = resolver.resolveCountryLabel(params.candidate);
  if (!countryLabel) return null;
  const label = params.locale === "zh" && countryLabel.nameZh
    ? countryLabel.nameZh
    : countryLabel.nameEn;
  if (!label) return null;
  return { label, source: "REFERENCE" };
}
