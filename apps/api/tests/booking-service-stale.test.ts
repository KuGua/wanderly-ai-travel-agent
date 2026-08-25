import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "../src/db/database.js";
import {
  users,
  sharedTrips,
  tripMembers,
  bookingExecutions,
} from "../src/db/schema.js";
import { handleSandboxCallback } from "../src/services/booking-service.js";
import { createRequestContext } from "../src/utils/context.js";

async function cleanup(tripId?: string) {
  if (tripId) {
    await db.delete(bookingExecutions).where(eq(bookingExecutions.tripId, tripId));
    await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
    await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
  }
}

describe("booking-service.handleSandboxCallback stale detection", () => {
  let tripId: string;
  let planId = "00000000-0000-0000-0000-000000000000"; // dummy for FK; the test only cares about booking row
  let orchestrationRequestId: string;

  beforeEach(async () => {
    const [u] = await db.insert(users).values({
      externalId: `booking-test-${randomUUID()}`,
      displayName: "booking-test",
    }).returning();

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

    orchestrationRequestId = randomUUID();
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
    const result = await handleSandboxCallback({
      ctx,
      orchestrationRequestId,
      eventId: randomUUID(),
      serviceResults: {
        flight: { status: "SUCCESS", reference: "DEMO-FLT-002" },
      },
    });

    expect(result.isDuplicate).toBe(true);
    expect(result.isStale).toBe(true);

    await cleanup(tripId);
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
    const result = await handleSandboxCallback({
      ctx,
      orchestrationRequestId,
      eventId: randomUUID(),
      serviceResults: {
        flight: { status: "SUCCESS", reference: "DEMO-FLT-100" },
      },
    });

    expect(result.isDuplicate).toBe(false);
    expect(result.isStale).toBe(false);

    await cleanup(tripId);
  });
});
