import type {
  DestinationReference,
  FlightOffer,
  GroundOffer,
  HotelOffer,
  StayOffer,
  VisaReadinessResult,
} from "../types/domain.js";

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

/**
 * Adapter identity. Includes `"unconfigured"` for the in-tree
 * `UnavailableHotelProvider` placeholder so its identity never has to be
 * faked as one of the real providers. `"unconfigured"` is therefore never
 * permitted on persisted `HotelOffer.providerName`; see
 * `HotelOfferProviderName` below.
 */
export type HotelProviderName = "nuitee_connect" | "serpapi_google_hotels" | "unconfigured";

/**
 * Persisted/stamped offer identity. The adapter stamps this onto every
 * normalized item and into `provider_offers.provider_name`,
 * `provider_search_runs.provider_name`, and `agent_task_runs.hotel_provider`.
 * An offer only exists when a real adapter produced it, so
 * `"unconfigured"` is intentionally absent.
 */
export type HotelOfferProviderName = Exclude<HotelProviderName, "unconfigured">;

export const HOTEL_PROVIDER_NAMES: readonly HotelOfferProviderName[] = [
  "nuitee_connect",
  "serpapi_google_hotels",
] as const;

export interface HotelProvider {
  /**
   * Stable, non-secret provider identity. Stamped onto every normalized
   * item, persisted on `provider_offers`/`provider_search_runs`, and emitted
   * as the `provider` label on hotel metrics.
   */
  readonly providerName: HotelProviderName;
  /**
   * Human-readable source string persisted with normalized evidence and
   * displayed on the comparison card. MUST remain stable per provider.
   * `UnavailableHotelProvider` uses the placeholder `"Not configured"`,
   * which never reaches an offer.
   */
  readonly source: string;
  searchHotels(params: HotelSearchParams): Promise<ProviderResult<HotelProviderItem[]>>;
}

export type HotelProviderItem = Omit<HotelOffer, "id" | "queryId" | "providerName" | "source">;

export interface HotelSearchParams {
  /** Server-owned destination; adapters cannot accept ambiguous free text. */
  destination: DestinationReference;
  checkIn: string;
  checkOut: string;
  roomCount: number;
  adultsPerRoom: number[];
  currency: string;
  locale: "en" | "zh";
  /**
   * Provider-only quote nationality (ISO-3166-1 alpha-2), decrypted server-side
   * from a `stay_search_provider_authorizations` row. Required by Nuitee;
   * SerpApi ignores it. Never accepted from the browser or the model.
   * Spec §3.4, §4.2.
   */
  quoteNationality?: string;
  signal?: AbortSignal;
}

/**
 * @deprecated Aggregate port from the pre-mobility refactor. Preserved as a
 * migration shim only. Spec §2 says Navigation/Mobility/Transit must live in
 * three semantically independent ports. New code must not call this. Removal
 * is scheduled after Phase 5 lands.
 */
export interface GroundProvider {
  searchGround(params: {
    destination: string;
    snapshotId: string;
  }): Promise<ProviderResult<GroundOffer[]>>;
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
    destination: DestinationReference;
    keyword: string;
    category: "ATTRACTION" | "HOTEL" | "RESTAURANT" | "TRANSPORT_HUB" | "OTHER";
    snapshotId: string;
    runId?: string;
    signal?: AbortSignal;
  }): Promise<ProviderResult<NormalizedPlaceCandidate[]>>;
}

export interface AccommodationDiscoveryProvider {
  discoverAccommodations(params: {
    destination: DestinationReference;
    limit: number;
    signal?: AbortSignal;
  }): Promise<ProviderResult<AccommodationProviderItem[]>>;
}

export interface AccommodationProviderItem {
  providerPlaceId: string;
  name: string;
  kind: string;
  longitude: number;
  latitude: number;
  distanceMeters: number | null;
  popularityTier: number | null;
  source: "OpenTripMap";
  attribution: "© OpenStreetMap contributors";
  capturedAt: string;
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
  /**
   * ISO-4217 code the provider must price in. Required, not optional: an amount
   * whose denomination is unknown cannot be shown to anyone, and making this
   * optional is how it came to be missing in the first place.
   */
  currency: string;
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
  /**
   * Lowest per-person price in the requested currency, as the provider stated
   * it. Never converted locally — a second conversion would add error on top of
   * the provider's own rounding.
   */
  fromPrice: number;
  currency: string;
  /**
   * Destination the provider filed this product under, recovered from its
   * product URL before that URL is discarded. The only geographic signal the
   * response carries; used to drop results from another destination entirely.
   */
  providerLocality: string | null;
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
