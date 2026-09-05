import { z } from "zod";

import { getLocationReferenceResolver } from "../location-reference/location-reference-resolver.js";

/**
 * Fail-closed postprocess for the LLM-suggested trip destination label
 * (docs/trip-title-destination-label-implementation.md §8.3).
 *
 * The model returns one of:
 *   - { kind: "CITY", value: "<free-text city name>" }
 *   - { kind: "COUNTRY", value: "<free-text country name>" }
 *   - { kind: "COUNTRY", value: "" } (model abstains)
 *
 * This module reduces the value to a canonical reference-data name or
 * rejects it. The closed vocabulary + the reparse step are what keep a
 * free-text string (URL, email, sentence fragment, etc.) from ever reaching
 * `shared_trips.title_destination_label`. The thread-title postprocess's
 * URL / email / long-digit / verbatim-echo rules are intentionally omitted
 * here — those shapes cannot survive the reparse-and-replace round trip.
 */

const CONTROL_CHARS_REGEX = /[\p{Cc}\p{Cf}]/gu;
const EMOJI_REGEX = /\p{Extended_Pictographic}/gu;
const TAG_AND_VARIATION_REGEX = /[\u{E0000}-\u{E0FFF}]/gu;
const PRIVATE_USE_AREA_REGEX = /[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;
const WHITESPACE_RUN_REGEX = /\s+/gu;

const MAX_LABEL_CODE_POINTS = 64;

export type PostprocessLabelInput = {
  kind: "COUNTRY" | "CITY";
  value: string;
};

export type PostprocessLabelResult =
  | { ok: true; kind: "COUNTRY" | "CITY"; value: string }
  | { ok: false; reason: "REJECTED" };

export function postprocessTripDestinationLabel(
  raw: PostprocessLabelInput,
  locale: "en" | "zh",
): PostprocessLabelResult {
  // 1. NFKC + whitespace fold + control/emoji strip + trim.
  const folded = raw.value.normalize("NFKC").replace(CONTROL_CHARS_REGEX, "");
  const cleaned = folded
    .replace(EMOJI_REGEX, "")
    .replace(TAG_AND_VARIATION_REGEX, "")
    .replace(PRIVATE_USE_AREA_REGEX, "")
    .replace(WHITESPACE_RUN_REGEX, " ")
    .trim();
  if (!cleaned) return { ok: false, reason: "REJECTED" };

  // 2. Hard 64-code-point cap. We never truncate a place name — a truncated
  // "San Francisco" is no longer a place name, and a "bare" 32-character
  // value is exactly the privacy hole a closed vocabulary is meant to seal.
  if (Array.from(cleaned).length > MAX_LABEL_CODE_POINTS) {
    return { ok: false, reason: "REJECTED" };
  }

  // 3 & 4. Reparse against the location reference data. This is the single
  // gate that prevents free-text from ever reaching the trip row.
  const resolver = getLocationReferenceResolver();
  if (raw.kind === "CITY") {
    const ref = resolver.resolveDestinationReference({
      destinationId: "label-postprocess",
      cityName: cleaned,
    });
    if (!ref) return { ok: false, reason: "REJECTED" };
    // Reparse succeeded — the resolver already returned the canonical
    // `cityName` from the dataset. The locale is a no-op here because
    // city names in GeoNames do not have parallel zh/en forms.
    void locale;
    return { ok: true, kind: "CITY", value: ref.cityName };
  }
  // raw.kind === "COUNTRY"
  const country = resolver.resolveCountryLabel(cleaned);
  if (!country) return { ok: false, reason: "REJECTED" };
  const label = locale === "zh" && country.nameZh ? country.nameZh : country.nameEn;
  if (!label) return { ok: false, reason: "REJECTED" };
  return { ok: true, kind: "COUNTRY", value: label };
}

/**
 * Zod schema mirror for the upstream `OUTPUT_INVALID` short-circuit. The
 * gateway already parses against `{ kind, value }`; this stricter schema
 * exists so the route can refuse an obviously-empty value without paying
 * for the resolver call.
 */
export const tripDestinationLabelOutputShapeSchema = z.object({
  kind: z.enum(["COUNTRY", "CITY"]),
  value: z.string(),
});
