import type { FlightOffer, StayOffer, GroundOffer, VisaReadinessResult } from "../types/domain.js";

// ─── Provider Interfaces ────────────────────────────────────────────────────

export interface FlightProvider {
  searchFlights(params: {
    origin: string;
    destination: string;
    dateStart: string;
    dateEnd: string;
    snapshotId: string;
  }): Promise<ProviderResult<FlightOffer[]>>;
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
      outcome: "FALLBACK_DEMO";
      data: T;
      source: string;
      capturedAt: string;
      fixtureVersion: string;
      reason: "LIVE_PROVIDER_NOT_CONFIGURED" | "LIVE_PROVIDER_FAILED";
    }
  | {
      outcome: "UNAVAILABLE";
      reason: "FIXTURE_NOT_FOUND" | "PROVIDER_FAILED";
    };
