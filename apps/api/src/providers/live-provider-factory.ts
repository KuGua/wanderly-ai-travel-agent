import type {
  FlightProvider,
  GroundProvider,
  MobilityOfferProvider,
  NavigationProvider,
  PlaceSearchProvider,
  ProviderResult,
  StayProvider,
  TransitJourneyProvider,
} from "./types.js";
import type {
  NormalizedMobilityOffer,
  NormalizedPlaceCandidate,
  NormalizedRouteEvidence,
  NormalizedTransitJourney,
} from "./types.js";
import type { FlightOffer, GroundOffer, StayOffer } from "../types/domain.js";
import { AmadeusFlightProvider, readAmadeusConfiguration } from "./amadeus-flight-provider.js";
import { AmadeusTransferProvider, readAmadeusTransferConfiguration } from "./amadeus-transfer-provider.js";
import { createGroundCapabilityRouter, type GroundCapabilityRouter } from "./ground-capability-router.js";
import { OrsPlaceProvider, readOrsPlaceConfiguration } from "./ors-place-provider.js";
import { OrsNavigationProvider, readOrsNavigationConfiguration } from "./ors-navigation-provider.js";

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

class UnavailablePlaceProvider implements PlaceSearchProvider {
  async searchPlaces(): Promise<ProviderResult<NormalizedPlaceCandidate[]>> {
    return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" };
  }
}

class UnavailableNavigationProvider implements NavigationProvider {
  async searchRoute(): Promise<ProviderResult<NormalizedRouteEvidence>> {
    return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" };
  }
}

class UnavailableMobilityOfferProvider implements MobilityOfferProvider {
  async searchOffers(): Promise<ProviderResult<NormalizedMobilityOffer[]>> {
    return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" };
  }
}

class UnavailableTransitJourneyProvider implements TransitJourneyProvider {
  async searchJourneys(): Promise<ProviderResult<NormalizedTransitJourney[]>> {
    return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" };
  }
}

/**
 * The product never substitutes invented offers. Concrete supplier adapters are
 * registered here only after their credentials and commercial terms are
 * configured; until then planning reports the affected capability unavailable.
 *
 * Spec §3: `GroundCapabilityRouter` is the only provider selection point.
 * The model never chooses a provider; fallbacks only happen between
 * semantically equivalent suppliers and must be auditable.
 */
export function createTravelProviders(): {
  flightProvider: FlightProvider;
  stayProvider: StayProvider;
  groundProvider: GroundProvider;
  placeProvider: PlaceSearchProvider;
  navigationProvider: NavigationProvider;
  mobilityOfferProvider: MobilityOfferProvider;
  transitJourneyProvider: TransitJourneyProvider;
  capabilityRouter: GroundCapabilityRouter;
} {
  const placeProvider = createOrsPlace();
  const navigationProvider = createOrsNavigation();
  return {
    flightProvider: createFlightProvider(),
    stayProvider: new UnavailableStayProvider(),
    groundProvider: new UnavailableGroundProvider(),
    placeProvider,
    navigationProvider,
    mobilityOfferProvider: createAmadeusTransfer(),
    transitJourneyProvider: new UnavailableTransitJourneyProvider(),
    capabilityRouter: createGroundCapabilityRouter({
      placeProvider,
      navigationProvider,
      mobilityOfferProvider: createAmadeusTransfer(),
      transitJourneyProvider: new UnavailableTransitJourneyProvider(),
    }),
  };
}

function createFlightProvider(): FlightProvider {
  const configuration = readAmadeusConfiguration();
  return configuration ? new AmadeusFlightProvider(configuration) : new UnavailableFlightProvider();
}

function createOrsPlace(): PlaceSearchProvider {
  const configuration = readOrsPlaceConfiguration();
  return configuration ? new OrsPlaceProvider(configuration) : new UnavailablePlaceProvider();
}

function createOrsNavigation(): NavigationProvider {
  const configuration = readOrsNavigationConfiguration();
  return configuration ? new OrsNavigationProvider(configuration) : new UnavailableNavigationProvider();
}

function createAmadeusTransfer(): MobilityOfferProvider {
  if (process.env.PLAN_ENABLE_MOBILITY === "false") {
    return new UnavailableMobilityOfferProvider();
  }
  const configuration = readAmadeusTransferConfiguration();
  return configuration ? new AmadeusTransferProvider(configuration) : new UnavailableMobilityOfferProvider();
}
