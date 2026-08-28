import type { FlightProvider, GroundProvider, ProviderResult, StayProvider } from "./types.js";
import type { FlightOffer, GroundOffer, StayOffer } from "../types/domain.js";
import { AmadeusFlightProvider, readAmadeusConfiguration } from "./amadeus-flight-provider.js";

class UnavailableFlightProvider implements FlightProvider {
  async searchFlights(): Promise<ProviderResult<FlightOffer[]>> {
    return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" };
  }
}

class UnavailableStayProvider implements StayProvider {
  async searchStays(): Promise<ProviderResult<StayOffer[]>> {
    return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" };
  }
}

class UnavailableGroundProvider implements GroundProvider {
  async searchGround(): Promise<ProviderResult<GroundOffer[]>> {
    return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" };
  }
}

/**
 * The product never substitutes invented offers. Concrete supplier adapters are
 * registered here only after their credentials and commercial terms are
 * configured; until then planning reports the affected capability unavailable.
 */
export function createTravelProviders(): {
  flightProvider: FlightProvider;
  stayProvider: StayProvider;
  groundProvider: GroundProvider;
} {
  return {
    flightProvider: createFlightProvider(),
    stayProvider: new UnavailableStayProvider(),
    groundProvider: new UnavailableGroundProvider(),
  };
}

function createFlightProvider(): FlightProvider {
  const configuration = readAmadeusConfiguration();
  return configuration ? new AmadeusFlightProvider(configuration) : new UnavailableFlightProvider();
}
