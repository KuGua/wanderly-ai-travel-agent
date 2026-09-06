import type { PlanValidationViolation } from "../policy/plan-output-validator.js";
import type {
  AccommodationEvidence, ActivityEvidence, FlightOffer, HotelOffer, StayOffer,
} from "../types/domain.js";

type Evidence = FlightOffer | StayOffer | ActivityEvidence | HotelOffer | AccommodationEvidence;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type CategorySlot = "flights" | "stays" | "activities" | "hotels";
type EvidenceCategory = CategorySlot | "accommodations";

const SLOT_REASONS = {
  slotMismatch: "Offer id does not belong to this slot's provider evidence",
  notFound: "Offer is not present in any slot's provider evidence",
} as const;

function buildIdSets(params: {
  flights: readonly FlightOffer[];
  stays: readonly StayOffer[];
  activities: readonly ActivityEvidence[];
  hotels?: readonly HotelOffer[];
  accommodations?: readonly AccommodationEvidence[];
}): Record<EvidenceCategory, Set<string>> {
  return {
    flights: new Set(params.flights.map((value) => value.id)),
    stays: new Set(params.stays.map((value) => value.id)),
    activities: new Set(params.activities.map((value) => value.id)),
    hotels: new Set((params.hotels ?? []).map((value) => value.id)),
    accommodations: new Set((params.accommodations ?? []).map((value) => value.id)),
  };
}

/**
 * Deterministic preflight: every compact `{id}` selection must reference an
 * entry that exists in the SAME slot's authoritative id-set. A selection
 * whose id belongs to a different slot is `EVIDENCE_SLOT_MISMATCH`; a
 * selection whose id belongs to no slot is `EVIDENCE_NOT_FOUND`.
 *
 * The preflight is the boundary that prevents a model from quietly moving a
 * hotel id into `stays[]` (or any other cross-slot swap) and letting the
 * binder silently leave the bare `{id}` reference. It runs before binding
 * so the more-specific code can win over the general "id not in this
 * slot" finding.
 *
 * This function MUST NOT include the offending id, the model text, or any
 * provider payload in its return values, logs, or downstream consumers.
 * The `fieldPath` (`<category>.<index>`) is the only piece of identifying
 * information; `reason` is a closed literal.
 */
export function preflightCategorySlots(params: {
  candidate: Record<string, unknown>;
  flights: readonly FlightOffer[];
  stays: readonly StayOffer[];
  activities: readonly ActivityEvidence[];
  hotels?: readonly HotelOffer[];
  accommodations?: readonly AccommodationEvidence[];
}): PlanValidationViolation[] {
  const sets = buildIdSets(params);
  const ownSets: Record<CategorySlot, Set<string>> = {
    flights: sets.flights,
    stays: sets.stays,
    activities: sets.activities,
    hotels: sets.hotels,
  };
  const violations: PlanValidationViolation[] = [];
  const slots: CategorySlot[] = ["flights", "stays", "activities", "hotels"];
  for (const slot of slots) {
    const raw = params.candidate[slot];
    if (!Array.isArray(raw)) continue;
    raw.forEach((entry, index) => {
      if (!isRecord(entry)) return;
      if (typeof entry.id !== "string") return;
      const entryId = entry.id;
      const fieldPath = `${slot}.${index}`;
      if (ownSets[slot].has(entryId)) return;
      // Cross-slot detection: id belongs to one of the other four slots.
      const otherCategories: EvidenceCategory[] = ["flights", "stays", "activities", "hotels", "accommodations"];
      const belongsToOtherSlot = otherCategories.some((candidate) => candidate !== slot && sets[candidate].has(entryId));
      if (belongsToOtherSlot) {
        violations.push({ code: "EVIDENCE_SLOT_MISMATCH", fieldPath, reason: SLOT_REASONS.slotMismatch });
      } else {
        violations.push({ code: "EVIDENCE_NOT_FOUND", fieldPath, reason: SLOT_REASONS.notFound });
      }
    });
  }
  return violations;
}

/**
 * Field paths that the preflight already reported as `EVIDENCE_SLOT_MISMATCH`.
 * The deterministic validator uses this to suppress the duplicate
 * `EVIDENCE_NOT_FOUND` / `EVIDENCE_MISMATCH` that `validateOfferEvidence`
 * would otherwise emit for the same path — the more-specific code wins.
 */
export function mismatchedPathsFrom(violations: readonly PlanValidationViolation[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const violation of violations) {
    if (violation.code === "EVIDENCE_SLOT_MISMATCH") out.add(violation.fieldPath);
  }
  return out;
}

function bindSelections<T extends Evidence>(selections: unknown, evidence: readonly T[]): unknown {
  if (!Array.isArray(selections)) return selections;
  return selections.map((selection) => {
    if (!isRecord(selection) || typeof selection.id !== "string") return selection;
    const matches = evidence.filter((candidate) => candidate.id === selection.id);
    // A model-selected id is only a reference. Replace it with the complete
    // server-owned normalized object when and only when it resolves uniquely;
    // unknown or ambiguous selections remain unmodified so validation fails.
    return matches.length === 1 ? matches[0] : selection;
  });
}

/**
 * Rebind model-selected evidence ids to the authoritative normalized objects.
 * The LLM chooses among evidence returned by Tools, but it is not trusted to
 * reproduce provider ids, provenance timestamps, or nullable fields exactly.
 */
export function bindPlanSelectionsToEvidence(params: {
  candidate: Record<string, unknown>;
  flights: readonly FlightOffer[];
  stays: readonly StayOffer[];
  activities: readonly ActivityEvidence[];
  hotels?: readonly HotelOffer[];
}): Record<string, unknown> {
  const hotels = params.hotels ?? [];
  const bound = {
    ...params.candidate,
    flights: bindSelections(params.candidate.flights, params.flights),
    stays: bindSelections(params.candidate.stays, params.stays),
    ...(Object.hasOwn(params.candidate, "activities")
      ? { activities: bindSelections(params.candidate.activities, params.activities) }
      : {}),
    ...(Object.hasOwn(params.candidate, "hotels")
      ? { hotels: bindSelections(params.candidate.hotels, hotels) }
      : {}),
  };
  const selected = [bound.flights, bound.stays, bound.activities, bound.hotels]
    .flatMap((value) => Array.isArray(value) ? value : [])
    .filter(isRecord);
  const authoritativeById = new Map<string, Evidence>(
    [...params.flights, ...params.stays, ...params.activities, ...hotels]
      .map((value) => [value.id, value]),
  );
  const authoritativeTimestamps: string[] = [];
  for (const value of selected) {
    if (typeof value.id !== "string") continue;
    const evidence = authoritativeById.get(value.id);
    if (evidence && (evidence as unknown) === (value as unknown)) {
      authoritativeTimestamps.push(evidence.capturedAt);
    }
  }
  const capturedAt = authoritativeTimestamps.sort().at(-1);
  return capturedAt ? { ...bound, generatedAt: capturedAt } : bound;
}
