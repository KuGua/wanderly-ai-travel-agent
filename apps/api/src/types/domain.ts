import type { consentScopeValues } from "./schemas.js";
import type { HotelOfferProviderName } from "../providers/types.js";

export type ConsentScope = (typeof consentScopeValues)[number];

// ─── Constraint Visibility / Strength (mirror of policy/constraint-field-catalog.ts) ────
// Re-export the source-of-truth types from the catalog so callers can use either module.
// The catalog remains the single writable source; domain.ts is the type-level mirror.
export type {
  ConstraintVisibility,
  ConstraintStrength,
} from "../policy/constraint-field-catalog.js";

export interface UserProfileData {
  nationality?: string;
  dateOfBirth?: string;
  interests?: string[];
  accommodationStyle?: "city_center" | "budget" | "luxury";
  budgetMaxUsd?: number;
  noRedEye?: boolean;
  mobilityNotes?: string;
  availableDepartureDates?: string[];
  departureCity?: string;
}

export interface ConsentGrantInfo {
  scope: ConsentScope;
  fieldList: string[];
  granted: boolean;
}

export interface ConstraintSnapshotData {
  authorizedData: Record<string, unknown>;
  departureCities: string[];
  destinationCandidates: string[];
  travelDateStart?: string;
  travelDateEnd?: string;
  /**
   * v2 extensions (added via Team Agent 协作编排 Phase 3). Both are optional
   * because the v1 path remains valid; the validator only consults them when
   * present.
   */
  orchestratorConfidential?: Record<string, Array<{
    fieldKey: string;
    valueJson: unknown;
    strength: "HARD" | "SOFT";
    visibility: "TEAM_VISIBLE" | "ORCHESTRATOR_CONFIDENTIAL";
    sourceType: "PROFILE_CONSENT" | "TRIP_FACT";
    sourceId: string;
  }>>;
  safePublicExplanationTokens?: ReadonlySet<string>;
}

/**
 * Server-owned, unambiguous destination identity used at provider boundaries.
 * Free-text city labels are resolved into this shape before any supplier is
 * called; adapters deliberately have no overload that accepts a string.
 */
export interface DestinationReference {
  destinationId: string;
  cityName: string;
  countryCode: string;
  latitude: number;
  longitude: number;
}

/**
 * Provenance of `FlightOffer.expiresAt` (spec §6.2 — confirmation/booking
 * freshness). `PROVIDER_VERIFIED` means the supplier itself returned a
 * ticketing deadline (e.g. Amadeus `lastTicketingDate`); `SYNTHETIC` means
 * the adapter invented a local cache-freshness heuristic because the
 * supplier has no such field (SerpAPI and FlightAPI always fall in this
 * bucket; Amadeus falls back to it when a specific offer lacks
 * `lastTicketingDate`). Only `PROVIDER_VERIFIED` may ever pass the
 * confirmation/booking freshness guard — never inferred from provider name.
 */
export type FlightOfferExpiryProvenance = "PROVIDER_VERIFIED" | "SYNTHETIC";

export interface FlightOffer {
  id: string;
  providerOfferId: string;
  providerName: string;
  queryId: string;
  origin: string;
  destination: string;
  segments: FlightSegment[];
  totalDuration: string;
  totalPrice: number;
  currency: string;
  cabin: "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";
  adults: number;
  baggageSummary: string | null;
  changeSummary: string | null;
  source: string;
  capturedAt: string;
  expiresAt: string;
  expiryProvenance: FlightOfferExpiryProvenance;
}

export interface FlightSegment {
  carrierCode: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departureAt: string;
  arrivalAt: string;
  duration: string;
}

export interface StayOffer {
  id: string;
  destination: string;
  checkIn: string;
  checkOut: string;
  pricePerNightUsd: number;
  style: string;
  location: string;
  source: string;
  capturedAt: string;
}

/**
 * Provider-neutral, non-bookable hotel evidence. Supplier URLs, rate tokens,
 * coordinates and raw payloads are intentionally excluded.
 *
 * `providerName` is the stable adapter identity (see `HotelProviderName`);
 * `source` is the display string persisted alongside evidence and shown on
 * the comparison card. Both are stamped by the adapter; downstream code
 * MUST NOT mutate them.
 */
export interface HotelOffer {
  id: string;
  providerOfferId: string;
  queryId: string;
  providerName: HotelOfferProviderName;
  destinationId: string;
  propertyId: string;
  propertyName: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  roomCount: number;
  adultsPerRoom: number[];
  totalPrice: number;
  pricePerNight: number;
  currency: string;
  taxesAndFees: {
    status: "INCLUDED" | "PARTIAL" | "UNKNOWN";
    amount?: number;
  };
  cancellationSummary: string | null;
  roomSummary: string | null;
  source: string;
  capturedAt: string;
  expiresAt: string;
}

/** Public, non-price accommodation discovery evidence. */
export interface AccommodationEvidence {
  id: string;
  queryId: string;
  providerPlaceId: string;
  destinationId: string;
  name: string;
  kind: string;
  longitude: number;
  latitude: number;
  distanceMeters: number | null;
  popularityTier: number | null;
  source: "OpenTripMap";
  attribution: "© OpenStreetMap contributors";
  capturedAt: string;
  expiresAt: string;
}

export interface GroundOffer {
  id: string;
  destination: string;
  type: "airport_transfer" | "local_transport";
  priceUsd: number;
  provider: string;
  source: string;
  capturedAt: string;
}

/**
 * Normalized, non-bookable activity evidence returned by the provider-neutral
 * activities Tool. Viator click-off URLs and currency-less price amounts are
 * deliberately excluded from this contract.
 */
