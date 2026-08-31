import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";

import { runMigrations } from "../../src/db/migrate.js";
import { db } from "../../src/db/database.js";
import {
  constraintSnapshots,
  itineraryPlans,
  providerOffers,
  sharedTrips,
  tripMembers,
  users,
} from "../../src/db/schema.js";
import { soloAdoptProposedPlan } from "../../src/services/plan-adoption-service.js";
import { createRequestContext } from "../../src/utils/context.js";

const connectionString =
  process.env.TEST_DATABASE_URL
  ?? "postgres://travelagent:travelagent@127.0.0.1:5432/travelagent?options=-csearch_path%3Dtravelagent_test";

/**
 * Spec §6.2 names confirmation and the booking sandbox as the flight-offer
 * freshness checkpoints — not adoption. `ACTIVE` means "this is the trip's
 * chosen itinerary," not "this quote is still bookable," so
 * `activateProposedPlan` (exercised here through its solo-trip caller,
 * `soloAdoptProposedPlan`) must succeed regardless of offer expiry or
 * provenance, including for SYNTHETIC-only providers (e.g. SerpAPI/FlightAPI)
 * that can never produce a PROVIDER_VERIFIED offer. The guard itself is
 * covered separately in flight-offer-freshness-service.test.ts,
 * booking-offer-freshness.test.ts, and the confirmation-service tests.
 */
describe("plan adoption — does not gate on flight offer freshness", () => {
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
        audit_events, provider_offers, plan_adoption_votes, member_confirmations,
        constraint_snapshots, itinerary_plans, trip_members, shared_trips
      RESTART IDENTITY CASCADE
    `);
    await cleanup`DELETE FROM users`;

    ownerId = (await db.insert(users).values({
      externalId: `adoption-owner-${randomUUID()}`,
      displayName: "Adoption Owner",
    }).returning({ id: users.id }))![0].id;

    tripId = randomUUID();
    await db.insert(sharedTrips).values({
      id: tripId,
      name: "Adoption Freshness Trip",
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

    planId = randomUUID();
    await db.insert(itineraryPlans).values({
      id: planId,
      tripId,
      snapshotId,
      version: 1,
      status: "PROPOSED",
      planData: {},
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

  it("activates the plan when its selected flight offer is fresh and PROVIDER_VERIFIED", async () => {
    await insertFlightOffer(new Date(Date.now() + 60 * 60_000));
    const result = await soloAdoptProposedPlan({
      ctx: createRequestContext(ownerId), planId, userId: ownerId,
    });
    expect(result.status).toBe("ACTIVE");
  });

  it("activates the plan even when the PROVIDER_VERIFIED flight offer has expired", async () => {
    await insertFlightOffer(new Date(Date.now() - 60_000));
    const result = await soloAdoptProposedPlan({
      ctx: createRequestContext(ownerId), planId, userId: ownerId,
    });
    expect(result.status).toBe("ACTIVE");
  });

  it("activates the plan even when the flight offer is missing a verifiable expiry", async () => {
    await insertFlightOffer(null);
    const result = await soloAdoptProposedPlan({
      ctx: createRequestContext(ownerId), planId, userId: ownerId,
    });
    expect(result.status).toBe("ACTIVE");
  });

  it("activates a SerpAPI-sourced (SYNTHETIC) plan — this is the default-provider demo path and must reach ACTIVE", async () => {
    await insertFlightOffer(new Date(Date.now() + 60 * 60_000), "serpapi", "SYNTHETIC");
    const result = await soloAdoptProposedPlan({
      ctx: createRequestContext(ownerId), planId, userId: ownerId,
    });
    expect(result.status).toBe("ACTIVE");

    const [plan] = await db.select().from(itineraryPlans).where(eq(itineraryPlans.id, planId));
    expect(plan?.status).toBe("ACTIVE");
  });

  it("activates the plan for an Amadeus offer whose expiry is only the SYNTHETIC fallback", async () => {
    await insertFlightOffer(new Date(Date.now() + 60 * 60_000), "amadeus", "SYNTHETIC");
    const result = await soloAdoptProposedPlan({
      ctx: createRequestContext(ownerId), planId, userId: ownerId,
    });
    expect(result.status).toBe("ACTIVE");
  });

  it("activates the plan for a historical row with unknown (NULL) provenance", async () => {
    await insertFlightOffer(new Date(Date.now() + 60 * 60_000), "amadeus", null);
    const result = await soloAdoptProposedPlan({
      ctx: createRequestContext(ownerId), planId, userId: ownerId,
    });
    expect(result.status).toBe("ACTIVE");
  });

  it("activates a plan with no flight offers at all (e.g. hotel-only research)", async () => {
    const result = await soloAdoptProposedPlan({
      ctx: createRequestContext(ownerId), planId, userId: ownerId,
    });
    expect(result.status).toBe("ACTIVE");
  });
});
