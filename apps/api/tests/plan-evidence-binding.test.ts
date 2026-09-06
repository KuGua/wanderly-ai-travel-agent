import { describe, expect, it } from "vitest";
import type { FlightOffer, StayOffer } from "../src/types/domain.js";
import { bindPlanSelectionsToEvidence } from "../src/services/plan-evidence-binding.js";

const flight: FlightOffer = {
  id: "flight-1",
  providerOfferId: "provider-flight-1",
  providerName: "serpapi",
  queryId: "11111111-1111-4111-8111-111111111111",
  origin: "SIN",
  destination: "NRT",
  segments: [{
    carrierCode: "SQ", flightNumber: "12", origin: "SIN", destination: "NRT",
    departureAt: "2026-10-10T09:00:00", arrivalAt: "2026-10-10T17:00:00", duration: "PT7H",
  }],
  totalDuration: "PT7H",
  totalPrice: 500,
  currency: "USD",
  cabin: "ECONOMY",
  adults: 1,
  baggageSummary: null,
  changeSummary: null,
  source: "SerpAPI Google Flights",
  capturedAt: "2026-08-31T03:00:00.000Z",
  expiresAt: "2026-08-31T03:30:00.000Z",
};

const stay: StayOffer = {
  id: "stay-1",
  destination: "NRT",
  checkIn: "2026-10-10",
  checkOut: "2026-10-17",
  pricePerNightUsd: 100,
  style: "CITY_CENTER",
  location: "Tokyo",
  source: "test-stay-provider",
  capturedAt: "2026-08-31T03:05:00.000Z",
};

describe("bindPlanSelectionsToEvidence", () => {
  it("replaces model summaries with complete server-owned evidence and derives generatedAt", () => {
    const result = bindPlanSelectionsToEvidence({
      candidate: {
        destination: "NRT",
        flights: [{ id: flight.id, origin: "SIN", destination: "NRT", totalPrice: 500 }],
        stays: [{ id: stay.id, destination: "NRT" }],
        generatedAt: "model-invented",
      },
      flights: [flight], stays: [stay], activities: [],
    });

    expect(result.flights).toEqual([flight]);
    expect(result.stays).toEqual([stay]);
    expect(result.generatedAt).toBe(stay.capturedAt);
  });

  it("does not authorize an unknown model-selected id", () => {
    const unknown = { id: "hallucinated-flight", origin: "SIN", destination: "NRT" };
    const result = bindPlanSelectionsToEvidence({
      candidate: { flights: [unknown], stays: [] },
      flights: [flight], stays: [], activities: [],
    });
    expect(result.flights).toEqual([unknown]);
    expect(result.generatedAt).toBeUndefined();
  });
});