export interface ActivityEvidence {
  id: string;
  providerOfferId: string;
  providerName: "viator";
  queryId: string;
  destination: string;
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
   * Lowest per-person price, in `currency`, exactly as the provider stated it.
   *
   * The provider computes this as an average over the smallest bookable group,
   * so it is an indicative price rather than a single ticket face value, and it
   * is displayed as such. Never converted locally: the provider already priced
   * in the requested currency, and converting again would stack a second
   * rounding error on its own.
   */
  fromPrice: number;
  /** ISO-4217 the amount is denominated in. Always present alongside a price. */
  currency: string;
  source: "Viator Experiences MCP";
  capturedAt: string;
  expiresAt: string;
}

export interface VisaChecklistItem {
  item: string;
  source: string;
  uncertainty: string;
}

export interface VisaReadinessResult {
  memberId: string;
  destinationCountry: string;
  nationality?: string;
  status: "AUTHORIZED_CHECK" | "UNAUTHORIZED_NO_CHECK";
  checklist: VisaChecklistItem[];
  confidenceLevel: "HIGH" | "MEDIUM" | "LOW" | "UNCERTAIN";
  source: string;
  capturedAt: string;
  disclaimer: string;
}

export interface PlanDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface SandboxResult {
  service: string;
  status: "SUCCESS" | "FAILED";
  reference?: string;
  error?: string;
}

export interface BookingExecutionResult {
  orchestrationRequestId: string;
  results: SandboxResult[];
  isDuplicate: boolean;
  /**
   * True when the booking has already reached a terminal status (SUCCESS
   * or FAILED) and a callback arrives late. The route layer maps this to
   * HTTP 409 STALE_CALLBACK.
   */
  isStale?: boolean;
}

export type PlanStatus = "DRAFT" | "ACTIVE" | "PROPOSED" | "STALE" | "SUPERSEDED";
export type ConfirmationStatus = "PENDING" | "CONFIRMED" | "NEEDS_CHANGES" | "STALE";
export type TripStatus = "PLANNING" | "CONFIRMED" | "BOOKED" | "CANCELLED" | "STALE";
export type ConstraintProposalStatus = "PENDING" | "CONFIRMED" | "DISMISSED" | "REVOKED";
export type PlanAdoptionDecision = "ACCEPT" | "NEEDS_CHANGES";

// ─── Trip place / navigation / mobility / research (spec §4) ───────────────
// Mirrors the normalized provider shapes from `providers/types.ts` plus the
// server-authoritative persisted rows. Coordinates are server-only — they
// never appear in audit/log/telemetry and only reach DTOs that pass trip
// membership enforcement.

export type TripPlaceKind = "ATTRACTION" | "HOTEL" | "RESTAURANT" | "TRANSPORT_HUB" | "OTHER";
export type TripPlaceStatus = "PROPOSED" | "ACTIVE" | "REVOKED";
export type TripPlaceVisibility = "OWNER_PRIVATE" | "TEAM_VISIBLE" | "ORCHESTRATOR_CONFIDENTIAL";
export type NavigationRouteMode = "WALK" | "DRIVE" | "CYCLE";
export type MobilityServiceType = "TAXI" | "TRANSFER" | "CHARTER" | "RENTAL";
export type ResearchResultStatus = "COMPLETE" | "COMPLETED_WITH_GAPS";

export interface PlaceCandidate {
  candidateId: string;
  displayName: string;
  kind: TripPlaceKind;
  countryCode: string | null;
  cityName: string | null;
  longitude: number;
  latitude: number;
  confidence: number;
  needsUserConfirmation: boolean;
  source: string;
  capturedAt: string;
}

export interface TripPlace {
  id: string;
  tripId: string;
  ownerUserId: string;
  version: number;
  visibility: TripPlaceVisibility;
  status: TripPlaceStatus;
  kind: TripPlaceKind;
  displayName: string;
  countryCode: string | null;
  cityName: string | null;
  longitude: number | null;
  latitude: number | null;
  source: string;
  providerPlaceId: string | null;
  capturedAt: string;
  createdFromRunId: string | null;
}

export interface NavigationRouteStep {
  index: number;
  instruction: string;
  distanceMeters: number;
  durationSeconds: number;
}

export interface NavigationRouteEvidence {
  id: string;
  searchRunId: string;
  snapshotId: string;
  tripId: string;
  originPlaceId: string;
  destinationPlaceId: string;
  mode: NavigationRouteMode;
  distanceMeters: number;
  durationSeconds: number;
  steps: NavigationRouteStep[];
  // Server-internal only. The web client reads `summary` / bounds instead.
  encodedGeometry: string;
  source: string;
  capturedAt: string;
  refreshAfter: string;
}

export interface MobilityOffer {
  offerId: string;
  serviceType: MobilityServiceType;
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

export type ServiceCapability = "flight" | "stay" | "hotel" | "accommodation" | "activities" | "places" | "navigation" | "transit" | "mobility" | "readiness";

export type ProviderUnavailableCode =
  | "NOT_CONFIGURED"
  | "SEARCH_CONSTRAINTS_INCOMPLETE"
  | "NO_RESULTS"
  | "RATE_LIMITED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_FAILURE"
  | "INVALID_PROVIDER_RESPONSE"
  | "PROVIDER_NOT_APPROVED";

export interface ServiceGap {
  capability: ServiceCapability;
  code: ProviderUnavailableCode;
  destinationId?: string;
}

export interface PlanningResearchResult {
  id: string;
  tripId: string;
  snapshotId: string;
  agentTaskRunId: string | null;
  status: ResearchResultStatus;
  serviceGaps: ServiceGap[];
  resultPlanId: string | null;
  createdAt: string;
}
