/**
 * Personal hotel-search executor.
 *
 * Owner-only typed input from the DRAFT Personal Research confirm path.
 * Calls `createHotelProvider()` directly (NEVER the Shared
 * `executeAndPersistHotelSearch` persistence layer) and projects the result
 * to the bounded `personalResearchHotelEvidenceSummarySchema` shape.
 *
 * Returns both the chat-bound summary AND the offer-cue candidate
 * projection so `personal-research-service.ts` can persist opaque
 * candidate identities that survive refresh / reconnect / re-search.
 *
 * Nuitee provider-only binding: when the resolved provider is
 * `nuitee_connect`, the executor resolves the active quote nationality via
 * `loadActiveQuoteNationality` if one exists. A missing binding no longer
 * fails closed (demo-scope simplification) — it falls back to a placeholder
 * nationality so the request stays well-formed.
 *
 * Personal destination resolution: the typed draft's `cityCode` (IATA) is
 * looked up against the trip's `destinationCandidates` first; if no row
 * exists (DRAFT trips may have only manual destinations), falls back to a
 * direct city-name resolution. Either path returns
 * `SEARCH_CONSTRAINTS_INCOMPLETE` on geographic ambiguity.
 *
 * Privacy: result_json is a Zod-validated bounded summary; raw provider
 * payloads, chat text, nationality, passport, and document fields never
 * land here. Source: docs/draft-personal-research-implementation.md §3.2.
 */

import { createHotelProvider } from "../../providers/live-provider-factory.js";
import type { HotelProviderItem } from "../../providers/types.js";
import type {
  DestinationReference,
  PersonalResearchEvidenceSummary,
} from "../../types/domain.js";
import type { AgentTaskRow } from "../../tasks/task-repository.js";
import { PERSONAL_RESEARCH_EVIDENCE_ITEM_LIMIT } from "../../types/schemas.js";
import { loadActiveQuoteNationality } from "../../services/stay-search-provider-authorization.js";
import { resolveTripDestinationReference } from "../../services/destination-reference-service.js";
import { getLocationReferenceResolver } from "../../location-reference/location-reference-resolver.js";
import type { HotelOfferCandidateProjection } from "../personal-research-offer-candidate-service.js";

export type PersonalResearchHotelDraft = {
  kind: "HOTEL_SEARCH";
  cityCode: string;
  checkIn: string;
  checkOut: string;
  occupancy: { adults: number; rooms: number };
  currency: string;
};

export interface PersonalResearchHotelExecutorResult {
  summary: PersonalResearchEvidenceSummary;
  candidateProjections: HotelOfferCandidateProjection[];
}

