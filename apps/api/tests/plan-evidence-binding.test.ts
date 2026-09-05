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

  /**
   * Hotels and accommodations were not bound here at all, so a model that
   * selected one had its `{"id":…}` reference left as a bare reference and
   * then failed the validator's exact-match check against the full record.
   * The hotel slot could never be filled by any plan, whatever the run held —
   * ten live Nuitee quotes still produced a card reading "no verifiable data".
   */
  it("binds hotel and accommodation selections like every other category", () => {
    const hotel = {
      id: "22222222-2222-4222-8222-222222222222",
      providerOfferId: "nuitee-1", queryId: "33333333-3333-4333-8333-333333333333",
      providerName: "nuitee_connect" as const, destinationId: "NRT",
      propertyId: "p1", propertyName: "Hotel Test", checkIn: "2026-12-04", checkOut: "2026-12-08",
      nights: 4, roomCount: 1, adultsPerRoom: [1],
      totalPrice: 1000, pricePerNight: 250, currency: "CNY",
      taxesAndFees: { status: "INCLUDED" as const },
      cancellationSummary: null, roomSummary: null,
      source: "Nuitee LiteAPI", capturedAt: "2026-12-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const result = bindPlanSelectionsToEvidence({
      candidate: {
        flights: [], stays: [],
        hotels: [{ id: hotel.id, propertyName: "model's paraphrase" }],
      },
      flights: [], stays: [], activities: [],
      hotels: [hotel as never],
    });
    expect(result.hotels).toEqual([hotel]);
    // Its capture time counts toward the plan's generatedAt like any evidence.
    expect(result.generatedAt).toBe(hotel.capturedAt);
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
