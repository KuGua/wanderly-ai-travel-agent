import { beforeEach, describe, expect, it } from "vitest";
import { __resetRegistryForTests, invokeSkill, registerSkill } from "../src/agents/skill-registry.js";
import { planComparisonSkill } from "../src/skills/shared/plan-comparison-skill.js";
import { __setModelGatewayForTests } from "../src/providers/gateway-factory.js";
import { MockModelGateway } from "../src/providers/model-gateway.js";
import { DefaultPolicyGate } from "../src/agents/policy-gate.js";
import { createRequestContext } from "../src/utils/context.js";
import { FLIGHT_FIXTURES, STAY_FIXTURES, GROUND_FIXTURES } from "../src/providers/fixtures.js";
import type { ConstraintSnapshotData } from "../src/types/domain.js";

const snapshot: ConstraintSnapshotData = {
  authorizedData: {},
  departureCities: ["San Francisco", "Shanghai"],
  destinationCandidates: ["Tokyo", "Bangkok", "Seoul"],
};

describe("plan.comparison skill (authoritative validator)", () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerSkill(planComparisonSkill);
  });

  it("returns a plan whose flights/stays/ground honor snapshot constraints", async () => {
    __setModelGatewayForTests(new MockModelGateway());
    const ctx = {
      ctx: createRequestContext(),
      snapshot,
      policyGate: new DefaultPolicyGate("shared"),
    };

    const flights = FLIGHT_FIXTURES.filter(f => f.destination === "Tokyo");
    const stays = STAY_FIXTURES.filter(s => s.destination === "Tokyo");
    const ground = GROUND_FIXTURES.filter(g => g.destination === "Tokyo");

    const output = await invokeSkill(planComparisonSkill.name, ctx, {
      destination: "Tokyo",
      flights,
      stays,
      ground,
      memberPreferences: snapshot.authorizedData,
    });

    expect(output.destination).toBe("Tokyo");
    const resultFlights = output.flights as Array<{ origin: string; destination: string }>;
    for (const flight of resultFlights) {
      expect(snapshot.departureCities).toContain(flight.origin);
      expect(snapshot.destinationCandidates).toContain(flight.destination);
    }
  });

  it("rejects plans that introduce an origin outside snapshot.departureCities", async () => {
    __setModelGatewayForTests(new MockModelGateway());
    const ctx = {
      ctx: createRequestContext(),
      snapshot,
      policyGate: new DefaultPolicyGate("shared"),
    };

    const fakeFlights = [
      {
        id: "flt-mars-tyo-01",
        origin: "Mars",
        destination: "Tokyo",
        departureTime: "2025-08-01T11:00:00Z",
        arrivalTime: "2025-08-02T15:00:00Z",
        priceUsd: 999,
        isRedEye: false,
        airline: "Demo Air",
        source: "Demo data",
        capturedAt: "2026-08-23T00:00:00.000Z",
        fixtureVersion: "2026-08-23.v1",
        isDemo: true,
      },
    ];

    await expect(invokeSkill(planComparisonSkill.name, ctx, {
      destination: "Tokyo",
      flights: fakeFlights,
      stays: STAY_FIXTURES.filter(s => s.destination === "Tokyo"),
      ground: GROUND_FIXTURES.filter(g => g.destination === "Tokyo"),
      memberPreferences: snapshot.authorizedData,
    })).rejects.toMatchObject({ code: "PLAN_VALIDATION_FAILED" });
  });
});
