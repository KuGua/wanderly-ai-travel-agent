import type { FlightOffer, StayOffer, GroundOffer, VisaReadinessResult } from "../types/domain.js";
import type { FlightProvider, StayProvider, GroundProvider, VisaProvider } from "./types.js";
import { FLIGHT_FIXTURES, STAY_FIXTURES, GROUND_FIXTURES, VISA_FIXTURES } from "./fixtures.js";

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
  }): Promise<FlightOffer[]> {
    const rangeStart = `${params.dateStart}T00:00:00.000Z`;
    const rangeEnd = `${params.dateEnd}T23:59:59.999Z`;

    return FLIGHT_FIXTURES
      .filter(f =>
        f.origin === params.origin
        && f.destination === params.destination
        && f.departureTime >= rangeStart
        && f.departureTime <= rangeEnd
      )
      .map(f => ({ ...f }));
  }
}

export class FixtureStayProvider implements StayProvider {
  async searchStays(params: {
    destination: string;
    checkIn: string;
    checkOut: string;
    style?: string;
    snapshotId: string;
  }): Promise<StayOffer[]> {
    let results = STAY_FIXTURES.filter(s => s.destination === params.destination);
    if (params.style) {
      results = results.filter(s => s.style === params.style);
    }
    return results.map(s => ({ ...s }));
  }
}

export class FixtureGroundProvider implements GroundProvider {
  async searchGround(params: {
    destination: string;
    snapshotId: string;
  }): Promise<GroundOffer[]> {
    return GROUND_FIXTURES
      .filter(g => g.destination === params.destination)
      .map(g => ({ ...g }));
  }
}

export class FixtureVisaProvider implements VisaProvider {
  async checkReadiness(params: {
    nationality: string;
    destinationCountry: string;
    snapshotId: string;
  }): Promise<VisaReadinessResult> {
    const destFixtures = VISA_FIXTURES[params.destinationCountry];
    const natFixtures = destFixtures?.[params.nationality];

    if (!natFixtures) {
      return {
        memberId: "", // filled by service
        destinationCountry: params.destinationCountry,
        nationality: params.nationality,
        status: "AUTHORIZED_CHECK",
        checklist: [
          { item: "Visa requirements unknown for this nationality/destination combination", source: "Demo data", uncertainty: "No fixture data available — verify with official government sources" },
        ],
        confidenceLevel: "UNCERTAIN",
        source: "Demo data — no fixture available",
        capturedAt: new Date().toISOString(),
        disclaimer: "This is a demo checklist. Verify all requirements with official government sources before travel.",
      };
    }

    return {
      memberId: "",
      destinationCountry: params.destinationCountry,
      nationality: params.nationality,
      status: "AUTHORIZED_CHECK",
      checklist: natFixtures.checklist,
      confidenceLevel: natFixtures.confidence,
      source: natFixtures.source,
      capturedAt: new Date().toISOString(),
      disclaimer: "This is a demo checklist. Verify all requirements with official government sources before travel. This does not constitute legal advice.",
    };
  }
}
