import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import { users, userProfiles, sharedTrips, tripMembers, consentGrants, constraintSnapshots, itineraryPlans, memberConfirmations, bookingExecutions, idempotencyRecords, auditEvents, providerOffers, sourceEvidence, visaReadinessChecks, preferenceFacts, destinationCandidates } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { grantConsent, revokeConsent, getActiveConsents, buildAuthorizedData } from "../src/services/consent-service.js";
import {
  __setPlanningDependenciesForTests,
  createConstraintSnapshot,
  generatePlan,
  markPlanStale,
  getLatestActivePlan,
  type PlanningDependencies,
} from "../src/services/planning-service.js";
import { setConfirmation, checkAllConfirmed, markConfirmationsStale } from "../src/services/confirmation-service.js";
import { submitBooking, handleSandboxCallback } from "../src/services/booking-service.js";
import { processChangeEvent } from "../src/services/change-event-service.js";
import { checkVisaReadiness } from "../src/services/visa-service.js";
import { createRequestContext } from "../src/utils/context.js";
import { randomUUID } from "node:crypto";
import { authHeaders, verifyTestAccessToken } from "./helpers/auth.js";

let aliceId: string;
let bobId: string;
let chenId: string;
let tripId: string;
let app: FastifyInstance;

const providerCapturedAt = "2026-08-25T00:00:00.000Z";
const integrationPlanningDependencies: PlanningDependencies = {
  flightProvider: {
    async searchFlights(params) {
      return {
        outcome: "LIVE",
        source: "test-flight-provider",
        capturedAt: providerCapturedAt,
        data: [{
          id: `flight-${params.origin.toLowerCase().replaceAll(" ", "-")}-${params.destination.toLowerCase()}`,
          origin: params.origin,
          destination: params.destination,
          departureTime: `${params.dateStart}T08:00:00.000Z`,
          arrivalTime: `${params.dateStart}T16:00:00.000Z`,
          priceUsd: 800,
          isRedEye: false,
          airline: "Test Air",
          source: "test-flight-provider",
          capturedAt: providerCapturedAt,
        }],
      };
    },
  },
  stayProvider: {
    async searchStays(params) {
      return {
        outcome: "LIVE",
        source: "test-stay-provider",
        capturedAt: providerCapturedAt,
        data: [{
          id: `stay-${params.destination.toLowerCase()}`,
          destination: params.destination,
          checkIn: params.checkIn,
          checkOut: params.checkOut,
          pricePerNightUsd: 180,
          style: "city_center",
          location: "Test district",
          source: "test-stay-provider",
          capturedAt: providerCapturedAt,
        }],
      };
    },
  },
  groundProvider: {
    async searchGround(params) {
      return {
        outcome: "LIVE",
        source: "test-ground-provider",
        capturedAt: providerCapturedAt,
        data: [{
          id: `ground-${params.destination.toLowerCase()}`,
          destination: params.destination,
          type: "airport_transfer",
          priceUsd: 35,
          provider: "Test Transfer",
          source: "test-ground-provider",
          capturedAt: providerCapturedAt,
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
        generatedAt: providerCapturedAt,
      };
    },
    async explainPlanDiff() {
      return { added: [], removed: [], changed: [] };
    },
    async generateConversationReply() {
      return { content: "Test-only conversation response", responseMode: "MODEL" };
    },
  },
};

beforeAll(async () => {
  __setPlanningDependenciesForTests(integrationPlanningDependencies);
  app = await buildApp({ verifyAccessToken: verifyTestAccessToken });
  await app.ready();

  // Get or create demo users
  const aliceRecords = await db.select().from(users).where(eq(users.externalId, "alice")).limit(1);
  const bobRecords = await db.select().from(users).where(eq(users.externalId, "bob")).limit(1);
  const chenRecords = await db.select().from(users).where(eq(users.externalId, "chen")).limit(1);

  if (aliceRecords.length === 0) {
    const [alice] = await db.insert(users).values({ externalId: "alice", displayName: "Alice" }).returning();
    aliceId = alice.id;
  } else {
    aliceId = aliceRecords[0].id;
  }

  if (bobRecords.length === 0) {
    const [bob] = await db.insert(users).values({ externalId: "bob", displayName: "Bob" }).returning();
    bobId = bob.id;
  } else {
    bobId = bobRecords[0].id;
  }

  if (chenRecords.length === 0) {
    const [chen] = await db.insert(users).values({ externalId: "chen", displayName: "Chen" }).returning();
    chenId = chen.id;
  } else {
    chenId = chenRecords[0].id;
  }

  // Make this file independent from seed/test execution order.
  await db.update(users).set({ displayName: "Alice" }).where(eq(users.id, aliceId));
  await db.update(users).set({ displayName: "Bob" }).where(eq(users.id, bobId));
  await db.update(users).set({ displayName: "Chen" }).where(eq(users.id, chenId));
});

afterAll(async () => {
  await app.close();
  __setPlanningDependenciesForTests(null);
});

beforeEach(async () => {
  // Clean up between tests (order matters due to foreign keys)
  // Delete leaf tables first, then parent tables
  await db.delete(bookingExecutions);
  await db.delete(idempotencyRecords);
  await db.delete(auditEvents);
  await db.delete(memberConfirmations);
  await db.delete(visaReadinessChecks);
  await db.delete(sourceEvidence);
  await db.delete(providerOffers);
  await db.delete(itineraryPlans);
  await db.delete(destinationCandidates);
  await db.delete(constraintSnapshots);
  await db.delete(consentGrants);
  await db.delete(preferenceFacts);
  await db.delete(tripMembers);
  await db.delete(sharedTrips);
  await db.delete(userProfiles);

  // Create a test trip
  const [trip] = await db.insert(sharedTrips).values({
    name: "Test Trip",
    createdBy: aliceId,
    departureCities: ["San Francisco", "Shanghai"],
    destinationCandidates: ["Tokyo", "Bangkok"],
    travelDateStart: "2025-08-01",
    travelDateEnd: "2025-08-07",
  }).returning();
  tripId = trip.id;

  // Add members
  await db.insert(tripMembers).values([
    { tripId, userId: aliceId, role: "CREATOR", isRequired: true },
    { tripId, userId: bobId, role: "MEMBER", isRequired: true },
    { tripId, userId: chenId, role: "MEMBER", isRequired: true },
  ]);
});

describe("Frontend API Contract", () => {
  it("lists only member trips with stable ordering, server-derived counts, roles, and dates", async () => {
    const [aliceNewestTrip] = await db.insert(sharedTrips).values({
      name: "Alice Newest",
      createdBy: aliceId,
      departureCities: ["San Francisco"],
      destinationCandidates: ["Tokyo", "Seoul"],
      travelDateStart: null,
      travelDateEnd: null,
      createdAt: new Date("2030-01-01T00:00:00.000Z"),
    }).returning();
    const [aliceOldestTrip] = await db.insert(sharedTrips).values({
      name: "Alice Oldest",
      createdBy: aliceId,
      departureCities: ["San Francisco", "Shanghai"],
      destinationCandidates: ["Tokyo", "Bangkok"],
      travelDateStart: "2025-08-01",
      travelDateEnd: "2025-08-07",
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    }).returning();
    const [bobOnlyTrip] = await db.insert(sharedTrips).values({
      name: "Bob Only",
      createdBy: bobId,
      departureCities: ["San Francisco"],
      destinationCandidates: ["Tokyo", "Bangkok"],
    }).returning();

    await db.insert(tripMembers).values([
      { tripId: aliceNewestTrip.id, userId: aliceId, role: "CREATOR", isRequired: true },
      { tripId: aliceNewestTrip.id, userId: chenId, role: "MEMBER", isRequired: true },
      { tripId: aliceOldestTrip.id, userId: aliceId, role: "CREATOR", isRequired: true },
      { tripId: bobOnlyTrip.id, userId: bobId, role: "CREATOR", isRequired: true },
    ]);

    const aliceResponse = await app.inject({
      method: "GET",
      url: "/api/v1/trips",
      headers: authHeaders("alice"),
    });
    const bobResponse = await app.inject({
      method: "GET",
      url: "/api/v1/trips",
      headers: authHeaders("bob"),
    });
    const chenResponse = await app.inject({
      method: "GET",
      url: "/api/v1/trips",
      headers: authHeaders("chen"),
    });

    expect(aliceResponse.statusCode).toBe(200);
    expect(aliceResponse.json().trips.map((trip: { name: string }) => trip.name)).toEqual([
      "Alice Newest",
      "Test Trip",
      "Alice Oldest",
    ]);
    expect(aliceResponse.json().trips[0]).toMatchObject({
      id: aliceNewestTrip.id,
      memberCount: 2,
      role: "CREATOR",
      travelDateStart: null,
      travelDateEnd: null,
      createdAt: "2030-01-01T00:00:00.000Z",
    });
    expect(aliceResponse.json().trips[2]).toMatchObject({
      departureCities: ["San Francisco", "Shanghai"],
      destinationCandidates: ["Tokyo", "Bangkok"],
      travelDateStart: "2025-08-01",
      travelDateEnd: "2025-08-07",
    });
    expect(bobResponse.json().trips.map((trip: { name: string }) => trip.name).sort()).toEqual(["Bob Only", "Test Trip"]);
    expect(chenResponse.json().trips.map((trip: { name: string }) => trip.name).sort()).toEqual(["Alice Newest", "Test Trip"]);
    expect(aliceResponse.json().trips.some((trip: { name: string }) => trip.name === "Bob Only")).toBe(false);
  });

  it("returns safe display names in trip details and blocks unrelated members", async () => {
    const [privateTrip] = await db.insert(sharedTrips).values({
      name: "Alice Private Trip",
      createdBy: aliceId,
      departureCities: ["San Francisco"],
      destinationCandidates: ["Tokyo", "Bangkok"],
    }).returning();
    await db.insert(tripMembers).values({
      tripId: privateTrip.id,
      userId: aliceId,
      role: "CREATOR",
      isRequired: true,
    });

    const allowed = await app.inject({
      method: "GET",
      url: `/api/v1/trips/${privateTrip.id}`,
      headers: authHeaders("alice"),
    });
    const denied = await app.inject({
      method: "GET",
      url: `/api/v1/trips/${privateTrip.id}`,
      headers: authHeaders("bob"),
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().members).toEqual([
      expect.objectContaining({ userId: aliceId, displayName: "Alice", role: "CREATOR" }),
    ]);
    expect(allowed.json().members[0]).not.toHaveProperty("externalId");
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      statusCode: 403,
      error: "Forbidden",
      correlationId: expect.any(String),
    });
    expect(denied.headers["x-correlation-id"]).toBe(denied.json().correlationId);
  });

  it("returns the documented profile and applies strict partial-update semantics", async () => {
    await db.insert(userProfiles).values({
      userId: aliceId,
      nationality: "US",
      interests: ["art", "museums"],
      accommodationStyle: "city_center",
      budgetMaxUsd: 5000,
      noRedEye: true,
      departureCity: "San Francisco",
      availableDepartureDates: ["2025-08-01"],
      updatedAt: new Date("2020-01-01T00:00:00.000Z"),
    });

    const getResponse = await app.inject({
      method: "GET",
      url: "/api/v1/profiles/me",
      headers: authHeaders("alice"),
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json().profile).toMatchObject({
      userId: aliceId,
      displayName: "Alice",
      interests: ["art", "museums"],
      accommodationStyle: "city_center",
      budgetMaxUsd: 5000,
      noRedEye: true,
      departureCity: "San Francisco",
      nationality: "US",
      updatedAt: "2020-01-01T00:00:00.000Z",
    });
    expect(getResponse.json().profile).not.toHaveProperty("passportNumber");

    const updateResponse = await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/me",
      headers: authHeaders("alice"),
      payload: { nationality: "CA", noRedEye: false },
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json().profile).toMatchObject({
      displayName: "Alice",
      nationality: "CA",
      noRedEye: false,
      interests: ["art", "museums"],
    });
    expect(new Date(updateResponse.json().profile.updatedAt).getTime()).toBeGreaterThan(new Date("2020-01-01").getTime());

    for (const payload of [{ displayName: "Mallory" }, { nationality: null }]) {
      const invalidResponse = await app.inject({
        method: "PUT",
        url: "/api/v1/profiles/me",
        headers: authHeaders("alice"),
        payload,
      });
      expect(invalidResponse.statusCode).toBe(400);
      expect(invalidResponse.json()).toMatchObject({
        statusCode: 400,
        error: "Bad Request",
        correlationId: expect.any(String),
      });
      expect(invalidResponse.headers["x-correlation-id"]).toBe(invalidResponse.json().correlationId);
    }
  });

  it("normalizes authentication, validation, and not-found failures with matching correlation IDs", async () => {
    const responses = [
      await app.inject({ method: "GET", url: "/api/v1/trips" }),
      await app.inject({ method: "GET", url: "/api/v1/trips", headers: { authorization: "Bearer invalid" } }),
      await app.inject({
        method: "POST",
        url: "/api/v1/trips",
        headers: authHeaders("alice"),
        payload: { name: "Invalid" },
      }),
      await app.inject({
        method: "PUT",
        url: "/api/v1/profiles/me",
        headers: authHeaders("alice"),
        payload: { interests: ["art"] },
      }),
      await app.inject({ method: "GET", url: "/api/v1/not-real", headers: authHeaders("alice") }),
    ];

    expect(responses.map(response => response.statusCode)).toEqual([401, 401, 400, 404, 404]);
    for (const response of responses) {
      expect(response.json()).toEqual({
        statusCode: response.statusCode,
        error: expect.any(String),
        message: expect.any(String),
        correlationId: expect.any(String),
      });
      expect(response.headers["x-correlation-id"]).toBe(response.json().correlationId);
    }
  });

  it("publishes the new canonical endpoints in OpenAPI", async () => {
    const response = await app.inject({ method: "GET", url: "/docs/json" });

    expect(response.statusCode).toBe(200);
    expect(response.json().paths).not.toHaveProperty("/api/v1/demo/users");
    expect(response.json().paths).toHaveProperty("/api/v1/trips.get");
    expect(response.json().paths).toHaveProperty("/api/v1/profiles/me.get");
    expect(response.json().paths).toHaveProperty("/api/v1/profiles/me.put");
  });
});

describe("Consent & Authorization", () => {
  it("grants and retrieves consent", async () => {
    await grantConsent({
      ctx: createRequestContext(aliceId),
      tripId,
      userId: aliceId,
      scope: "PROFILE_PREFERENCES",
      fieldList: ["interests", "accommodationStyle"],
    });

    const consents = await getActiveConsents({ tripId, userId: aliceId });
    expect(consents.length).toBe(1);
    expect(consents[0].scope).toBe("PROFILE_PREFERENCES");
    expect(consents[0].fieldList).toContain("interests");
  });

  it("revoking consent removes it from active list", async () => {
    await grantConsent({
      ctx: createRequestContext(aliceId),
      tripId,
      userId: aliceId,
      scope: "PROFILE_NATIONALITY",
      fieldList: ["nationality"],
    });

    let consents = await getActiveConsents({ tripId, userId: aliceId });
    expect(consents.length).toBe(1);

    await revokeConsent({
      ctx: createRequestContext(aliceId),
      tripId,
      userId: aliceId,
      scope: "PROFILE_NATIONALITY",
    });

    consents = await getActiveConsents({ tripId, userId: aliceId });
    expect(consents.length).toBe(0);
  });

  it("buildAuthorizedData only includes granted fields", async () => {
    // Create profile for Alice
    await db.insert(userProfiles).values({
      userId: aliceId,
      nationality: "US",
      interests: ["art", "museums"],
      accommodationStyle: "city_center",
      budgetMaxUsd: 5000,
    });

    // Grant only preferences, not nationality
    await grantConsent({
      ctx: createRequestContext(aliceId),
      tripId,
      userId: aliceId,
      scope: "PROFILE_PREFERENCES",
      fieldList: ["interests", "accommodationStyle"],
    });

    const authorized = await buildAuthorizedData({ tripId, userId: aliceId });
    expect(authorized.interests).toBeDefined();
    expect(authorized.accommodationStyle).toBeDefined();
    expect(authorized.nationality).toBeUndefined(); // Not granted
    expect(authorized.budgetMaxUsd).toBeUndefined(); // Not in fieldList
  });
});

describe("Consent Revocation Causes Plan Stale", () => {
  it("revoking consent invalidates existing plans", async () => {
    const ctx = createRequestContext(aliceId);

    // Grant consent and create snapshot
    await grantConsent({
      ctx,
      tripId,
      userId: aliceId,
      scope: "PROFILE_PREFERENCES",
      fieldList: ["interests"],
    });

    const snapshotId = await createConstraintSnapshot({
      tripId,
      memberIds: [aliceId, bobId, chenId],
      departureCities: ["San Francisco", "Shanghai"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: "2025-08-01",
      travelDateEnd: "2025-08-07",
    });

    const planId = await generatePlan({
      ctx,
      tripId,
      snapshotId,
      destination: "Tokyo",
      memberIds: [aliceId, bobId, chenId],
    });

    let plan = await getLatestActivePlan(tripId);
    expect(plan).toBeDefined();
    expect(plan!.id).toBe(planId);

    // Revoke consent
    await revokeConsent({
      ctx,
      tripId,
      userId: aliceId,
      scope: "PROFILE_PREFERENCES",
    });

    plan = await getLatestActivePlan(tripId);
    expect(plan).toBeNull(); // Revocation atomically stales the active plan.
  });
});

describe("Constraint Snapshot Immutability", () => {
  it("all provider calls reference the same snapshot ID", async () => {
    const ctx = createRequestContext(aliceId);

    await grantConsent({
      ctx,
      tripId,
      userId: aliceId,
      scope: "PROFILE_PREFERENCES",
      fieldList: ["interests"],
    });

    const snapshotId = await createConstraintSnapshot({
      tripId,
      memberIds: [aliceId, bobId, chenId],
      departureCities: ["San Francisco", "Shanghai"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: "2025-08-01",
      travelDateEnd: "2025-08-07",
    });

    // Generate plan (which calls all providers with the same snapshotId)
    const planId = await generatePlan({
      ctx,
      tripId,
      snapshotId,
      destination: "Tokyo",
      memberIds: [aliceId, bobId, chenId],
    });

    // Verify snapshot exists and is linked to the plan
    const [snapshot] = await db.select().from(constraintSnapshots).where(eq(constraintSnapshots.id, snapshotId)).limit(1);
    expect(snapshot).toBeDefined();
    expect(snapshot.tripId).toBe(tripId);

    const [plan] = await db.select().from(itineraryPlans).where(eq(itineraryPlans.id, planId)).limit(1);
    expect(plan.snapshotId).toBe(snapshotId);
  });
});

describe("Three-Person Confirmation Threshold", () => {
  it("requires all 3 required members to confirm before booking", async () => {
    const ctx = createRequestContext(aliceId);

    // Create snapshot and plan
    const snapshotId = await createConstraintSnapshot({
      tripId,
      memberIds: [aliceId, bobId, chenId],
      departureCities: ["San Francisco", "Shanghai"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: "2025-08-01",
      travelDateEnd: "2025-08-07",
    });

    const planId = await generatePlan({
      ctx,
      tripId,
      snapshotId,
      destination: "Tokyo",
      memberIds: [aliceId, bobId, chenId],
    });

    // Only Alice and Bob confirm
    await setConfirmation({ ctx, planId, userId: aliceId, tripId, decision: "CONFIRMED" });
    await setConfirmation({ ctx, planId, userId: bobId, tripId, decision: "CONFIRMED" });

    let { allConfirmed } = await checkAllConfirmed({ planId, tripId });
    expect(allConfirmed).toBe(false);

    // Chen confirms
    await setConfirmation({ ctx, planId, userId: chenId, tripId, decision: "CONFIRMED" });

    ({ allConfirmed } = await checkAllConfirmed({ planId, tripId }));
    expect(allConfirmed).toBe(true);
  });

  it("old plan confirmations cannot trigger booking", async () => {
    const ctx = createRequestContext(aliceId);

    // Create first plan
    const snapshotId1 = await createConstraintSnapshot({
      tripId,
      memberIds: [aliceId, bobId, chenId],
      departureCities: ["San Francisco", "Shanghai"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: "2025-08-01",
      travelDateEnd: "2025-08-07",
    });

    const planId1 = await generatePlan({
      ctx,
      tripId,
      snapshotId: snapshotId1,
      destination: "Tokyo",
      memberIds: [aliceId, bobId, chenId],
    });

    // All confirm plan 1
    await setConfirmation({ ctx, planId: planId1, userId: aliceId, tripId, decision: "CONFIRMED" });
    await setConfirmation({ ctx, planId: planId1, userId: bobId, tripId, decision: "CONFIRMED" });
    await setConfirmation({ ctx, planId: planId1, userId: chenId, tripId, decision: "CONFIRMED" });

    // Mark plan 1 as stale
    await markPlanStale({ ctx, planId: planId1, reason: "Test" });
    await markConfirmationsStale(planId1);

    // Try to book old plan — should fail
    await expect(
      submitBooking({
        ctx,
        planId: planId1,
        tripId,
        orchestrationRequestId: randomUUID(),
        requestedBy: aliceId,
      })
    ).rejects.toThrow("Cannot book plan with status STALE");
  });
});

describe("Change Event Idempotency", () => {
  it("duplicate change events are handled idempotently", async () => {
    const ctx = createRequestContext(aliceId);

    // Create initial plan
    const snapshotId = await createConstraintSnapshot({
      tripId,
      memberIds: [aliceId, bobId, chenId],
      departureCities: ["San Francisco", "Shanghai"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: "2025-08-01",
      travelDateEnd: "2025-08-07",
    });

    await generatePlan({
      ctx,
      tripId,
      snapshotId,
      destination: "Tokyo",
      memberIds: [aliceId, bobId, chenId],
    });

    const eventId = randomUUID();

    // Process change event first time
    const result1 = await processChangeEvent({
      ctx,
      tripId,
      eventId,
      eventType: "PRICE_CHANGE",
      payload: { flightId: "flt-sfo-tyo-01", oldPrice: 850, newPrice: 1200 },
    });

    expect(result1.replanned).toBe(true);

    // Process same event again — should be idempotent
    const result2 = await processChangeEvent({
      ctx,
      tripId,
      eventId,
      eventType: "PRICE_CHANGE",
      payload: { flightId: "flt-sfo-tyo-01", oldPrice: 850, newPrice: 1200 },
    });

    expect(result2.replanned).toBe(false); // Already processed
  });
});

describe("Booking Sandbox Idempotency", () => {
  it("duplicate booking requests return the cached pending result", async () => {
    const ctx = createRequestContext(aliceId);

    // Create plan and get all confirmations
    const snapshotId = await createConstraintSnapshot({
      tripId,
      memberIds: [aliceId, bobId, chenId],
      departureCities: ["San Francisco", "Shanghai"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: "2025-08-01",
      travelDateEnd: "2025-08-07",
    });

    const planId = await generatePlan({
      ctx,
      tripId,
      snapshotId,
      destination: "Tokyo",
      memberIds: [aliceId, bobId, chenId],
    });

    await setConfirmation({ ctx, planId, userId: aliceId, tripId, decision: "CONFIRMED" });
    await setConfirmation({ ctx, planId, userId: bobId, tripId, decision: "CONFIRMED" });
    await setConfirmation({ ctx, planId, userId: chenId, tripId, decision: "CONFIRMED" });

    const orchestrationRequestId = randomUUID();

    // First booking
    const result1 = await submitBooking({
      ctx,
      planId,
      tripId,
      orchestrationRequestId,
      requestedBy: aliceId,
    });

    expect(result1.isDuplicate).toBe(false);
    expect(result1.results).toEqual([]);

    // Duplicate booking
    const result2 = await submitBooking({
      ctx,
      planId,
      tripId,
      orchestrationRequestId,
      requestedBy: aliceId,
    });

    expect(result2.isDuplicate).toBe(true);
    expect(result2.results).toEqual(result1.results);
  });

  it("duplicate callbacks are handled idempotently", async () => {
    const ctx = createRequestContext(aliceId);

    // Create plan and get all confirmations
    const snapshotId = await createConstraintSnapshot({
      tripId,
      memberIds: [aliceId, bobId, chenId],
      departureCities: ["San Francisco", "Shanghai"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: "2025-08-01",
      travelDateEnd: "2025-08-07",
    });

    const planId = await generatePlan({
      ctx,
      tripId,
      snapshotId,
      destination: "Tokyo",
      memberIds: [aliceId, bobId, chenId],
    });

    await setConfirmation({ ctx, planId, userId: aliceId, tripId, decision: "CONFIRMED" });
    await setConfirmation({ ctx, planId, userId: bobId, tripId, decision: "CONFIRMED" });
    await setConfirmation({ ctx, planId, userId: chenId, tripId, decision: "CONFIRMED" });

    const orchestrationRequestId = randomUUID();

    // Create booking in PENDING state (simulating async flow)
    await db.insert(bookingExecutions).values({
      planId,
      tripId,
      orchestrationRequestId,
      status: "PENDING",
      requestedBy: aliceId,
    });

    const eventId = randomUUID();

    // First callback
    const result1 = await handleSandboxCallback({
      ctx,
      orchestrationRequestId,
      eventId,
      serviceResults: {
        flight: { status: "SUCCESS", reference: "DEMO-FLT-001" },
      },
    });

    expect(result1.isDuplicate).toBe(false);

    // Duplicate callback
    const result2 = await handleSandboxCallback({
      ctx,
      orchestrationRequestId,
      eventId,
      serviceResults: {
        flight: { status: "SUCCESS", reference: "DEMO-FLT-001" },
      },
    });

    expect(result2.isDuplicate).toBe(true);
  });
});

describe("Visa Readiness - Unauthorized Nationality", () => {
  it("returns UNAUTHORIZED_NO_CHECK when nationality not shared", async () => {
    const ctx = createRequestContext(aliceId);

    const snapshotId = await createConstraintSnapshot({
      tripId,
      memberIds: [aliceId, bobId, chenId],
      departureCities: ["San Francisco", "Shanghai"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: "2025-08-01",
      travelDateEnd: "2025-08-07",
    });

    const planId = await generatePlan({
      ctx,
      tripId,
      snapshotId,
      destination: "Tokyo",
      memberIds: [aliceId, bobId, chenId],
    });

    // Don't grant nationality consent for Alice
    const visaCheck = await checkVisaReadiness({
      planId,
      snapshotId,
      memberId: aliceId,
      tripId,
      destinationCountry: "Japan",
    });

    expect(visaCheck.status).toBe("UNAUTHORIZED_NO_CHECK");
    expect(visaCheck.confidenceLevel).toBe("UNCERTAIN");
    expect(visaCheck.disclaimer).toContain("Nationality was not shared");
  });
});

describe("Error States Cannot Create Bookings", () => {
  it("cannot book with NEEDS_CHANGES confirmation", async () => {
    const ctx = createRequestContext(aliceId);

    const snapshotId = await createConstraintSnapshot({
      tripId,
      memberIds: [aliceId, bobId, chenId],
      departureCities: ["San Francisco", "Shanghai"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: "2025-08-01",
      travelDateEnd: "2025-08-07",
    });

    const planId = await generatePlan({
      ctx,
      tripId,
      snapshotId,
      destination: "Tokyo",
      memberIds: [aliceId, bobId, chenId],
    });

    // Alice confirms, Bob needs changes, Chen confirms
    await setConfirmation({ ctx, planId, userId: aliceId, tripId, decision: "CONFIRMED" });
    await setConfirmation({ ctx, planId, userId: bobId, tripId, decision: "NEEDS_CHANGES" });
    await setConfirmation({ ctx, planId, userId: chenId, tripId, decision: "CONFIRMED" });

    const { allConfirmed } = await checkAllConfirmed({ planId, tripId });
    expect(allConfirmed).toBe(false);

    // Try to book — should fail
    await expect(
      submitBooking({
        ctx,
        planId,
        tripId,
        orchestrationRequestId: randomUUID(),
        requestedBy: aliceId,
      })
    ).rejects.toThrow("Not all required members have confirmed");
  });
});
