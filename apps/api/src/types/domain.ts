import type { consentScopeValues } from "./schemas.js";

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

export interface GroundOffer {
  id: string;
  destination: string;
  type: "airport_transfer" | "local_transport";
  priceUsd: number;
  provider: string;
  source: string;
  capturedAt: string;
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
