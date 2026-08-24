import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import { users, userProfiles, sharedTrips, tripMembers, consentGrants, constraintSnapshots, itineraryPlans, memberConfirmations, bookingExecutions, idempotencyRecords, auditEvents, providerOffers, sourceEvidence, visaReadinessChecks, preferenceFacts, destinationCandidates } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { grantConsent, revokeConsent, getActiveConsents, buildAuthorizedData } from "../src/services/consent-service.js";
import { createConstraintSnapshot, generatePlan, markPlanStale, getLatestActivePlan } from "../src/services/planning-service.js";
import { setConfirmation, checkAllConfirmed, markConfirmationsStale } from "../src/services/confirmation-service.js";
import { submitBooking, handleSandboxCallback } from "../src/services/booking-service.js";
import { processChangeEvent } from "../src/services/change-event-service.js";
import { checkVisaReadiness } from "../src/services/visa-service.js";
import { createRequestContext } from "../src/utils/context.js";
import { randomUUID } from "node:crypto";

let aliceId: string;
let bobId: string;
let chenId: string;
let tripId: string;
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
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
});

afterAll(async () => {
  await app.close();
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

describe("Consent & Authorization", () => {
  it("grants and retrieves consent", async () => {
    await grantConsent({
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
      tripId,
      userId: aliceId,
      scope: "PROFILE_NATIONALITY",
      fieldList: ["nationality"],
    });

    let consents = await getActiveConsents({ tripId, userId: aliceId });
    expect(consents.length).toBe(1);

    await revokeConsent({
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
      tripId,
      userId: aliceId,
      scope: "PROFILE_PREFERENCES",
    });

    // Mark plan stale (simulating the change event flow)
    await markPlanStale({
      ctx,
      planId,
      reason: "Consent revoked",
    });

    plan = await getLatestActivePlan(tripId);
    expect(plan).toBeNull(); // No active plan
  });
});

describe("Constraint Snapshot Immutability", () => {
  it("all provider calls reference the same snapshot ID", async () => {
    const ctx = createRequestContext(aliceId);

    await grantConsent({
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

describe("Fixture-backed Planning API", () => {
  it("returns a complete two-origin plan and persists fixture provenance", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/planning/generate",
      headers: { "x-demo-user": "alice" },
      payload: { tripId },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const flights = body.plan.flights as Array<Record<string, unknown>>;
    expect(flights.map(flight => flight.origin).sort()).toEqual(["San Francisco", "Shanghai"]);

    const offers = await db.select().from(providerOffers).where(eq(providerOffers.planId, body.planId));
    const evidence = await db.select().from(sourceEvidence).where(eq(sourceEvidence.planId, body.planId));

    expect(new Set(offers.map(offer => offer.category))).toEqual(new Set(["flight", "stay", "ground"]));
    expect(offers.every(offer => offer.isDemo)).toBe(true);
    expect(new Set(evidence.map(item => item.category))).toEqual(new Set(["flight", "stay", "ground"]));
    expect(evidence.every(item =>
      (item.metadata as Record<string, unknown>).fixtureVersion === "2026-08-23.v1"
    )).toBe(true);
  });

  it("returns the same normalized plan for repeated fixture requests", async () => {
    const request = {
      method: "POST" as const,
      url: "/api/v1/planning/generate",
      headers: { "x-demo-user": "alice" },
      payload: { tripId },
    };

    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().plan).toEqual(first.json().plan);
  });

  it("returns a typed failure and creates no plan for an unsupported fixture route", async () => {
    await db.update(sharedTrips)
      .set({ destinationCandidates: ["Singapore"] })
      .where(eq(sharedTrips.id, tripId));

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/planning/generate",
      headers: { "x-demo-user": "alice" },
      payload: { tripId },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: "PlanningDataUnavailableError",
      message: expect.stringContaining("flight:San Francisco"),
      correlationId: expect.any(String),
    });
    expect(response.headers["x-correlation-id"]).toBe(response.json().correlationId);

    const plans = await db.select().from(itineraryPlans).where(eq(itineraryPlans.tripId, tripId));
    expect(plans).toEqual([]);
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
  it("duplicate booking requests return cached result", async () => {
    const ctx = createRequestContext(aliceId);

    // Create plan and get all confirmations
    const snapshotId = await createConstraintSnapshot({
      tripId,
      memberIds: [aliceId, bobId, chenId],
      departureCities: ["San Francisco", "Shanghai"],
      destinationCandidates: ["Tokyo"],
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
    expect(result1.results.length).toBeGreaterThan(0);

    // Duplicate booking
    const result2 = await submitBooking({
      ctx,
      planId,
      tripId,
      orchestrationRequestId,
      requestedBy: aliceId,
    });

    expect(result2.isDuplicate).toBe(true);
  });

  it("duplicate callbacks are handled idempotently", async () => {
    const ctx = createRequestContext(aliceId);

    // Create plan and get all confirmations
    const snapshotId = await createConstraintSnapshot({
      tripId,
      memberIds: [aliceId, bobId, chenId],
      departureCities: ["San Francisco", "Shanghai"],
      destinationCandidates: ["Tokyo"],
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
