import type { consentScopeValues } from "./schemas.js";

export type ConsentScope = (typeof consentScopeValues)[number];

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
}

export interface FlightOffer {
  id: string;
  origin: string;
  destination: string;
  departureTime: string;
  arrivalTime: string;
  priceUsd: number;
  isRedEye: boolean;
  airline: string;
  source: string;
  capturedAt: string;
  fixtureVersion: string;
  isDemo: boolean;
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
  fixtureVersion: string;
  isDemo: boolean;
}

export interface GroundOffer {
  id: string;
  destination: string;
  type: "airport_transfer" | "local_transport";
  priceUsd: number;
  provider: string;
  source: string;
  capturedAt: string;
  fixtureVersion: string;
  isDemo: boolean;
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
}

export type PlanStatus = "DRAFT" | "ACTIVE" | "STALE" | "SUPERSEDED";
export type ConfirmationStatus = "PENDING" | "CONFIRMED" | "NEEDS_CHANGES" | "STALE";
export type TripStatus = "PLANNING" | "CONFIRMED" | "BOOKED" | "CANCELLED" | "STALE";
