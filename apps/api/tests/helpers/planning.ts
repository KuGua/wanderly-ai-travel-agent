import type { PlanningDependencies } from "../../src/services/planning-service.js";
import type {
  MobilityOfferProvider,
  NavigationProvider,
  PlaceSearchProvider,
  TransitJourneyProvider,
} from "../../src/providers/types.js";

const CAPTURED_AT = "2026-08-25T00:00:00.000Z";
// Freshness must stay relative to wall time, not the fixed CAPTURED_AT above —
// otherwise this fixture's flight offer eventually reads as expired to
// `validateSelectedFlightOffersFresh` regardless of when the suite runs.
const TEST_FLIGHT_OFFER_EXPIRES_AT = () => new Date(Date.now() + 60 * 60_000).toISOString();

const unavailablePlaceProvider: PlaceSearchProvider = {
  async searchPlaces() {
    return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" };
  },
};

const unavailableNavigationProvider: NavigationProvider = {
  async searchRoute() {
    return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" };
  },
};

const unavailableMobilityProvider: MobilityOfferProvider = {
  async searchOffers() {
    return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" };
  },
};

const unavailableTransitProvider: TransitJourneyProvider = {
  async searchJourneys() {
    return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" };
  },
};

export const testPlanningDependencies: PlanningDependencies = {
  flightProvider: {
    async searchFlights(params) {
      // Coverage research resolves cities to controlled airports before it
      // calls a provider, so this fixture has to answer to both spellings of
      // the same origin — it used to know only the city names and reported
      // every post-resolution search as UNAVAILABLE.
      if (
        !new Set(["San Francisco", "Shanghai", "SFO", "PVG", "SHA"]).has(params.origin)
        || params.destination === "Singapore"
        || params.destination === "SIN"
      ) {
        return { outcome: "UNAVAILABLE", reason: "NO_RESULTS" };
      }

      return {
        outcome: "LIVE",
        source: "Test flight provider",
        capturedAt: CAPTURED_AT,
        data: [{
          id: `test-flight-${slug(params.origin)}-${slug(params.destination)}`,
          providerOfferId: `test-flight-${slug(params.origin)}-${slug(params.destination)}`,
          providerName: "test-flight-provider",
          queryId: "00000000-0000-4000-8000-000000000001",
          origin: params.origin,
          destination: params.destination,
          segments: [{
            carrierCode: "TA",
            flightNumber: "1",
            origin: params.origin,
            destination: params.destination,
            departureAt: `${params.dateStart}T08:00:00.000Z`,
            arrivalAt: `${params.dateStart}T18:00:00.000Z`,
            duration: "PT10H",
          }],
          totalDuration: "PT10H",
          totalPrice: 500,
          currency: "USD",
          cabin: "ECONOMY" as const,
          adults: params.adults ?? 1,
          baggageSummary: null,
          changeSummary: null,
          source: "Test flight provider",
          capturedAt: CAPTURED_AT,
          expiresAt: TEST_FLIGHT_OFFER_EXPIRES_AT(),
          // This fixture stands in for a well-behaved, trustworthy provider
          // for every OTHER test that isn't specifically about the
          // freshness guard; see flight-offer-*-freshness*.test.ts for
          // dedicated PROVIDER_VERIFIED vs SYNTHETIC coverage.
          expiryProvenance: "PROVIDER_VERIFIED",
        }],
      };
    },
  },
  stayProvider: {
    async searchStays(params) {
      return {
        outcome: "LIVE",
        source: "Test stay provider",
        capturedAt: CAPTURED_AT,
        data: [{
          id: `test-stay-${slug(params.destination)}`,
          destination: params.destination,
          checkIn: params.checkIn,
          checkOut: params.checkOut,
          pricePerNightUsd: 160,
          style: params.style ?? "city_center",
          location: "Test city center",
          source: "Test stay provider",
          capturedAt: CAPTURED_AT,
        }],
      };
    },
  },
  modelGateway: {
    async generateStructuredPlan(params) {
      return {
        destination: params.destination,
        flights: params.flights,
        generatedAt: CAPTURED_AT,
      };
    },
    async generateStructuredPlanWithTools(params) {
      // Tool-loop path used by `generatePlan` when agentTaskRunId is set.
      // `params.flights` may be absent because the
      // planner re-validates flights via `evaluateFlightResearchCompleteness`
      // (DB read). The stub returns a fully-formed plan so the deterministic
      // validator accepts it; for tests where a flight exists upstream the
      // caller may pass `{ flights }` to inject one.
      const flights = params.flights ?? [];
      const fallbackCapturedAt = flights[0]?.capturedAt
        ?? "2026-08-25T00:00:00.000Z";
      return {
        destination: params.destination,
        destinationCandidatesEvaluated: [params.destination],
        flights, // pass through — validatePlanOutput compares against provider_offers
        activities: [],
        hotels: [],
        generatedAt: fallbackCapturedAt,
        constraintReferences: [],
        publicExplanationTokens: ["baseline"],
      };
    },
    async generateDailyItinerary(params) {
      const dates: string[] = [];
      for (let cursor = new Date(`${params.travelDateStart}T00:00:00.000Z`); cursor < new Date(`${params.travelDateEnd}T00:00:00.000Z`); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
        dates.push(cursor.toISOString().slice(0, 10));
      }
      return dates.map((date, index) => ({
        date,
        timeZone: "destination_local",
        items: [{
          kind: index === 0 && Array.isArray(params.plan.flights) && params.plan.flights.length > 0 ? "FLIGHT" : "FREE_TIME",
          startTimeLocal: "09:00",
          endTimeLocal: "10:00",
          title: index === 0 ? "Travel day" : "Free time",
          verification: index === 0 && Array.isArray(params.plan.flights) && params.plan.flights.length > 0 ? "PROVIDER_BACKED" : "SUGGESTED",
          ...(index === 0 && Array.isArray(params.plan.flights) && params.plan.flights.length > 0
            ? { evidenceRef: { category: "flights", id: (params.plan.flights[0] as { id: string }).id } }
            : {}),
        }],
      }));
    },
    async explainPlanDiff() {
      return { added: [], removed: [], changed: [] };
    },
    async generateConversationReply() {
      return {
        content: "Test-only conversation response",
        responseMode: "MODEL",
      };
    },
  },
  placeProvider: unavailablePlaceProvider,
  navigationProvider: unavailableNavigationProvider,
  mobilityOfferProvider: unavailableMobilityProvider,
  transitJourneyProvider: unavailableTransitProvider,
};

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
