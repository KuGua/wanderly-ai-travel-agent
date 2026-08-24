import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/database.js";
import { auditEvents, constraintSnapshots, itineraryPlans, providerOffers, sharedTrips, users } from "../src/db/schema.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import {
  PlanValidationError,
  validatePlanOutput,
} from "../src/policy/plan-output-validator.js";
import { FixtureFlightProvider, FixtureGroundProvider, FixtureStayProvider } from "../src/providers/fixture-provider.js";
import { FLIGHT_FIXTURES, GROUND_FIXTURES, STAY_FIXTURES } from "../src/providers/fixtures.js";
import { LLMGateway } from "../src/providers/llm-gateway.js";
import { MockModelGateway } from "../src/providers/model-gateway.js";
import type { ProviderResult } from "../src/providers/types.js";
import { generatePlan } from "../src/services/planning-service.js";
import type { ConstraintSnapshotData } from "../src/types/domain.js";
import { createRequestContext } from "../src/utils/context.js";

const evidence = {
  flights: FLIGHT_FIXTURES.filter(offer => offer.destination === "Tokyo"),
  stays: STAY_FIXTURES.filter(offer => offer.destination === "Tokyo"),
  ground: GROUND_FIXTURES.filter(offer => offer.destination === "Tokyo"),
};

const snapshot: ConstraintSnapshotData = {
  authorizedData: { "member-1": { noRedEye: true } },
  departureCities: ["San Francisco", "Shanghai"],
  destinationCandidates: ["Tokyo"],
  travelDateStart: "2025-08-01",
  travelDateEnd: "2025-08-07",
};

async function validCandidate(): Promise<Record<string, unknown>> {
  return new MockModelGateway().generateStructuredPlan({
    destination: "Tokyo",
    flights: evidence.flights,
    stays: evidence.stays,
    ground: evidence.ground,
    memberPreferences: snapshot.authorizedData,
  });
}

function llmStyleGateway(plan: Record<string, unknown>): LLMGateway {
  return new LLMGateway({
    apiKey: "test",
    provider: "openai",
    modelName: "gpt-4o-mini",
    promptVersion: "integration-test",
    mock: new MockModelGateway(),
    ctx: createRequestContext(),
    client: {
      beta: {
        chat: {
          completions: {
            parse: async () => ({ choices: [{ message: { parsed: { plan } } }] }),
          },
        },
      },
    },
    maxRetries: 0,
  });
}

async function expectViolation(
  candidate: unknown,
  code: string,
): Promise<void> {
  try {
    validatePlanOutput({ planData: candidate, snapshot, evidence });
    throw new Error("Expected plan validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PlanValidationError);
    expect((error as PlanValidationError).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code })]),
    );
  }
}

