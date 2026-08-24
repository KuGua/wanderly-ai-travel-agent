import type { FlightOffer, StayOffer, GroundOffer, VisaReadinessResult } from "../types/domain.js";
import type { FlightProvider, StayProvider, GroundProvider, ProviderResult, VisaProvider } from "./types.js";
import { FIXTURE_CAPTURED_AT, FIXTURE_VERSION, FLIGHT_FIXTURES, STAY_FIXTURES, GROUND_FIXTURES, VISA_FIXTURES } from "./fixtures.js";

function fixtureResult<T>(data: T): ProviderResult<T> {
  return {
    outcome: "FALLBACK_DEMO",
    data,
    source: "Demo data",
    capturedAt: FIXTURE_CAPTURED_AT,
    fixtureVersion: FIXTURE_VERSION,
    reason: "LIVE_PROVIDER_NOT_CONFIGURED",
  };
}

function unavailable<T>(): ProviderResult<T> {
  return { outcome: "UNAVAILABLE", reason: "FIXTURE_NOT_FOUND" };
}

/**
 * Fixture-based provider: returns deterministic demo data.
 * All results are marked with source="Demo data" and isDemo=true.
 */
export class FixtureFlightProvider implements FlightProvider {
  async searchFlights(params: {
    origin: string;
    destination: string;
    dateStart: string;
    dateEnd: string;
    snapshotId: string;
  }): Promise<ProviderResult<FlightOffer[]>> {
    const rangeStart = `${params.dateStart}T00:00:00.000Z`;
    const rangeEnd = `${params.dateEnd}T23:59:59.999Z`;

    const offers = FLIGHT_FIXTURES
      .filter(f =>
        f.origin === params.origin
        && f.destination === params.destination
        && f.departureTime >= rangeStart
        && f.departureTime <= rangeEnd
      )
      .map(f => ({ ...f }));
    return offers.length > 0 ? fixtureResult(offers) : unavailable();
  }
}

export class FixtureStayProvider implements StayProvider {
  async searchStays(params: {
    destination: string;
    checkIn: string;
    checkOut: string;
    style?: string;
    snapshotId: string;
  }): Promise<ProviderResult<StayOffer[]>> {
    let results = STAY_FIXTURES.filter(s => s.destination === params.destination);
    if (params.style) {
      results = results.filter(s => s.style === params.style);
    }
    const offers = results.map(s => ({ ...s }));
    return offers.length > 0 ? fixtureResult(offers) : unavailable();
  }
}

export class FixtureGroundProvider implements GroundProvider {
  async searchGround(params: {
    destination: string;
    snapshotId: string;
  }): Promise<ProviderResult<GroundOffer[]>> {
    const offers = GROUND_FIXTURES
      .filter(g => g.destination === params.destination)
      .map(g => ({ ...g }));
    return offers.length > 0 ? fixtureResult(offers) : unavailable();
  }
}

export class FixtureVisaProvider implements VisaProvider {
  async checkReadiness(params: {
    nationality: string;
    destinationCountry: string;
    snapshotId: string;
  }): Promise<ProviderResult<VisaReadinessResult>> {
    const destFixtures = VISA_FIXTURES[params.destinationCountry];
    const natFixtures = destFixtures?.[params.nationality];

    if (!natFixtures) {
      return unavailable();
    }

    return fixtureResult({
      memberId: "",
      destinationCountry: params.destinationCountry,
      nationality: params.nationality,
      status: "AUTHORIZED_CHECK",
      checklist: natFixtures.checklist,
      confidenceLevel: natFixtures.confidence,
      source: natFixtures.source,
      capturedAt: FIXTURE_CAPTURED_AT,
      disclaimer: "This is a demo checklist. Verify all requirements with official government sources before travel. This does not constitute legal advice.",
    });
  }
}
