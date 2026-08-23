import type { FlightOffer, StayOffer, GroundOffer, VisaReadinessResult } from "../types/domain.js";

// ─── Provider Interfaces ────────────────────────────────────────────────────

export interface FlightProvider {
  searchFlights(params: {
    origin: string;
    destination: string;
    dateStart: string;
    dateEnd: string;
    snapshotId: string;
  }): Promise<FlightOffer[]>;
}

export interface StayProvider {
  searchStays(params: {
    destination: string;
    checkIn: string;
    checkOut: string;
    style?: string;
    snapshotId: string;
  }): Promise<StayOffer[]>;
}

export interface GroundProvider {
  searchGround(params: {
    destination: string;
    snapshotId: string;
  }): Promise<GroundOffer[]>;
}

export interface VisaProvider {
  checkReadiness(params: {
    nationality: string;
    destinationCountry: string;
    snapshotId: string;
  }): Promise<VisaReadinessResult>;
}

export interface ProviderResult<T> {
  data: T;
  isDemo: boolean;
  source: string;
}
