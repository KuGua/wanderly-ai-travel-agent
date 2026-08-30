import type { FlightProvider, GroundProvider, ProviderResult, StayProvider } from "./types.js";
import type { FlightOffer, GroundOffer, StayOffer } from "../types/domain.js";
import { AmadeusFlightProvider, readAmadeusConfiguration } from "./amadeus-flight-provider.js";
import { FlightApiProvider, readFlightApiConfiguration } from "./flightapi-flight-provider.js";

class UnavailableFlightProvider implements FlightProvider {
  readonly providerName = "unconfigured" as const;
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

export function createFlightProvider(env: NodeJS.ProcessEnv = process.env): FlightProvider {
  const selected = (env.FLIGHT_PROVIDER ?? "disabled").trim().toLowerCase();
  if (selected === "disabled") return new UnavailableFlightProvider();
  if (selected === "amadeus") {
    const configuration = readAmadeusConfiguration(env);
    if (!configuration) throw new Error("FLIGHT_PROVIDER=amadeus requires AMADEUS_ENVIRONMENT=test or production");
    return new AmadeusFlightProvider(configuration);
  }
  if (selected === "flightapi") {
    return new FlightApiProvider(readFlightApiConfiguration(env));
  }
  throw new Error("FLIGHT_PROVIDER must be disabled, amadeus, or flightapi");
}
