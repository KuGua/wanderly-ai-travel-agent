import { describe, expect, it } from "vitest";
import { resolveAirportReference } from "../src/location-reference/airport-reference.js";
import { validateSnapshotBoundFlightSearch } from "../src/services/flight-search-service.js";

const snapshot = {
  authorizedData: {}, departureCities: ["SFO"], destinationCandidates: ["NRT"],
  travelDateStart: "2026-10-01", travelDateEnd: "2026-10-10",
};
const preferences = { tripType: "ROUND_TRIP" as const, adults: 2, cabin: "ECONOMY" as const, currency: "USD" };
const input = {
  snapshotId: "00000000-0000-4000-8000-000000000001", originId: "SFO", destinationId: "NRT",
  tripType: "ROUND_TRIP", departureDate: "2026-10-01", returnDate: "2026-10-10", ...preferences,
};

describe("flight search foundation", () => {
  it("resolves only controlled airport references", () => {
    expect(resolveAirportReference("SFO")?.iataCode).toBe("SFO");
    expect(resolveAirportReference("free-text-city")).toBeNull();
  });

  it("accepts snapshot-bound confirmed search parameters", () => {
    expect(validateSnapshotBoundFlightSearch({ input, snapshotId: input.snapshotId, snapshot, preferences })).toEqual(input);
  });

  it.each([
    ["snapshotId", "00000000-0000-4000-8000-000000000002", "snapshot"],
    ["destinationId", "SIN", "destination"],
    ["departureDate", "2026-10-02", "dates"],
    ["adults", 1, "preferences"],
  ])("rejects %s outside the authorized contract", (key, value, expected) => {
    const changed = { ...input, [key]: value };
    expect(() => validateSnapshotBoundFlightSearch({ input: changed, snapshotId: input.snapshotId, snapshot, preferences })).toThrow(expected);
  });
});
