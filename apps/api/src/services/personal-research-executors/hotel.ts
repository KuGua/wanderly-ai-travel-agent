/**
 * Personal hotel-search executor.
 *
 * Owner-only typed input from the DRAFT Personal Research confirm path.
 * Calls `createHotelProvider()` directly (NEVER the Shared
 * `executeAndPersistHotelSearch` persistence layer) and projects the result
 * to the bounded `personalResearchHotelEvidenceSummarySchema` shape.
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

export type PersonalResearchHotelDraft = {
  kind: "HOTEL_SEARCH";
  cityCode: string;
  checkIn: string;
  checkOut: string;
  occupancy: { adults: number; rooms: number };
  currency: string;
};

export async function executePersonalHotelSearch(params: {
  run: AgentTaskRow;
  draft: PersonalResearchHotelDraft;
  signal: AbortSignal;
}): Promise<PersonalResearchEvidenceSummary> {
  if (params.run.tripId === null || params.run.threadId === null) {
    throw new Error("Personal hotel run is missing trip/thread binding");
  }
  const provider = createHotelProvider();
  if (provider.providerName === "unconfigured") {
    return unavailableSummary("NOT_CONFIGURED");
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
    return unavailableSummary("SEARCH_CONSTRAINTS_INCOMPLETE");
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
    return unavailableSummaryFromError(err);
  }

  if (result.outcome === "UNAVAILABLE") {
    return unavailableSummaryFromReason(result.reason);
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

  return {
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
      topOffers: toTopOffers(offers),
    },
  };
}

/**
 * Bounded per-property line items, cheapest first, so the model can actually
 * answer "which one / how much" instead of only aggregate min/max stats.
 * Capped at 5 — same privacy boundary as the aggregate fields (no booking
 * link, offer id, or raw provider payload).
 */
function toTopOffers(offers: HotelProviderItem[]): {
  propertyName: string;
  pricePerNight: number;
  cancellationSummary: string | null;
}[] {
  return [...offers]
    .filter((offer) => Number.isFinite(Number(offer.pricePerNight)))
    .sort((a, b) => Number(a.pricePerNight) - Number(b.pricePerNight))
    .slice(0, 5)
    .map((offer) => ({
      propertyName: offer.propertyName,
      pricePerNight: Number(offer.pricePerNight),
      cancellationSummary: offer.cancellationSummary ?? null,
    }));
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
