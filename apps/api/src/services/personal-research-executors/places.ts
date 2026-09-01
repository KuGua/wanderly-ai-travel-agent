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

import { createOrsPlace } from "../../providers/live-provider-factory.js";
import type { NormalizedPlaceCandidate } from "../../providers/types.js";
import type {
  DestinationReference,
  PersonalResearchEvidenceSummary,
} from "../../types/domain.js";
import type { AgentTaskRow } from "../../tasks/task-repository.js";

export type PersonalResearchPlacesDraft = {
  kind: "PLACES_SEARCH";
  latitude: number;
  longitude: number;
  radiusMeters: number;
  category: "ATTRACTION" | "HOTEL" | "RESTAURANT" | "TRANSPORT_HUB" | "OTHER" | null;
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
  const provider = createOrsPlace();
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
    keyword: effectiveCategory,
    category: effectiveCategory,
    snapshotId: "",
    runId: params.run.id,
    signal: params.signal,
  };

  let result: { outcome: "LIVE"; data: NormalizedPlaceCandidate[]; source: string; capturedAt: string }
    | { outcome: "UNAVAILABLE"; reason: string };
  try {
    result = await provider.searchPlaces(input);
  } catch (err) {
    return unavailableSummaryFromError(err);
  }

  if (result.outcome === "UNAVAILABLE") {
    return unavailableSummaryFromReason(result.reason);
  }

  const candidates = (result.data ?? []).slice(0, params.draft.limit ?? 20);
  const categories = dedupe(candidates.map((c) => c.kind));

  return {
    outcome: "AVAILABLE",
    capability: "places.search",
    places: {
      candidateCount: candidates.length,
      categories,
      radiusMeters: params.draft.radiusMeters,
    },
  };
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