describe("plan output control plane", () => {
  it("accepts a structurally valid plan backed by exact provider evidence", async () => {
    const candidate = {
      ...await validCandidate(),
      constraintReferences: ["authorizedData.member-1.noRedEye"],
    };
    const result = validatePlanOutput({ planData: candidate, snapshot, evidence });

    expect(result.destination).toBe("Tokyo");
    expect(result.flights.map(flight => flight.origin).sort()).toEqual(["San Francisco", "Shanghai"]);
  });

  it("rejects a snapshot field that was not authorized", async () => {
    await expectViolation({
      ...await validCandidate(),
      constraintReferences: ["authorizedData.member-1.nationality"],
    }, "FIELD_NOT_AUTHORIZED");
  });

  it("rejects a fabricated origin", async () => {
    const candidate = await validCandidate();
    const flights = structuredClone(candidate.flights) as Array<Record<string, unknown>>;
    flights[0].origin = "Singapore";
    await expectViolation({ ...candidate, flights }, "ORIGIN_NOT_ALLOWED");
  });

  it("rejects a fabricated destination", async () => {
    await expectViolation({ ...await validCandidate(), destination: "Singapore" }, "DESTINATION_NOT_ALLOWED");
  });

  it("rejects an offer with no source", async () => {
    const candidate = await validCandidate();
    const flights = structuredClone(candidate.flights) as Array<Record<string, unknown>>;
    flights[0].source = "";
    await expectViolation({ ...candidate, flights }, "SOURCE_REQUIRED");
  });

  it("rejects a fabricated provider-backed price", async () => {
    const candidate = await validCandidate();
    const flights = structuredClone(candidate.flights) as Array<Record<string, unknown>>;
    flights[0].priceUsd = 1;
    await expectViolation({ ...candidate, flights }, "EVIDENCE_MISMATCH");
  });

  it("rejects malformed model output without echoing rejected values", async () => {
    try {
      validatePlanOutput({ planData: { destination: "Tokyo" }, snapshot, evidence });
      throw new Error("Expected plan validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PlanValidationError);
      expect((error as PlanValidationError).violations).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "STRUCTURE_INVALID" })]),
      );
      expect(JSON.stringify((error as PlanValidationError).violations)).not.toContain("Tokyo");
    }
  });

  it("narrows usable and unavailable provider results by outcome", () => {
    const usable: ProviderResult<string[]> = {
      outcome: "FALLBACK_DEMO",
      data: ["offer"],
      source: "Demo data",
      capturedAt: "2026-08-23T00:00:00.000Z",
      fixtureVersion: "2026-08-23.v1",
      reason: "LIVE_PROVIDER_NOT_CONFIGURED",
    };
    const unavailable: ProviderResult<string[]> = {
      outcome: "UNAVAILABLE",
      reason: "FIXTURE_NOT_FOUND",
    };

    expect(usable.outcome === "UNAVAILABLE" ? [] : usable.data).toEqual(["offer"]);
    expect(unavailable.outcome === "UNAVAILABLE" ? unavailable.reason : unavailable.data).toBe("FIXTURE_NOT_FOUND");
  });

  it("returns violations through the shared correlation-aware error path", async () => {
    const app = Fastify();
    const correlationId = randomUUID();
    app.decorateRequest("correlationId");
    app.addHook("onRequest", async request => {
      request.correlationId = correlationId;
    });
    app.setErrorHandler(errorHandler);
    app.get("/invalid-plan", async () => {
      throw new PlanValidationError([{
        code: "FIELD_NOT_AUTHORIZED",
        fieldPath: "constraintReferences.0",
        reason: "Snapshot field is not authorized",
      }]);
    });

    const response = await app.inject({ method: "GET", url: "/invalid-plan" });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: "PlanValidationError",
      correlationId,
      violations: [{ code: "FIELD_NOT_AUTHORIZED", fieldPath: "constraintReferences.0" }],
    });
    await app.close();
  });

  it("persists a validated LLM-style candidate", async () => {
    const suffix = randomUUID();
    const [user] = await db.insert(users).values({
      externalId: `validator-valid-${suffix}`,
      displayName: "Validator Valid Test",
    }).returning();
    const [trip] = await db.insert(sharedTrips).values({
      name: "Validator Valid Test Trip",
      createdBy: user.id,
      departureCities: snapshot.departureCities,
      destinationCandidates: snapshot.destinationCandidates,
      travelDateStart: snapshot.travelDateStart,
      travelDateEnd: snapshot.travelDateEnd,
    }).returning();
    const [storedSnapshot] = await db.insert(constraintSnapshots).values({
      tripId: trip.id,
      version: 1,
      authorizedData: {},
      departureCities: snapshot.departureCities,
      destinationCandidates: snapshot.destinationCandidates,
      travelDateStart: snapshot.travelDateStart,
      travelDateEnd: snapshot.travelDateEnd,
    }).returning();

    try {
      const planId = await generatePlan({
        ctx: createRequestContext(user.id),
        tripId: trip.id,
        snapshotId: storedSnapshot.id,
        destination: "Tokyo",
        memberIds: [user.id],
      }, {
        flightProvider: new FixtureFlightProvider(),
        stayProvider: new FixtureStayProvider(),
        groundProvider: new FixtureGroundProvider(),
        modelGateway: llmStyleGateway(await validCandidate()),
      });

      expect(await db.select().from(itineraryPlans).where(eq(itineraryPlans.id, planId))).toHaveLength(1);
      expect(await db.select().from(providerOffers).where(eq(providerOffers.snapshotId, storedSnapshot.id))).not.toEqual([]);
    } finally {
      await db.delete(auditEvents).where(eq(auditEvents.actorUserId, user.id));
      await db.delete(itineraryPlans).where(eq(itineraryPlans.tripId, trip.id));
      await db.delete(constraintSnapshots).where(eq(constraintSnapshots.id, storedSnapshot.id));
      await db.delete(sharedTrips).where(eq(sharedTrips.id, trip.id));
      await db.delete(users).where(eq(users.id, user.id));
    }
  });

  it("rejects an invalid LLM-style candidate without authoritative persistence", async () => {
    const suffix = randomUUID();
    const [user] = await db.insert(users).values({
      externalId: `validator-${suffix}`,
      displayName: "Validator Test",
    }).returning();
    const [trip] = await db.insert(sharedTrips).values({
      name: "Validator Test Trip",
      createdBy: user.id,
      departureCities: snapshot.departureCities,
      destinationCandidates: snapshot.destinationCandidates,
      travelDateStart: snapshot.travelDateStart,
      travelDateEnd: snapshot.travelDateEnd,
    }).returning();
    const [storedSnapshot] = await db.insert(constraintSnapshots).values({
      tripId: trip.id,
      version: 1,
      authorizedData: {},
      departureCities: snapshot.departureCities,
      destinationCandidates: snapshot.destinationCandidates,
      travelDateStart: snapshot.travelDateStart,
      travelDateEnd: snapshot.travelDateEnd,
    }).returning();

    const invalidGateway = llmStyleGateway({
      ...await validCandidate(),
      constraintReferences: ["authorizedData.missing-member.nationality"],
    });

    try {
      await expect(generatePlan({
        ctx: createRequestContext(user.id),
        tripId: trip.id,
        snapshotId: storedSnapshot.id,
        destination: "Tokyo",
        memberIds: [user.id],
      }, {
        flightProvider: new FixtureFlightProvider(),
        stayProvider: new FixtureStayProvider(),
        groundProvider: new FixtureGroundProvider(),
        modelGateway: invalidGateway,
      })).rejects.toBeInstanceOf(PlanValidationError);

      expect(await db.select().from(itineraryPlans).where(eq(itineraryPlans.tripId, trip.id))).toEqual([]);
      expect(await db.select().from(providerOffers).where(eq(providerOffers.snapshotId, storedSnapshot.id))).toEqual([]);
      expect(await db.select().from(auditEvents).where(eq(auditEvents.tripId, trip.id))).toEqual([]);
    } finally {
      await db.delete(auditEvents).where(eq(auditEvents.actorUserId, user.id));
      await db.delete(constraintSnapshots).where(eq(constraintSnapshots.id, storedSnapshot.id));
      await db.delete(sharedTrips).where(eq(sharedTrips.id, trip.id));
      await db.delete(users).where(eq(users.id, user.id));
    }
  });
});
