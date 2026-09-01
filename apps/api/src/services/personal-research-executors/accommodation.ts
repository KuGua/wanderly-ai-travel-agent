/**
 * Personal accommodation-discovery executor.
 *
 * Owner-only typed input from the DRAFT Personal Research confirm path.
 * Calls the OpenTripMap adapter directly (NEVER the Shared accommodation
 * discovery persistence layer) and projects the result to the bounded
 * `personalResearchAccommodationEvidenceSummarySchema` shape.
 *
 * The summary exposes only the candidate COUNT and the bounding box of
 * the search — never per-candidate coordinates, price, popularity tier,
 * or any field that could seed the Shared `trip_places` table. The owner
 * may manually adopt suggestions through the Shared adopt endpoint.
 *
 * Source: docs/draft-personal-research-implementation.md §3.5 stage 2.
 */

import { createAccommodationDiscoveryProvider } from "../../providers/live-provider-factory.js";
import type { AccommodationProviderItem } from "../../providers/types.js";
import type {
  DestinationReference,
  PersonalResearchEvidenceSummary,
} from "../../types/domain.js";
import type { AgentTaskRow } from "../../tasks/task-repository.js";
import { resolveTripDestinationReference } from "../../services/destination-reference-service.js";
import { getLocationReferenceResolver } from "../../location-reference/location-reference-resolver.js";

export type PersonalResearchAccommodationDraft = {
  kind: "ACCOMMODATION_DISCOVERY";
  latitude: number;
  longitude: number;
  radiusMeters: number;
  checkIn: string;
  checkOut: string;
  occupancy: { adults: number; rooms: number };
};

export async function executePersonalAccommodationDiscovery(params: {
  run: AgentTaskRow;
  draft: PersonalResearchAccommodationDraft;
  signal: AbortSignal;
}): Promise<PersonalResearchEvidenceSummary> {
  if (params.run.tripId === null) {
    throw new Error("Personal accommodation run is missing trip binding");
  }
  const provider = createAccommodationDiscoveryProvider();

  // Resolve the trip's `destinationCandidates` first; fall back to a
  // centroid-anchored reference when the DRAFT trip has no candidate row.
  let destination: DestinationReference | null = null;
  destination = await resolveTripDestinationReference({
    tripId: params.run.tripId,
    destinationId: `${params.draft.latitude.toFixed(4)},${params.draft.longitude.toFixed(4)}`,
  });
  if (!destination) {
    // The draft already carries the search centroid, so there is nothing to
    // resolve: asking the resolver to turn a coordinate string back into a
    // known destination fails by construction, and it was the reason a DRAFT
    // trip with only manual destinations reported an incomplete search.
    // OpenTripMap queries by lat/lon, so a reference anchored on the draft's
    // own point is exactly what the adapter needs.
    destination = {
      destinationId: `${params.draft.latitude.toFixed(4)},${params.draft.longitude.toFixed(4)}`,
      cityName: "",
      countryCode: "",
      latitude: params.draft.latitude,
      longitude: params.draft.longitude,
    };
  }

  const input = {
    destination,
    limit: 20,
    signal: params.signal,
  };

  let result: { outcome: "LIVE"; data: AccommodationProviderItem[]; source: string; capturedAt: string }
    | { outcome: "UNAVAILABLE"; reason: string };
  try {
    result = await provider.discoverAccommodations(input);
  } catch (err) {
    return unavailableSummaryFromError(err);
  }

  if (result.outcome === "UNAVAILABLE") {
    return unavailableSummaryFromReason(result.reason);
  }

  const items = (result.data ?? []) as AccommodationProviderItem[];
  // The shared summary intentionally omits per-candidate coordinates; the
  // topCategory is derived from the dominant `kind` label so the owner UI
  // can render a meaningful chip without leaking lat/lng.
  const kindCounts = new Map<string, number>();
  for (const item of items) {
    kindCounts.set(item.kind, (kindCounts.get(item.kind) ?? 0) + 1);
  }
  let topCategory: string | null = null;
  let topCount = 0;
  for (const [kind, count] of kindCounts) {
    if (count > topCount) {
      topCategory = kind;
      topCount = count;
    }
  }

  return {
    outcome: "AVAILABLE",
    capability: "accommodation.discovery",
    accommodation: {
      candidateCount: items.length,
      topCategory,
      radiusMeters: params.draft.radiusMeters,
      checkIn: params.draft.checkIn,
      checkOut: params.draft.checkOut,
    },
  };
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