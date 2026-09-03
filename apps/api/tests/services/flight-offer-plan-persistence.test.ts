import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";

import { runMigrations } from "../../src/db/migrate.js";
import { db } from "../../src/db/database.js";
import { providerOffers, sharedTrips, tripMembers, users } from "../../src/db/schema.js";
import { createConstraintSnapshot, generatePlan } from "../../src/services/planning-service.js";
import { createRequestContext } from "../../src/utils/context.js";
import { testPlanningDependencies } from "../helpers/planning.js";

const connectionString =
  process.env.TEST_DATABASE_URL
  ?? "postgres://travelagent:travelagent@127.0.0.1:5432/travelagent?options=-csearch_path%3Dtravelagent_test";

/**
 * Regression test for the freshness-guard prerequisite: the `provider_offers`
 * row actually linked to a plan (`planId` FK, written at plan finalization
 * in `generatePlan`) previously never carried `expires_at` / `currency` /
 * `provider_offer_id` — only the search-time row did. Without this,
 * `validateSelectedFlightOffersFresh` would find `expires_at IS NULL` for
 * every real plan and reject it as MISSING_EXPIRY unconditionally.
 */
describe("generatePlan — flight offer persistence carries freshness fields", () => {
  let cleanup: postgres.Sql;
  let userId: string;
  let tripId: string;

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
        audit_events, provider_offers, source_evidence, constraint_snapshots,
        itinerary_plans, trip_members, shared_trips
      RESTART IDENTITY CASCADE
    `);
    await cleanup`DELETE FROM users`;

    const [user] = await db.insert(users).values({
      externalId: `persist-owner-${randomUUID()}`, displayName: "Persist Owner",
    }).returning();
    userId = user.id;
    const [trip] = await db.insert(sharedTrips).values({
      name: "Persistence Trip", createdBy: userId,
      departureCities: ["San Francisco"], destinationCandidates: ["Tokyo"],
    }).returning();
    tripId = trip.id;
    await db.insert(tripMembers).values({ tripId, userId, role: "CREATOR", isRequired: true });
  });

  it("persists providerOfferId, currency, and expiresAt on the plan-linked flight offer row", async () => {
    const snapshotId = await createConstraintSnapshot({
      tripId,
      memberIds: [userId],
      departureCities: ["San Francisco"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: "2026-09-01",
      travelDateEnd: "2026-09-08",
    });

    const outcome = await generatePlan({
      ctx: createRequestContext(userId),
      tripId,
      snapshotId,
      destination: "Tokyo",
      memberIds: [userId],
    }, testPlanningDependencies);
    if (outcome.outcome !== "PLAN") throw new Error(`expected PLAN outcome, got ${outcome.outcome}`);
    const planId = outcome.planId;

    const [offer] = await db.select().from(providerOffers).where(and(
      eq(providerOffers.planId, planId),
      eq(providerOffers.category, "flight"),
    ));
    expect(offer).toBeDefined();
    expect(offer.providerOfferId).toBe("test-flight-san-francisco-tokyo");
    expect(offer.currency).toBe("USD");
    // The fixture computes expiresAt relative to wall time (see
    // tests/helpers/planning.ts) so it never goes stale; assert it's a real,
    // future timestamp rather than pinning an exact value.
    expect(offer.expiresAt).not.toBeNull();
    expect(offer.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(offer.expiryProvenance).toBe("PROVIDER_VERIFIED");
  });
});
