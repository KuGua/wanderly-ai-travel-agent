/**
 * Personal flight-search executor.
 *
 * Owner-only typed input from the DRAFT Personal Research confirm path.
 * Calls `createFlightProvider()` directly (NEVER the Shared
 * `executeAndPersistFlightSearch` persistence layer) and projects the result
 * to the bounded `personalResearchFlightEvidenceSummarySchema` shape.
 *
 * Privacy: the executor never reads or writes chat bodies, nationality,
 * passport, or document data. The `provider_offers` / `provider_search_runs`
 * snapshot-bound tables are not touched.
 *
 * Source: docs/draft-personal-research-implementation.md §3.2, §3.5.
 */

import { createFlightProvider } from "../../providers/live-provider-factory.js";
import type { ProviderResult } from "../../providers/types.js";
import type { FlightOffer, PersonalResearchEvidenceSummary } from "../../types/domain.js";
import type { AgentTaskRow } from "../../tasks/task-repository.js";
import { PERSONAL_RESEARCH_EVIDENCE_ITEM_LIMIT } from "../../types/schemas.js";

export type PersonalResearchFlightDraft = {
  kind: "FLIGHT_SEARCH";
  originId: string;
  destinationId: string;
  tripType: "ONE_WAY" | "ROUND_TRIP";
  departureDate: string;
  returnDate: string | null;
  adults: number;
  cabin: "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";
  currency: string;
};

export async function executePersonalFlightSearch(params: {
  run: AgentTaskRow;
  draft: PersonalResearchFlightDraft;
  signal: AbortSignal;
}): Promise<PersonalResearchEvidenceSummary> {
  const provider = createFlightProvider();
  if (provider.providerName === "unconfigured") {
    return unavailableSummary("NOT_CONFIGURED");
  }

  const input = {
    origin: params.draft.originId,
    destination: params.draft.destinationId,
    dateStart: params.draft.departureDate,
    dateEnd: params.draft.returnDate ?? params.draft.departureDate,
    snapshotId: "",
    tripType: params.draft.tripType,
    adults: params.draft.adults,
    cabin: params.draft.cabin,
    currency: params.draft.currency,
    signal: params.signal,
  };

  let result: ProviderResult<FlightOffer[]>;
  try {
    result = await provider.searchFlights(input);
  } catch (err) {
    return unavailableFromError(err);
  }

  if (result.outcome === "UNAVAILABLE") {
    return unavailableSummaryFromReason(result.reason);
  }

  const offers = result.data ?? [];
  const sorted = [...offers].sort((a, b) => {
    const aTime = earliestSegment(a);
    const bTime = earliestSegment(b);
    return aTime.localeCompare(bTime);
  });
  const earliestDeparture = sorted[0] ? earliestSegment(sorted[0]) : null;
  const latestReturn = sorted.length > 0 ? latestReturnSegment(sorted[sorted.length - 1]) : null;

  return {
    outcome: "AVAILABLE",
    capability: "flight.search",
    flight: {
      // The offers themselves, not just how many there were. A count told
      // the model nothing it could answer with, so it answered from memory.
      items: sorted.slice(0, PERSONAL_RESEARCH_EVIDENCE_ITEM_LIMIT).map((offer) => ({
        label: `${offer.origin} → ${offer.destination}`,
        price: { amount: offer.totalPrice, currency: offer.currency, unit: "TOTAL" as const },
        detail: [offer.cabin, `${offer.segments.length} 段`].join(" · "),
      })),
      offerCount: offers.length,
      currency: params.draft.currency,
      originIata: params.draft.originId,
      destinationIata: params.draft.destinationId,
      earliestDeparture: earliestDeparture || null,
      latestReturn,
    },
  };
}

function earliestSegment(offer: FlightOffer): string {
  const segments = offer.segments ?? [];
  if (segments.length === 0) return "";
  return segments.reduce((acc, s) => (s.departureAt && s.departureAt < acc ? s.departureAt : acc), segments[0].departureAt ?? "");
}

function latestReturnSegment(offer: FlightOffer): string | null {
  const segments = offer.segments ?? [];
  if (segments.length === 0) return null;
  const last = segments[segments.length - 1];
  return last.arrivalAt ?? null;
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

function unavailableFromError(err: unknown): PersonalResearchEvidenceSummary {
  if (err instanceof Error && err.name === "AbortError") return unavailableSummary("UPSTREAM_TIMEOUT");
  return unavailableSummary("UPSTREAM_FAILURE");
}