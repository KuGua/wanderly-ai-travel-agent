import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";

import { runMigrations } from "../../src/db/migrate.js";
import { db } from "../../src/db/database.js";
import {
  bookingExecutions,
  constraintSnapshots,
  itineraryPlans,
  memberConfirmations,
  providerOffers,
  sharedTrips,
  tripMembers,
  users,
} from "../../src/db/schema.js";
import { BookingGateError, submitBooking } from "../../src/services/booking-service.js";
import { createRequestContext } from "../../src/utils/context.js";

const connectionString =
  process.env.TEST_DATABASE_URL
  ?? "postgres://travelagent:travelagent@127.0.0.1:5432/travelagent?options=-csearch_path%3Dtravelagent_test";

/**
 * Spec §5 — booking must independently revalidate flight offer freshness
 * immediately before sandbox execution; a plan that was fresh at confirmation
 * time is not trusted as still fresh at booking time.
 */
describe("submitBooking — flight offer freshness guard", () => {
  let cleanup: postgres.Sql;
  let ownerId: string;
  let tripId: string;
  let snapshotId: string;
  let planId: string;

  beforeAll(async () => {
    await runMigrations(connectionString);
    cleanup = postgres(connectionString, { max: 1 });
  });

  afterAll(async () => {
    await cleanup.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await cleanup.unsafe(`
      TRUNCATE TABLE
        audit_events, idempotency_records, booking_executions, provider_offers,
        member_confirmations, constraint_snapshots, itinerary_plans,
        trip_members, shared_trips
      RESTART IDENTITY CASCADE
    `);
    await cleanup`DELETE FROM users`;

    ownerId = (await db.insert(users).values({
      externalId: `booking-owner-${randomUUID()}`,
      displayName: "Booking Owner",
    }).returning({ id: users.id }))![0].id;

    tripId = randomUUID();
    await db.insert(sharedTrips).values({
      id: tripId,
      name: "Booking Freshness Trip",
      nameSource: "AUTO",
      status: "PLANNING",
      createdBy: ownerId,
      departureCities: ["SF"],
      destinationCandidates: ["Tokyo"],
    });
    await db.insert(tripMembers).values({
      tripId, userId: ownerId, role: "CREATOR", isRequired: true,
    });

    snapshotId = randomUUID();
    await db.insert(constraintSnapshots).values({
      id: snapshotId,
      tripId,
      version: 1,
      authorizedData: { _meta: { schemaVersion: 2 } },
      departureCities: ["SF"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: "2026-09-01",
      travelDateEnd: "2026-09-08",
    });

    // ACTIVE plan with an all-required-members-CONFIRMED quorum — the two
    // preconditions submitBooking's own gate already enforces, so the tests
    // below isolate the freshness guard specifically.
    planId = randomUUID();
    await db.insert(itineraryPlans).values({
      id: planId, tripId, snapshotId, version: 1, status: "ACTIVE", planData: {},
    });
    await db.insert(memberConfirmations).values({
      planId, userId: ownerId, tripId, status: "CONFIRMED", decidedAt: new Date(),
    });
  });

  async function insertFlightOffer(
    expiresAt: Date | null,
    providerName = "amadeus",
    expiryProvenance: "PROVIDER_VERIFIED" | "SYNTHETIC" | null = "PROVIDER_VERIFIED",
  ): Promise<void> {
    await db.insert(providerOffers).values({
      snapshotId, planId, category: "flight", providerName,
      providerOfferId: "offer-1", currency: "USD", expiresAt, expiryProvenance,
      offerData: { id: `${providerName}:offer-1` },
    });
  }

  it("proceeds when the selected flight offer is fresh and PROVIDER_VERIFIED", async () => {
    await insertFlightOffer(new Date(Date.now() + 60 * 60_000));
    const result = await submitBooking({
      ctx: createRequestContext(ownerId), planId, tripId,
      orchestrationRequestId: randomUUID(), requestedBy: ownerId,
    });
    expect(result.isDuplicate).toBe(false);

    const [row] = await db.select().from(bookingExecutions).where(eq(bookingExecutions.planId, planId));
    expect(row?.status).toBe("PENDING");
  });

  it("rejects booking, and writes no booking_executions row, when the offer expired after confirmation", async () => {
    // Fresh at the moment adoption/confirmation would have checked it...
    await insertFlightOffer(new Date(Date.now() + 60 * 60_000));
    // ...but time has since passed and the offer has now expired by the time
    // booking is attempted. Confirmation-time freshness must not be trusted
    // as proof the offer is still fresh at booking time.
    await db.update(providerOffers)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(providerOffers.planId, planId));

    const orchestrationRequestId = randomUUID();
    await expect(submitBooking({
      ctx: createRequestContext(ownerId), planId, tripId,
      orchestrationRequestId, requestedBy: ownerId,
    })).rejects.toMatchObject({ category: "offer_stale" });

    const rows = await db.select().from(bookingExecutions).where(eq(bookingExecutions.orchestrationRequestId, orchestrationRequestId));
    expect(rows).toHaveLength(0);
  });

  it("rejects booking for a SerpAPI-sourced (SYNTHETIC) offer even with a future timestamp, with no state mutation", async () => {
    await insertFlightOffer(new Date(Date.now() + 60 * 60_000), "serpapi", "SYNTHETIC");

    const orchestrationRequestId = randomUUID();
    await expect(submitBooking({
      ctx: createRequestContext(ownerId), planId, tripId,
      orchestrationRequestId, requestedBy: ownerId,
    })).rejects.toBeInstanceOf(BookingGateError);

    // No booking_executions row means no sandbox/provider call can ever be
    // triggered from this rejected attempt — that row is the sole trigger.
    const rows = await db.select().from(bookingExecutions).where(eq(bookingExecutions.orchestrationRequestId, orchestrationRequestId));
    expect(rows).toHaveLength(0);
  });

  it("rejects booking for an Amadeus offer whose expiry is only the SYNTHETIC fallback, even with a future timestamp, and makes no booking_executions row (no sandbox call)", async () => {
    // The exact regression this review targets: "amadeus" as provider_name
    // must never grant trust on its own — only a persisted
    // PROVIDER_VERIFIED provenance may pass the booking guard.
    await insertFlightOffer(new Date(Date.now() + 60 * 60_000), "amadeus", "SYNTHETIC");

    const orchestrationRequestId = randomUUID();
    await expect(submitBooking({
      ctx: createRequestContext(ownerId), planId, tripId,
      orchestrationRequestId, requestedBy: ownerId,
    })).rejects.toMatchObject({ category: "offer_stale" });

    const rows = await db.select().from(bookingExecutions).where(eq(bookingExecutions.orchestrationRequestId, orchestrationRequestId));
    expect(rows).toHaveLength(0);
  });

  it("rejects booking for a historical row with unknown (NULL) provenance", async () => {
    await insertFlightOffer(new Date(Date.now() + 60 * 60_000), "amadeus", null);
    await expect(submitBooking({
      ctx: createRequestContext(ownerId), planId, tripId,
      orchestrationRequestId: randomUUID(), requestedBy: ownerId,
    })).rejects.toMatchObject({ category: "offer_stale" });
  });

  it("rejects booking when the offer is missing a verifiable expiry", async () => {
    await insertFlightOffer(null);
    await expect(submitBooking({
      ctx: createRequestContext(ownerId), planId, tripId,
      orchestrationRequestId: randomUUID(), requestedBy: ownerId,
    })).rejects.toMatchObject({ category: "offer_stale" });
  });
});
