/**
 * Personal place-search executor.
 *
 * Owner-only typed input from the DRAFT Personal Research confirm path.
 * Calls the ORS Place adapter directly (NEVER the Shared place-adoption
 * flow) and projects the result to the bounded
 * `personalResearchPlacesEvidenceSummarySchema` shape.
 *
 * Privacy: Personal places are STRICTLY owner-advisory. The executor NEVER
 * writes to `trip_places`. The summary exposes candidates + categories +
 * radius only; coordinates stay inside the bounded summary until the owner
 * manually adopts them via the Shared `/trips/:tripId/route-endpoints`
 * adopt endpoint. Source: docs/draft-personal-research-implementation.md
 * §3.5 stage 3.
 */

import { createOpenTripMapPlace, createOrsPlace } from "../../providers/live-provider-factory.js";
import type { NormalizedPlaceCandidate } from "../../providers/types.js";
import type {
  DestinationReference,
  PersonalResearchEvidenceSummary,
} from "../../types/domain.js";
import type { AgentTaskRow } from "../../tasks/task-repository.js";
import { PERSONAL_RESEARCH_EVIDENCE_ITEM_LIMIT } from "../../types/schemas.js";

export type PersonalResearchPlacesDraft = {
  kind: "PLACES_SEARCH";
  latitude: number;
  longitude: number;
  radiusMeters: number;
  category: "ATTRACTION" | "HOTEL" | "RESTAURANT" | "TRANSPORT_HUB" | "OTHER" | null;
  keyword: string | null;
  limit: number | null;
};

export async function executePersonalPlacesSearch(params: {
  run: AgentTaskRow;
  draft: PersonalResearchPlacesDraft;
  signal: AbortSignal;
}): Promise<PersonalResearchEvidenceSummary> {
  if (params.run.tripId === null) {
    throw new Error("Personal places run is missing trip binding");
  }
  const effectiveCategory: "ATTRACTION" | "HOTEL" | "RESTAURANT" | "TRANSPORT_HUB" | "OTHER" =
    params.draft.category ?? "OTHER";

  // The typed draft carries lat/lng + radius. The adapter still wants a
  // `DestinationReference`, so we synthesize a minimal one anchored at the
  // search centroid.
  const destination: DestinationReference = {
    destinationId: `${params.draft.latitude.toFixed(4)},${params.draft.longitude.toFixed(4)}`,
    cityName: "",
    countryCode: "",
    latitude: params.draft.latitude,
    longitude: params.draft.longitude,
  };

  const input = {
    destination,
    // The traveller's words, not the category name. Passing the category here
    // asked a geocoder to find a place *called* "ATTRACTION"; the adapter now
    // treats a keyword equal to the category as no keyword and looks around
    // the point instead, but sending the right thing is the actual fix.
    keyword: params.draft.keyword ?? "",
    category: effectiveCategory,
    // Carried through so the radius the caller stated bounds the search
    // rather than merely being echoed back in the summary.
    radiusMeters: params.draft.radiusMeters,
    snapshotId: "",
    runId: params.run.id,
    signal: params.signal,
  };

  // OpenTripMap knows places by kind and by how notable they are, which is
  // what "what is worth seeing near here" needs. ORS is a geocoder and stays
  // as the fallback for wherever OpenTripMap has no coverage — losing the
  // search entirely would be worse than a coarser answer.
  const providers = [createOpenTripMapPlace(), createOrsPlace()]
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);

  let result: { outcome: "LIVE"; data: NormalizedPlaceCandidate[]; source: string; capturedAt: string }
    | { outcome: "UNAVAILABLE"; reason: string } = { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" };
  for (const provider of providers) {
    try {
      result = await provider.searchPlaces(input);
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return unavailableSummaryFromError(err);
      result = { outcome: "UNAVAILABLE", reason: "UPSTREAM_FAILURE" };
    }
    if (result.outcome === "LIVE") break;
  }

  if (result.outcome === "UNAVAILABLE") {
    return unavailableSummaryFromReason(result.reason);
  }

  const candidates = (result.data ?? []).slice(0, params.draft.limit ?? 20);
  const categories = dedupe(candidates.map((c) => c.kind));

  return {
    outcome: "AVAILABLE",
    capability: "places.search",
    supplier: result.source,
    capturedAt: result.capturedAt,
    places: {
      // The place names. A count and a category list could not answer
      // "which restaurants", which is the whole question.
      items: candidates.slice(0, PERSONAL_RESEARCH_EVIDENCE_ITEM_LIMIT).map((candidate) => ({
        label: candidate.displayName,
        // Geocoding returns no prices, and inventing a null-priced item is
        // more honest than implying one exists.
        price: null,
        // How far it is, when the provider said. A list of names alone cannot
        // answer "is it walkable from here", which is most of why someone
        // asks what is nearby.
        detail: Number.isFinite(candidate.distanceKm)
          ? `${candidate.kind} · ${formatDistance(candidate.distanceKm as number)}`
          : candidate.kind,
      })),
      candidateCount: candidates.length,
      categories,
      radiusMeters: params.draft.radiusMeters,
    },
  };
}

/** Metres below a kilometre, so "300 m" does not read as "0.3 km". */
function formatDistance(distanceKm: number): string {
  return distanceKm < 1
    ? `${Math.round(distanceKm * 1000)} m`
    : `${distanceKm.toFixed(1)} km`;
}

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

type UnavailableCode =
  | "NOT_CONFIGURED"
  | "SEARCH_CONSTRAINTS_INCOMPLETE"
  | "NO_RESULTS"
  | "RATE_LIMITED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_FAILURE"
  | "INVALID_PROVIDER_RESPONSE"
  | "PROVIDER_NOT_APPROVED";

const ALLOWED_UNAVAILABLE_CODES: UnavailableCode[] = [
  "NOT_CONFIGURED",
  "SEARCH_CONSTRAINTS_INCOMPLETE",
  "NO_RESULTS",
  "RATE_LIMITED",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_FAILURE",
  "INVALID_PROVIDER_RESPONSE",
  "PROVIDER_NOT_APPROVED",
];

function unavailableSummary(errorCode: UnavailableCode): PersonalResearchEvidenceSummary {
  return { outcome: "UNAVAILABLE", summary: { errorCode } };
}

function unavailableSummaryFromReason(reason: string): PersonalResearchEvidenceSummary {
  if ((ALLOWED_UNAVAILABLE_CODES as string[]).includes(reason)) {
    return unavailableSummary(reason as UnavailableCode);
  }
  return unavailableSummary("UPSTREAM_FAILURE");
}

function unavailableSummaryFromError(err: unknown): PersonalResearchEvidenceSummary {
  if (err instanceof Error && err.name === "AbortError") return unavailableSummary("UPSTREAM_TIMEOUT");
  return unavailableSummary("UPSTREAM_FAILURE");
}