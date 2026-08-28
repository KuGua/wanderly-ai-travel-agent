import type { PlanningDependencies } from "../../src/services/planning-service.js";

const CAPTURED_AT = "2026-08-25T00:00:00.000Z";

export const testPlanningDependencies: PlanningDependencies = {
  flightProvider: {
    async searchFlights(params) {
      if (
        !new Set(["San Francisco", "Shanghai"]).has(params.origin)
        || params.destination === "Singapore"
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
          expiresAt: "2026-08-25T01:00:00.000Z",
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
  groundProvider: {
    async searchGround(params) {
      return {
        outcome: "LIVE",
        source: "Test ground provider",
        capturedAt: CAPTURED_AT,
        data: [{
          id: `test-ground-${slug(params.destination)}`,
          destination: params.destination,
          type: "airport_transfer",
          priceUsd: 40,
          provider: "Test Transfer",
          source: "Test ground provider",
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
        stays: params.stays,
        ground: params.ground,
        generatedAt: CAPTURED_AT,
      };
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
};

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
