import type {
  AccommodationDiscoveryProvider,
  ActivitiesProvider,
  FlightProvider,
  GroundProvider,
  HotelProvider,
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
import type { FlightOffer, StayOffer } from "../types/domain.js";
import { AmadeusFlightProvider, readAmadeusConfiguration } from "./amadeus-flight-provider.js";
import { AmadeusTransferProvider, readAmadeusTransferConfiguration } from "./amadeus-transfer-provider.js";
import { OrsPlaceProvider, readOrsPlaceConfiguration } from "./ors-place-provider.js";
import { OrsNavigationProvider, readOrsNavigationConfiguration } from "./ors-navigation-provider.js";
import { ViatorMcpActivitiesProvider, readViatorMcpConfiguration } from "./viator-mcp-activities-provider.js";
import { SerpApiHotelProvider, readSerpApiHotelConfiguration } from "./serpapi-hotel-provider.js";
import {
  OpenTripMapAccommodationProvider,
  readOpenTripMapAccommodationConfiguration,
} from "./opentripmap-accommodation-provider.js";

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

class UnavailableActivitiesProvider implements ActivitiesProvider {
  async searchActivities() {
    return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" } as const;
  }
}

class UnavailableHotelProvider implements HotelProvider {
  async searchHotels() {
    return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" } as const;
  }
}

class UnavailableAccommodationDiscoveryProvider implements AccommodationDiscoveryProvider {
  async discoverAccommodations() {
    return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" } as const;
  }
}

/**
 * The product never substitutes invented offers. Concrete supplier adapters are
 * registered here only after their credentials and commercial terms are
 * configured; until then planning reports the affected capability unavailable.
 *
 * Spec §3: each capability is selected by a single deterministic port. The
 * model never chooses a provider; fallbacks only happen between semantically
 * equivalent suppliers and must be auditable.
 */
export function createTravelProviders(): {
  flightProvider: FlightProvider;
  stayProvider: StayProvider;
  placeProvider: PlaceSearchProvider;
  navigationProvider: NavigationProvider;
  mobilityOfferProvider: MobilityOfferProvider;
  transitJourneyProvider: TransitJourneyProvider;
  activitiesProvider: ActivitiesProvider;
  hotelProvider: HotelProvider;
  accommodationDiscoveryProvider: AccommodationDiscoveryProvider;
} {
  return {
    flightProvider: createFlightProvider(),
    stayProvider: new UnavailableStayProvider(),
    placeProvider: createOrsPlace(),
    navigationProvider: createOrsNavigation(),
    mobilityOfferProvider: createAmadeusTransfer(),
    transitJourneyProvider: new UnavailableTransitJourneyProvider(),
    activitiesProvider: createActivitiesProvider(),
    hotelProvider: createHotelProvider(),
    accommodationDiscoveryProvider: createAccommodationDiscoveryProvider(),
  };
}

function createAccommodationDiscoveryProvider(): AccommodationDiscoveryProvider {
  const configuration = readOpenTripMapAccommodationConfiguration();
  return configuration
    ? new OpenTripMapAccommodationProvider(configuration)
    : new UnavailableAccommodationDiscoveryProvider();
}

function createHotelProvider(): HotelProvider {
  const configuration = readSerpApiHotelConfiguration();
  return configuration ? new SerpApiHotelProvider(configuration) : new UnavailableHotelProvider();
}

function createActivitiesProvider(): ActivitiesProvider {
  const configuration = readViatorMcpConfiguration();
  return configuration
    ? new ViatorMcpActivitiesProvider(configuration)
    : new UnavailableActivitiesProvider();
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
