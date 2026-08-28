import type { FlightOffer, StayOffer, GroundOffer, VisaReadinessResult } from "../types/domain.js";

// ─── Provider Interfaces ────────────────────────────────────────────────────

export interface FlightProvider {
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
