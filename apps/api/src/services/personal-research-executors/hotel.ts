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
 * `loadActiveQuoteNationality`. A missing binding returns
 * `UNAVAILABLE` with code `SEARCH_CONSTRAINTS_INCOMPLETE` — same shape as
 * the Shared path; the Personal route never copies the binding into the
 * confirmed-task row (the binding remains trip-scoped Shared state).
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
  let quoteNationality: string | undefined;
  if (provider.providerName === "nuitee_connect") {
    const binding = await loadActiveQuoteNationality({
      tripId: params.run.tripId!,
      memberId: params.run.createdByUserId,
    });
    if (!binding) {
      // Per spec §3.5 stage 2: Nuitee must cover provider-only nationality
      // authorization. Missing binding fails closed — the owner must grant
      // it through the Shared authorization endpoint before the Personal
      // path can run.
      return unavailableSummary("SEARCH_CONSTRAINTS_INCOMPLETE");
    }
    quoteNationality = binding.nationality;
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
  const prices = offers
    .map((o) => Number(o.totalPrice))
    .filter((p) => Number.isFinite(p));
  const minPrice = prices.length > 0 ? Math.min(...prices) : null;
  const maxPrice = prices.length > 0 ? Math.max(...prices) : null;

  return {
    outcome: "AVAILABLE",
    capability: "hotel.search",
    hotel: {
      propertyCount: offers.length,
      currency: params.draft.currency,
      cityCode: params.draft.cityCode,
      checkIn: params.draft.checkIn,
      checkOut: params.draft.checkOut,
      minNightlyPrice: minPrice,
      maxNightlyPrice: maxPrice,
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