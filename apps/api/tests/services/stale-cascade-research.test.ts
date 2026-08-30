import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";

import { runMigrations } from "../../src/db/migrate.js";
import { db } from "../../src/db/database.js";
import {
  agentTaskRuns,
  constraintSnapshots,
  itineraryPlans,
  sharedTrips,
  tripMembers,
  users,
} from "../../src/db/schema.js";
import { stalePlansAndConfirmationsForTrip } from "../../src/services/consent-service.js";

const connectionString =
  process.env.TEST_DATABASE_URL
  ?? "postgres://travelagent:travelagent@127.0.0.1:5432/travelagent?options=-csearch_path%3Dtravelagent_test";

describe("stale cascade — Phase 4 RESEARCH cancellation", () => {
  let cleanup: postgres.Sql;
  let ownerId: string;
  let tripId: string;
  let runId: string;
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
      TRUNCATE TABLE users, audit_events, outbox_events, planning_research_results,
        constraint_snapshots, agent_task_runs, idempotency_records,
        chat_messages, chat_threads, provider_search_runs, provider_offers,
        trip_members, trip_search_preferences, trip_stay_search_preferences,
        shared_trips, itinerary_plans, member_confirmations, source_evidence,
        visa_readiness_checks, trip_constraint_proposals, trip_constraint_facts,
        trip_invitations, consent_grants, user_profiles, preference_facts,
        memory_proposals, plan_adoption_votes, trip_places,
        booking_executions
      RESTART IDENTITY CASCADE
    `);
    ownerId = (await db.insert(users).values({
      externalId: "phase4-stale-owner",
      displayName: "Stale Owner",
    }).returning({ id: users.id }))![0].id;
    tripId = randomUUID();
    runId = randomUUID();
    planId = randomUUID();
    const snapshotId = randomUUID();
    await db.insert(sharedTrips).values({
      id: tripId,
      name: "Stale Trip",
      nameSource: "AUTO",
      status: "PLANNING",
      createdBy: ownerId,
      departureCities: ["SF"],
      destinationCandidates: ["Tokyo"],
    });
    await db.insert(tripMembers).values({
      tripId, userId: ownerId, role: "CREATOR", isRequired: true,
    });
    await db.insert(constraintSnapshots).values({
      id: snapshotId,
      tripId,
      version: 1,
      authorizedData: { _meta: { schemaVersion: 2 } },
      departureCities: ["SF"],
      destinationCandidates: ["Tokyo"],
    });
    await db.insert(agentTaskRuns).values({
      id: runId,
      operation: "RESEARCH",
      status: "RUNNING",
      createdByUserId: ownerId,
      tripId,
      snapshotId,
      flightSearchPreferencesVersion: 1,
      requestId: randomUUID(),
      researchMode: "RESEARCH_ONLY",
      requestedCapabilities: ["activities"],
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await db.insert(itineraryPlans).values({
      id: planId,
      tripId,
      snapshotId,
      version: 1,
      status: "PROPOSED",
      planData: {},
    });
  });

  it("cancels a QUEUED RESEARCH run and marks the plan STALE in one transaction", async () => {
    await db.update(agentTaskRuns)
      .set({ status: "QUEUED", leaseToken: null, leaseExpiresAt: null })
      .where(eq(agentTaskRuns.id, runId));

    await db.transaction(async (tx) => {
      await stalePlansAndConfirmationsForTrip(tx, {
        tripId,
        reason: "consent_revoked:PROFILE_NATIONALITY",
      });
    });

    // The RESEARCH run is now STALE with errorCode STALE.
    const [run] = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, runId));
    expect(run?.status).toBe("STALE");
    expect(run?.errorCode).toBe("STALE");

    // The dependent plan is also STALE with the supplied reason.
    const [plan] = await db.select().from(itineraryPlans).where(eq(itineraryPlans.id, planId));
    expect(plan?.status).toBe("STALE");
    expect(plan?.staleReason).toBe("consent_revoked:PROFILE_NATIONALITY");
  });

  it("does not touch COMPLETED RESEARCH runs (they already wrote a summary)", async () => {
    await db.update(agentTaskRuns)
      .set({ status: "COMPLETED", finishedAt: new Date() })
      .where(eq(agentTaskRuns.id, runId));

    await db.transaction(async (tx) => {
      await stalePlansAndConfirmationsForTrip(tx, {
        tripId,
        reason: "place_adopted",
      });
    });

    const [run] = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, runId));
    expect(run?.status).toBe("COMPLETED"); // unchanged
  });

  it("is idempotent — running the cascade twice leaves STALE rows STALE", async () => {
    await db.update(agentTaskRuns)
      .set({ status: "QUEUED", leaseToken: null, leaseExpiresAt: null })
      .where(eq(agentTaskRuns.id, runId));

    await db.transaction(async (tx) => {
      await stalePlansAndConfirmationsForTrip(tx, { tripId, reason: "first" });
    });
    await db.transaction(async (tx) => {
      await stalePlansAndConfirmationsForTrip(tx, { tripId, reason: "second" });
    });

    const [run] = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, runId));
    expect(run?.status).toBe("STALE");
    // The reason is overwritten on the second pass — fine, the cascade is
    // additive on STALE.
    expect(run?.errorCode).toBe("STALE");
  });
});
