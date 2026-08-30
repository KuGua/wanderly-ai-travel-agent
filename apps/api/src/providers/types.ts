import type { FlightOffer, StayOffer, VisaReadinessResult } from "../types/domain.js";

// ─── Provider Interfaces ────────────────────────────────────────────────────

export interface FlightProvider {
  /** Stable, non-secret provider identity persisted with normalized evidence. */
  readonly providerName: "amadeus" | "flightapi" | "serpapi" | "unconfigured";
  searchFlights(params: FlightSearchParams): Promise<ProviderResult<FlightOffer[]>>;
}

export interface FlightSearchParams {
  origin: string;
  destination: string;
  dateStart: string;
  dateEnd: string;
  snapshotId: string;
  tripType?: "ONE_WAY" | "ROUND_TRIP";
  adults?: number;
  cabin?: "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";
  currency?: string;
  signal?: AbortSignal;
}

export interface StayProvider {
  searchStays(params: {
    destination: string;
    checkIn: string;
    checkOut: string;
    style?: string;
    snapshotId: string;
  }): Promise<ProviderResult<StayOffer[]>>;
}

export interface VisaProvider {
  checkReadiness(params: {
    nationality: string;
    destinationCountry: string;
    snapshotId: string;
  }): Promise<ProviderResult<VisaReadinessResult>>;
}

/**
 * Spec §5.1. Restricted keyword POI search. The model never submits
 * coordinates, provider name, or raw URLs; only `destinationId` (must match a
 * snapshot candidate), a keyword, and a category.
 */
export interface PlaceSearchProvider {
  searchPlaces(params: {
    destinationId: string;
    keyword: string;
    category: "ATTRACTION" | "HOTEL" | "RESTAURANT" | "TRANSPORT_HUB" | "OTHER";
    snapshotId: string;
    runId?: string;
    signal?: AbortSignal;
  }): Promise<ProviderResult<NormalizedPlaceCandidate[]>>;
}

/**
 * Spec §5.2. Snapshot- and run-bound walking / driving / cycling route. The
 * model only ever submits two authorized `placeId`s plus a mode; coordinates
 * are derived server-side from the current-trip place table.
 */
export interface NavigationProvider {
  searchRoute(params: {
    originPlaceId: string;
    destinationPlaceId: string;
    mode: "WALK" | "DRIVE" | "CYCLE";
    snapshotId: string;
    runId?: string;
    signal?: AbortSignal;
  }): Promise<ProviderResult<NormalizedRouteEvidence>>}

/**
 * Spec §5.3. Taxi / transfer / charter / rental offer search. The adapter
 * MUST drop any upstream booking link and only return offers carrying
 * `source`, `capturedAt`, `currency`, `expiresAt`, and an `estimated` flag.
 */
export interface MobilityOfferProvider {
  searchOffers(params: {
    originPlaceId: string;
    destinationPlaceId: string;
    passengers: number;
    departureAt: string;
    serviceType: "TAXI" | "TRANSFER" | "CHARTER" | "RENTAL";
    snapshotId: string;
    runId?: string;
    signal?: AbortSignal;
  }): Promise<ProviderResult<NormalizedMobilityOffer[]>>;
}

export type MobilityServiceType = "TAXI" | "TRANSFER" | "CHARTER" | "RENTAL";

/**
 * Spec §5.3. Reserved port for spec Phase 6 (transit schedules / fares).
 * Intentionally not implemented in this milestone; the factory returns
 * `UNAVAILABLE/NOT_CONFIGURED` until an approved supplier is registered.
 */
export interface TransitJourneyProvider {
  searchJourneys(params: {
    originPlaceId: string;
    destinationPlaceId: string;
    departureAt: string;
    snapshotId: string;
    runId?: string;
    signal?: AbortSignal;
  }): Promise<ProviderResult<NormalizedTransitJourney[]>>;
}

/**
 * Provider-neutral normalized shapes. Raw upstream payloads NEVER cross the
 * adapter boundary — they are validated against an allow-list Zod schema,
 * reshaped into these stable types, and persisted with `source`/`capturedAt`.
 */
export interface NormalizedPlaceCandidate {
  candidateId: string;
  displayName: string;
  kind: "ATTRACTION" | "HOTEL" | "RESTAURANT" | "TRANSPORT_HUB" | "OTHER";
  countryCode: string | null;
  cityName: string | null;
  longitude: number;
  latitude: number;
  confidence: number;
  needsUserConfirmation: boolean;
  source: string;
  capturedAt: string;
}

export interface NormalizedRouteStep {
  index: number;
  instruction: string;
  distanceMeters: number;
  durationSeconds: number;
}

export interface NormalizedRouteEvidence {
  originPlaceId: string;
  destinationPlaceId: string;
  mode: "WALK" | "DRIVE" | "CYCLE";
  distanceMeters: number;
  durationSeconds: number;
  steps: NormalizedRouteStep[];
  encodedGeometry: string;
  source: string;
  capturedAt: string;
  refreshAfter: string;
}

export interface NormalizedMobilityOffer {
  offerId: string;
  serviceType: "TAXI" | "TRANSFER" | "CHARTER" | "RENTAL";
  originPlaceId: string;
  destinationPlaceId: string;
  passengers: number;
  departureAt: string;
  estimatedPrice: number;
  currency: string;
  vehicleClass: string;
  estimated: true;
  expiresAt: string | null;
  source: string;
  capturedAt: string;
}

export interface NormalizedTransitJourney {
  originPlaceId: string;
  destinationPlaceId: string;
  mode: string;
  departureAt: string;
  arrivalAt: string;
  fare: { amount: number; currency: string } | null;
  source: string;
  capturedAt: string;
}

export interface ActivitiesProvider {
  searchActivities(params: ActivitiesSearchParams): Promise<ProviderResult<ActivityProviderItem[]>>;
}

export interface ActivitiesSearchParams {
  /** Snapshot-bound canonical destination; never free model text. */
  destination: string;
  dateStart: string;
  dateEnd: string;
  theme?: "CULTURE" | "FOOD" | "OUTDOOR" | "FAMILY";
  locale: "en" | "zh";
  limit: number;
  signal?: AbortSignal;
}

export interface ActivityProviderItem {
  providerOfferId: string;
  title: string;
  thumbnailUrl: string;
  rating: number | null;
  reviewCount: number;
  freeCancellation: boolean;
  durationMinutes: {
    fixed: number | null;
    from: number | null;
    to: number | null;
  };
  category: string | null;
}

export type ProviderResult<T> =
  | {
      outcome: "LIVE";
      data: T;
      source: string;
      capturedAt: string;
    }
  | {
      outcome: "UNAVAILABLE";
      reason:
        | "NOT_CONFIGURED"
        | "SEARCH_CONSTRAINTS_INCOMPLETE"
        | "NO_RESULTS"
        | "RATE_LIMITED"
        | "UPSTREAM_TIMEOUT"
        | "UPSTREAM_FAILURE"
        | "INVALID_PROVIDER_RESPONSE"
        | "PROVIDER_NOT_APPROVED";
    };
