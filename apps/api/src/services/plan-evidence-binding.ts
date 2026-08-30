import type { ActivityEvidence, FlightOffer, StayOffer } from "../types/domain.js";

type Evidence = FlightOffer | StayOffer | ActivityEvidence;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
}): Record<string, unknown> {
  const bound = {
    ...params.candidate,
    flights: bindSelections(params.candidate.flights, params.flights),
    stays: bindSelections(params.candidate.stays, params.stays),
    ...(Object.hasOwn(params.candidate, "activities")
      ? { activities: bindSelections(params.candidate.activities, params.activities) }
      : {}),
  };
  const selected = [bound.flights, bound.stays, bound.activities]
    .flatMap((value) => Array.isArray(value) ? value : [])
    .filter(isRecord);
  const authoritativeById = new Map<string, Evidence>(
    [...params.flights, ...params.stays, ...params.activities].map((value) => [value.id, value]),
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
