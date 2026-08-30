import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";

import { runMigrations } from "../../src/db/migrate.js";
import { db } from "../../src/db/database.js";
import {
  constraintSnapshots,
  itineraryPlans,
  memberConfirmations,
  planAdoptionVotes,
  sharedTrips,
  tripMembers,
  users,
} from "../../src/db/schema.js";
import {
  PlanAdoptionServiceError,
  soloAdoptProposedPlan,
} from "../../src/services/plan-adoption-service.js";
import { createRequestContext } from "../../src/utils/context.js";

const connectionString =
  process.env.TEST_DATABASE_URL
  ?? "postgres://travelagent:travelagent@127.0.0.1:5432/travelagent?options=-csearch_path%3Dtravelagent_test";

describe("soloAdoptProposedPlan", () => {
  let cleanup: postgres.Sql;
  let ownerId: string;
  let teamOwnerId: string;
  let teamMemberId: string;
  let optionalMemberId: string;
  let soloTripId: string;
  let teamTripId: string;
  let soloPlanId: string;
  let teamPlanId: string;

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
        audit_events, outbox_events, planning_research_results,
        constraint_snapshots, agent_task_runs, idempotency_records,
        chat_messages, chat_threads, provider_search_runs, provider_offers,
        trip_members, trip_search_preferences, trip_stay_search_preferences,
        shared_trips, itinerary_plans, member_confirmations, source_evidence,
        visa_readiness_checks, trip_constraint_proposals, trip_constraint_facts,
        trip_invitations, consent_grants
      RESTART IDENTITY CASCADE
    `);
    await cleanup`DELETE FROM users`;

    // Solo owner
    ownerId = (await db.insert(users).values({
      externalId: "solo-owner",
      displayName: "Solo Owner",
    }).returning({ id: users.id }))![0].id;
    // Team owner + member
    teamOwnerId = (await db.insert(users).values({
      externalId: "team-owner",
      displayName: "Team Owner",
    }).returning({ id: users.id }))![0].id;
    teamMemberId = (await db.insert(users).values({
      externalId: "team-member",
      displayName: "Team Member",
    }).returning({ id: users.id }))![0].id;
    optionalMemberId = (await db.insert(users).values({
      externalId: "optional-member",
      displayName: "Optional Member",
    }).returning({ id: users.id }))![0].id;

    // Solo trip (1 required member).
    soloTripId = randomUUID();
    await db.insert(sharedTrips).values({
      id: soloTripId,
      name: "Solo Trip",
      nameSource: "AUTO",
      status: "PLANNING",
      createdBy: ownerId,
      departureCities: ["SF"],
      destinationCandidates: ["Tokyo"],
    });
    await db.insert(tripMembers).values({
      tripId: soloTripId, userId: ownerId, role: "CREATOR", isRequired: true,
    });

    // Team trip (2 required members).
    teamTripId = randomUUID();
    await db.insert(sharedTrips).values({
      id: teamTripId,
      name: "Team Trip",
      nameSource: "AUTO",
      status: "PLANNING",
      createdBy: teamOwnerId,
      departureCities: ["SF"],
      destinationCandidates: ["Tokyo", "Kyoto"],
    });
    for (const userId of [teamOwnerId, teamMemberId]) {
      await db.insert(tripMembers).values({
        tripId: teamTripId, userId, role: userId === teamOwnerId ? "CREATOR" : "MEMBER", isRequired: true,
      });
    }

    // One PROPOSED plan per trip — snapshot FK must exist first.
    const soloSnapshotId = randomUUID();
    await db.insert(constraintSnapshots).values({
      id: soloSnapshotId,
      tripId: soloTripId,
      version: 1,
      authorizedData: { _meta: { schemaVersion: 2 } },
      departureCities: ["SF"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: "2026-09-01",
      travelDateEnd: "2026-09-08",
    });
    const teamSnapshotId = randomUUID();
    await db.insert(constraintSnapshots).values({
      id: teamSnapshotId,
      tripId: teamTripId,
      version: 1,
      authorizedData: { _meta: { schemaVersion: 2 } },
      departureCities: ["SF"],
      destinationCandidates: ["Tokyo", "Kyoto"],
      travelDateStart: "2026-09-01",
      travelDateEnd: "2026-09-08",
    });

    soloPlanId = randomUUID();
    await db.insert(itineraryPlans).values({
      id: soloPlanId,
      tripId: soloTripId,
      snapshotId: soloSnapshotId,
      version: 1,
      status: "PROPOSED",
      planData: {},
    });
    teamPlanId = randomUUID();
    await db.insert(itineraryPlans).values({
      id: teamPlanId,
      tripId: teamTripId,
      snapshotId: teamSnapshotId,
      version: 1,
      status: "PROPOSED",
      planData: {},
    });
  });

  it("promotes a SOLO PROPOSED plan to ACTIVE in one round trip", async () => {
    const result = await soloAdoptProposedPlan({
      ctx: createRequestContext(ownerId),
      planId: soloPlanId,
      userId: ownerId,
    });
    expect(result.status).toBe("ACTIVE");
    expect(result.planId).toBe(soloPlanId);

    const [plan] = await db.select().from(itineraryPlans).where(eq(itineraryPlans.id, soloPlanId));
    expect(plan?.status).toBe("ACTIVE");

    const [vote] = await db.select().from(planAdoptionVotes)
      .where(eq(planAdoptionVotes.planId, soloPlanId));
    expect(vote?.decision).toBe("ACCEPT");

    const [conf] = await db.select().from(memberConfirmations)
      .where(eq(memberConfirmations.planId, soloPlanId));
    expect(conf?.status).toBe("CONFIRMED");
  });

  it("rejects a TEAM plan with NOT_SOLO (use the team vote route)", async () => {
    await expect(
      soloAdoptProposedPlan({
        ctx: createRequestContext(teamOwnerId),
        planId: teamPlanId,
        userId: teamOwnerId,
      }),
    ).rejects.toThrow(PlanAdoptionServiceError);
  });

  it("rejects a non-required caller with FORBIDDEN", async () => {
    // Add a separate user as a non-required member of the solo trip so the
    // required-member check actually has a non-required row to find.
    await db.insert(tripMembers).values({
      tripId: soloTripId, userId: optionalMemberId, role: "MEMBER", isRequired: false,
    });
    await expect(
      soloAdoptProposedPlan({
        ctx: createRequestContext(optionalMemberId),
        planId: soloPlanId,
        userId: optionalMemberId,
      }),
    ).rejects.toThrow(PlanAdoptionServiceError);
  });

  it("rejects a non-existent plan with PLAN_NOT_FOUND-equivalent (404 via service error)", async () => {
    await expect(
      soloAdoptProposedPlan({
        ctx: createRequestContext(ownerId),
        planId: randomUUID(),
        userId: ownerId,
      }),
    ).rejects.toThrow();
  });
});

void drizzle; // keep tree-shaker quiet