export async function executePersonalHotelSearch(params: {
  run: AgentTaskRow;
  draft: PersonalResearchHotelDraft;
  signal: AbortSignal;
}): Promise<PersonalResearchHotelExecutorResult> {
  if (params.run.tripId === null || params.run.threadId === null) {
    throw new Error("Personal hotel run is missing trip/thread binding");
  }
  const provider = createHotelProvider();
  if (provider.providerName === "unconfigured") {
    return unavailableResult("NOT_CONFIGURED");
  }

  // ─── Destination resolution ────────────────────────────────────────────
  // Try the trip's confirmed `destinationCandidates` row first; if absent,
  // resolve via the city-code → DestinationReference fallback (DRAFT trips
  // frequently have only manual destinations).
  let destination: DestinationReference | null = null;
  if (params.run.tripId) {
    destination = await resolveTripDestinationReference({
      tripId: params.run.tripId,
      destinationId: params.draft.cityCode,
    });
  }
  if (!destination) {
    destination = getLocationReferenceResolver().resolveDestinationReference({
      destinationId: params.draft.cityCode,
      cityName: params.draft.cityCode,
      countryHint: null,
    });
  }
  if (!destination) {
    return unavailableResult("SEARCH_CONSTRAINTS_INCOMPLETE");
  }

  // ─── Nuitee nationality binding (provider-only) ────────────────────────
  // Demo-scope simplification: no longer fails closed when the owner hasn't
  // granted a quote-nationality authorization. Reuses one if it exists;
  // otherwise falls back to a placeholder so the request stays well-formed.
  let quoteNationality: string | undefined;
  if (provider.providerName === "nuitee_connect") {
    const binding = await loadActiveQuoteNationality({
      tripId: params.run.tripId!,
      memberId: params.run.createdByUserId,
    });
    quoteNationality = binding?.nationality ?? "US";
  }

  const adultsPerRoom = Array.from(
    { length: params.draft.occupancy.rooms },
    () => params.draft.occupancy.adults,
  );

  const input = {
    destination,
    checkIn: params.draft.checkIn,
    checkOut: params.draft.checkOut,
    roomCount: params.draft.occupancy.rooms,
    adultsPerRoom,
    currency: params.draft.currency,
    locale: "en" as const,
    quoteNationality,
    signal: params.signal,
  };

  let result: { outcome: "LIVE"; data: HotelProviderItem[]; source: string; capturedAt: string }
    | { outcome: "UNAVAILABLE"; reason: string };
  try {
    result = await provider.searchHotels(input);
  } catch (err) {
    return unavailableResultFromError(err);
  }

  if (result.outcome === "UNAVAILABLE") {
    return unavailableResultFromReason(result.reason);
  }

  const offers: HotelProviderItem[] = result.data ?? [];
  // Bug fix: this used to read `totalPrice` (the whole-stay total) into a
  // field named "nightly price" — for a multi-night stay that inflated the
  // displayed per-night figure well above the real rate. `pricePerNight` is
  // the correct source.
  const nightlyPrices = offers
    .map((o) => Number(o.pricePerNight))
    .filter((p) => Number.isFinite(p));
  const minPrice = nightlyPrices.length > 0 ? Math.min(...nightlyPrices) : null;
  const maxPrice = nightlyPrices.length > 0 ? Math.max(...nightlyPrices) : null;

  // Cheapest-first projection (by pricePerNight) so the model ranks
  // affordability and the candidate identity layer writes ordinals 0..4.
  const projected = [...offers]
    .filter((offer) => Number.isFinite(Number(offer.pricePerNight)))
    .sort((a, b) => Number(a.pricePerNight) - Number(b.pricePerNight))
    .slice(0, 5);

  const nights = Math.max(1, Math.round(
    (Date.parse(params.draft.checkOut) - Date.parse(params.draft.checkIn)) / 86_400_000,
  ));
  const candidateProjections: HotelOfferCandidateProjection[] = projected.map((offer, index) => {
    const nightly = Number(offer.pricePerNight);
    const totalPrice = Number.isFinite(Number(offer.totalPrice))
      ? Number(offer.totalPrice)
      : nightly * nights;
    return {
      ordinal: index,
      propertyName: offer.propertyName,
      pricePerNight: nightly,
      totalPrice,
      currency: params.draft.currency,
      checkIn: params.draft.checkIn,
      checkOut: params.draft.checkOut,
      cancellationSummary: offer.cancellationSummary ?? null,
      roomSummary: offer.roomSummary ?? null,
      taxStatus: offer.taxesAndFees?.status ?? "UNKNOWN",
    };
  });

  return {
    summary: {
      outcome: "AVAILABLE",
      capability: "hotel.search",
      supplier: result.source,
      capturedAt: result.capturedAt,
      hotel: {
        // Named properties with their nightly rate. A min/max band answers
        // "roughly how much" but never "which one", which is the question a
        // traveller is actually asking.
        items: offers.slice(0, PERSONAL_RESEARCH_EVIDENCE_ITEM_LIMIT).map((offer) => ({
          label: offer.propertyName,
          price: Number.isFinite(offer.pricePerNight)
            ? { amount: offer.pricePerNight, currency: offer.currency, unit: "PER_NIGHT" as const }
            : null,
          detail: [
            `${offer.nights} 晚`,
            offer.taxesAndFees?.status === "INCLUDED" ? "含税费" : null,
            offer.cancellationSummary,
          ].filter(Boolean).join(" · ") || null,
        })),
        propertyCount: offers.length,
        currency: params.draft.currency,
        cityCode: params.draft.cityCode,
        checkIn: params.draft.checkIn,
        checkOut: params.draft.checkOut,
        minNightlyPrice: minPrice,
        maxNightlyPrice: maxPrice,
        topOffers: projected.map((offer) => ({
          propertyName: offer.propertyName,
          pricePerNight: Number(offer.pricePerNight),
          cancellationSummary: offer.cancellationSummary ?? null,
        })),
      },
    },
    candidateProjections,
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

function unavailableResult(errorCode: UnavailableCode): PersonalResearchHotelExecutorResult {
  return { summary: unavailableSummary(errorCode), candidateProjections: [] };
}

function unavailableResultFromReason(reason: string): PersonalResearchHotelExecutorResult {
  if ((ALLOWED_UNAVAILABLE_CODES as string[]).includes(reason)) {
    return unavailableResult(reason as UnavailableCode);
  }
  return unavailableResult("UPSTREAM_FAILURE");
}

function unavailableResultFromError(err: unknown): PersonalResearchHotelExecutorResult {
  if (err instanceof Error && err.name === "AbortError") return unavailableResult("UPSTREAM_TIMEOUT");
  return unavailableResult("UPSTREAM_FAILURE");
}
