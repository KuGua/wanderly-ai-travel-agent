import { describe, expect, it } from "vitest";
import {
  FixtureFlightProvider,
  FixtureGroundProvider,
  FixtureStayProvider,
} from "../src/providers/fixture-provider.js";
import { FIXTURE_CAPTURED_AT, FIXTURE_VERSION } from "../src/providers/fixtures.js";
import { MockModelGateway } from "../src/providers/model-gateway.js";
import {
  PlanningDataUnavailableError,
  validateProviderCoverage,
} from "../src/services/planning-service.js";

const flightProvider = new FixtureFlightProvider();
const stayProvider = new FixtureStayProvider();
const groundProvider = new FixtureGroundProvider();
const modelGateway = new MockModelGateway();

async function buildFixturePlan() {
  const snapshotId = "snapshot-test-001";
  const destination = "Tokyo";
  const requiredOrigins = ["San Francisco", "Shanghai"];

  const flights = (await Promise.all(requiredOrigins.map(origin =>
    flightProvider.searchFlights({
      origin,
      destination,
      dateStart: "2025-08-01",
      dateEnd: "2025-08-07",
      snapshotId,
    })
  ))).flat();
  const stays = await stayProvider.searchStays({
    destination,
    checkIn: "2025-08-01",
    checkOut: "2025-08-07",
    snapshotId,
  });
  const ground = await groundProvider.searchGround({ destination, snapshotId });

  validateProviderCoverage({ requiredOrigins, flights, stays, ground });

  return modelGateway.generateStructuredPlan({
    destination,
    flights,
    stays,
    ground,
    memberPreferences: {},
  });
}

describe("fixture-backed planning slice", () => {
  it("returns a complete normalized plan for both required origins", async () => {
    const plan = await buildFixturePlan();
    const flights = plan.flights as Array<Record<string, unknown>>;

    expect(flights.map(flight => flight.origin).sort()).toEqual(["San Francisco", "Shanghai"]);
    expect(plan.stays).toHaveLength(1);
    expect(plan.ground).toHaveLength(1);
  });

  it("returns the same normalized result for repeated fixture input", async () => {
    const first = await buildFixturePlan();
    const second = await buildFixturePlan();

    expect(second).toEqual(first);
  });

  it("preserves source, capture time, demo marker and fixture version", async () => {
    const plan = await buildFixturePlan();
    const offers = [
      ...(plan.flights as Array<Record<string, unknown>>),
      ...(plan.stays as Array<Record<string, unknown>>),
      ...(plan.ground as Array<Record<string, unknown>>),
    ];

    for (const offer of offers) {
      expect(offer.source).toBe("Demo data");
      expect(offer.capturedAt).toBe(FIXTURE_CAPTURED_AT);
      expect(offer.fixtureVersion).toBe(FIXTURE_VERSION);
      expect(offer.isDemo).toBe(true);
    }
  });

  it("returns a typed failure when a required origin has no fixture", () => {
    expect(() => validateProviderCoverage({
      requiredOrigins: ["San Francisco", "Singapore"],
      flights: [],
      stays: [],
      ground: [],
    })).toThrowError(PlanningDataUnavailableError);

    try {
      validateProviderCoverage({
        requiredOrigins: ["Singapore"],
        flights: [],
        stays: [],
        ground: [],
      });
    } catch (error) {
      expect(error).toMatchObject({
        statusCode: 422,
        code: "PLANNING_DATA_UNAVAILABLE",
        missing: ["flight:Singapore", "stay", "ground"],
      });
    }
  });
});
