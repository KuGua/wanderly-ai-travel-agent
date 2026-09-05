/**
 * Personal flight-search executor.
 *
 * Owner-only typed input from the DRAFT Personal Research confirm path.
 * Calls `createFlightProvider()` directly (NEVER the Shared
 * `executeAndPersistFlightSearch` persistence layer) and projects the result
 * to the bounded `personalResearchFlightEvidenceSummarySchema` shape.
 *
 * Returns both the chat-bound summary AND the offer-cue candidate
 * projection: the summary drives the existing result-card UI; the
 * projection is the bounded, opaque-identity payload that
 * `personal-research-service.ts` writes to
 * `personal_research_offer_candidates` so the Offer Cue resolver can
 * reference candidates across refreshes / reconnects / re-searches.
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
import type { FlightOfferCandidateProjection } from "../personal-research-offer-candidate-service.js";

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

export interface PersonalResearchFlightExecutorResult {
  summary: PersonalResearchEvidenceSummary;
  candidateProjections: FlightOfferCandidateProjection[];
}

export async function executePersonalFlightSearch(params: {
  run: AgentTaskRow;
  draft: PersonalResearchFlightDraft;
  signal: AbortSignal;
}): Promise<PersonalResearchFlightExecutorResult> {
  const provider = createFlightProvider();
  if (provider.providerName === "unconfigured") {
    return unavailableResult("NOT_CONFIGURED");
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
    return unavailableResultFromError(err);
  }

  if (result.outcome === "UNAVAILABLE") {
    return unavailableResultFromReason(result.reason);
  }

  const offers = result.data ?? [];
  const sorted = [...offers].sort((a, b) => {
    const aTime = earliestSegment(a);
    const bTime = earliestSegment(b);
    return aTime.localeCompare(bTime);
  });
  const earliestDeparture = sorted[0] ? earliestSegment(sorted[0]) : null;
  const latestReturn = sorted.length > 0 ? latestReturnSegment(sorted[sorted.length - 1]) : null;

  // Cheapest-first projection is what the model wants when ranking "most
  // affordable direct" vs "morning flight", and is what the candidate
  // identity layer needs to persist ordinals 0..4 with deterministic
  // uniqueness on (offer_set_id, ordinal).
  const projected = [...offers]
    .filter((offer) => (offer.segments ?? []).length > 0)
    .sort((a, b) => a.totalPrice - b.totalPrice)
    .slice(0, 5);

  const candidateProjections: FlightOfferCandidateProjection[] = projected.map((offer, index) => {
    const segments = offer.segments;
    const first = segments[0]!;
    const last = segments[segments.length - 1]!;
    return {
      ordinal: index,
      carrierCode: first.carrierCode,
      flightNumber: first.flightNumber || null,
      departureAt: first.departureAt,
      arrivalAt: last.arrivalAt,
      totalDuration: offer.totalDuration,
      totalPrice: offer.totalPrice,
      currency: params.draft.currency,
      stopCount: Math.max(segments.length - 1, 0),
    };
  });

  return {
    summary: {
      outcome: "AVAILABLE",
      capability: "flight.search",
      supplier: result.source,
      capturedAt: result.capturedAt,
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
        topOffers: projected.map((offer) => {
          const segments = offer.segments;
          const first = segments[0]!;
          const last = segments[segments.length - 1]!;
          return {
            carrierCode: first.carrierCode,
            flightNumber: first.flightNumber || null,
            departureAt: first.departureAt,
            arrivalAt: last.arrivalAt,
            totalDuration: offer.totalDuration,
            totalPrice: offer.totalPrice,
            stopCount: Math.max(segments.length - 1, 0),
          };
        }),
      },
    },
    candidateProjections,
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
  | "PROVIDER_NOT_APPROVED"
  | "PROVIDER_REQUEST_REJECTED";

const ALLOWED_UNAVAILABLE_CODES: UnavailableCode[] = [
  "NOT_CONFIGURED",
  "SEARCH_CONSTRAINTS_INCOMPLETE",
  "NO_RESULTS",
  "RATE_LIMITED",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_FAILURE",
  "INVALID_PROVIDER_RESPONSE",
  "PROVIDER_NOT_APPROVED",
  "PROVIDER_REQUEST_REJECTED",
];

function unavailableSummary(errorCode: UnavailableCode): PersonalResearchEvidenceSummary {
  return { outcome: "UNAVAILABLE", summary: { errorCode } };
}

function unavailableResult(errorCode: UnavailableCode): PersonalResearchFlightExecutorResult {
  return { summary: unavailableSummary(errorCode), candidateProjections: [] };
}

function unavailableResultFromReason(reason: string): PersonalResearchFlightExecutorResult {
  if ((ALLOWED_UNAVAILABLE_CODES as string[]).includes(reason)) {
    return unavailableResult(reason as UnavailableCode);
  }
  return unavailableResult("UPSTREAM_FAILURE");
}

function unavailableResultFromError(err: unknown): PersonalResearchFlightExecutorResult {
  if (err instanceof Error && err.name === "AbortError") return unavailableResult("UPSTREAM_TIMEOUT");
  return unavailableResult("UPSTREAM_FAILURE");
}
