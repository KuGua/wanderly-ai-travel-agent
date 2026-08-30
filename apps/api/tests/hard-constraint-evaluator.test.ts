import { describe, expect, it } from "vitest";
import { evaluateHardConstraints } from "../src/policy/hard-constraint-evaluator.js";
import type { FlightOffer } from "../src/types/domain.js";

const flight = (departureAt: string): FlightOffer => ({
  id: "flight-1", providerOfferId: "provider-1", providerName: "test", queryId: "00000000-0000-4000-8000-000000000001",
  origin: "SIN", destination: "NRT", totalDuration: "PT7H", totalPrice: 500, currency: "USD", cabin: "ECONOMY", adults: 1,
  baggageSummary: null, changeSummary: null, source: "test", capturedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z",
  segments: [{ carrierCode: "ZZ", flightNumber: "1", origin: "SIN", destination: "NRT", departureAt, arrivalAt: "2026-01-02T08:00:00+08:00", duration: "PT7H" }],
});

const snapshot = (enabled: boolean) => ({
  authorizedData: { _meta: { schemaVersion: 2, teamVisible: { m_a: [{ fieldKey: "no_red_eye", valueJson: { enabled }, strength: "HARD" }] }, orchestratorConfidential: {}, projectionManifest: [], memberAliases: {} } },
  departureCities: ["SIN"], destinationCandidates: ["NRT"],
});

describe("hard constraint evaluator", () => {
  it("blocks a selected red-eye offer when no_red_eye is HARD", () => {
    expect(evaluateHardConstraints({ snapshot: snapshot(true), flights: [flight("2026-01-01T23:30:00+08:00")] }))
      .toEqual([{ code: "HARD_CONSTRAINT_UNSATISFIED", publicReason: "HARD_FLIGHT_TIME_CONSTRAINT_UNSATISFIED" }]);
  });

  it("allows daytime offers and disabled constraints", () => {
    expect(evaluateHardConstraints({ snapshot: snapshot(true), flights: [flight("2026-01-01T09:30:00+08:00")] })).toEqual([]);
    expect(evaluateHardConstraints({ snapshot: snapshot(false), flights: [flight("2026-01-01T23:30:00+08:00")] })).toEqual([]);
  });
});
