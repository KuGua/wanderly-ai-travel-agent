import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "../src/db/database.js";
import {
  users,
  sharedTrips,
  tripMembers,
  bookingExecutions,
  constraintSnapshots,
  itineraryPlans,
  auditEvents,
  idempotencyRecords,
} from "../src/db/schema.js";
import { handleSandboxCallback, submitBooking } from "../src/services/booking-service.js";
import { createRequestContext } from "../src/utils/context.js";

describe("booking-service.handleSandboxCallback stale detection", () => {
  let tripId: string;
  let planId: string;
  let snapshotId: string;
  let userId: string;
  let orchestrationRequestId: string;
  let idempotencyKeys: string[];

  beforeEach(async () => {
    const [u] = await db.insert(users).values({
      externalId: `booking-test-${randomUUID()}`,
      displayName: "booking-test",
    }).returning();
    userId = u.id;

    const [trip] = await db.insert(sharedTrips).values({
      name: `booking-test-${randomUUID()}`,
      createdBy: u.id,
      departureCities: ["San Francisco"],
      destinationCandidates: ["Tokyo"],
    }).returning();
    tripId = trip.id;

    await db.insert(tripMembers).values({
      tripId,
      userId: u.id,
      role: "CREATOR",
      isRequired: true,
    });

    const [snapshot] = await db.insert(constraintSnapshots).values({
      tripId,
      version: 1,
      authorizedData: {},
      departureCities: ["San Francisco"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: "2025-08-01",
      travelDateEnd: "2025-08-07",
    }).returning();
    snapshotId = snapshot.id;

    const [plan] = await db.insert(itineraryPlans).values({
      tripId,
      snapshotId,
      version: 1,
      status: "ACTIVE",
      planData: {},
    }).returning();
    planId = plan.id;

    orchestrationRequestId = randomUUID();
    idempotencyKeys = [];
  });

  afterEach(async () => {
    await db.delete(auditEvents).where(eq(auditEvents.tripId, tripId));
    await db.delete(bookingExecutions).where(eq(bookingExecutions.tripId, tripId));
    if (idempotencyKeys.length > 0) {
      await db.delete(idempotencyRecords)
        .where(inArray(idempotencyRecords.idempotencyKey, idempotencyKeys));
    }
    await db.delete(itineraryPlans).where(eq(itineraryPlans.id, planId));
    await db.delete(constraintSnapshots).where(eq(constraintSnapshots.id, snapshotId));
    await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
    await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("returns isStale=true when callback targets a booking already in SUCCESS", async () => {
    // Pre-create a finalized booking row to simulate the sandbox already
    // reported success earlier.
    await db.insert(bookingExecutions).values({
      planId,
      tripId,
      orchestrationRequestId,
      status: "SUCCESS",
      sandboxResults: { flight: { status: "SUCCESS", reference: "DEMO-FLT-001" } },
      requestedBy: (await db.select().from(tripMembers).where(eq(tripMembers.tripId, tripId)).limit(1))[0].userId,
      completedAt: new Date(),
    });

    const ctx = createRequestContext(undefined, randomUUID(), randomUUID());
    const eventId = randomUUID();
    idempotencyKeys.push(`callback:${eventId}`);
    const result = await handleSandboxCallback({
      ctx,
      orchestrationRequestId,
      eventId,
      serviceResults: {
        flight: { status: "SUCCESS", reference: "DEMO-FLT-002" },
      },
    });

    expect(result.isDuplicate).toBe(true);
    expect(result.isStale).toBe(true);

  });

  it("returns isStale=false on the first callback for a PENDING booking", async () => {
    await db.insert(bookingExecutions).values({
      planId,
      tripId,
      orchestrationRequestId,
      status: "PENDING",
      requestedBy: (await db.select().from(tripMembers).where(eq(tripMembers.tripId, tripId)).limit(1))[0].userId,
    });

    const ctx = createRequestContext(undefined, randomUUID(), randomUUID());
    const eventId = randomUUID();
    idempotencyKeys.push(`callback:${eventId}`);
    const result = await handleSandboxCallback({
      ctx,
      orchestrationRequestId,
      eventId,
      serviceResults: {
        flight: { status: "SUCCESS", reference: "DEMO-FLT-100" },
      },
    });

    expect(result.isDuplicate).toBe(false);
    expect(result.isStale).toBe(false);

  });

  it("rejects booking a stale existing plan without creating a booking side effect", async () => {
    await db.update(itineraryPlans)
      .set({ status: "STALE", staleReason: "test fixture invalidated" })
      .where(eq(itineraryPlans.id, planId));

    const bookingRequestId = randomUUID();
    idempotencyKeys.push(`booking:${bookingRequestId}`);
    await expect(submitBooking({
      ctx: createRequestContext(userId, randomUUID(), randomUUID()),
      planId,
      tripId,
      orchestrationRequestId: bookingRequestId,
      requestedBy: userId,
    })).rejects.toThrow("Cannot book plan with status STALE");

    const bookings = await db.select().from(bookingExecutions)
      .where(eq(bookingExecutions.tripId, tripId));
    expect(bookings).toEqual([]);
  });
});
