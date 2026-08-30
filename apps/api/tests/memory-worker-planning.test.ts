/**
 * The Worker's own call shape into planning.
 *
 * `planning-task-handler` does not track membership, so it passes
 * `memberIds: []`, meaning "everyone on the trip". The snapshot resolved that
 * to the real members while the commit guard hashed the empty list, so every
 * Worker-generated plan failed its own guard. Nothing caught it because every
 * existing test passed an explicit member list — the one shape the Worker never
 * uses.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";

import { db } from "../src/db/database.js";
import {
  agentTaskRuns,
  auditEvents,
  memberConfirmations,
  constraintSnapshots,
  consentGrants,
  destinationCandidates,
  itineraryPlans,
  preferenceFacts,
  sharedTrips,
  tripConstraintFacts,
  tripMembers,
  userProfiles,
  users,
} from "../src/db/schema.js";
import {
  __setPlanningDependenciesForTests,
  createConstraintSnapshot,
  generatePlan as generatePlanWithDependencies,
} from "../src/services/planning-service.js";
import { MemorySourceChangedError } from "../src/services/memory-source-fingerprint.js";
import { replaceFact } from "../src/services/preference-fact-service.js";
import { createRequestContext } from "../src/utils/context.js";
import { testPlanningDependencies } from "./helpers/planning.js";

const generatePlan = (params: Parameters<typeof generatePlanWithDependencies>[0]) =>
  generatePlanWithDependencies(params, testPlanningDependencies);

let ownerId: string;
let memberId: string;
let profileId: string;
let tripId: string;

async function ensureUser(externalId: string): Promise<string> {
  const [created] = await db.insert(users)
    .values({ externalId, displayName: externalId })
    .onConflictDoNothing({ target: users.externalId })
    .returning();
  if (created) return created.id;
  const [row] = await db.select().from(users).where(eq(users.externalId, externalId)).limit(1);
  return row!.id;
}

async function cleanup() {
  if (tripId) {
    // Audit rows reference the plan and are not all attributable to an actor,
    // so they go first and by trip.
    await db.delete(auditEvents).where(eq(auditEvents.tripId, tripId));
    await db.delete(agentTaskRuns).where(eq(agentTaskRuns.tripId, tripId));
    // Evidence and offers cascade from the plan; confirmations do too, but are
    // removed explicitly because they also key on the trip.
    await db.delete(memberConfirmations).where(eq(memberConfirmations.tripId, tripId));
    await db.delete(itineraryPlans).where(eq(itineraryPlans.tripId, tripId));
    await db.delete(destinationCandidates).where(eq(destinationCandidates.tripId, tripId));
    await db.delete(constraintSnapshots).where(eq(constraintSnapshots.tripId, tripId));
    await db.delete(tripConstraintFacts).where(eq(tripConstraintFacts.tripId, tripId));
    await db.delete(consentGrants).where(eq(consentGrants.tripId, tripId));
    await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
    await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
  }
  const ids = [ownerId, memberId].filter(Boolean);
  if (ids.length > 0) {
    await db.delete(auditEvents).where(inArray(auditEvents.actorUserId, ids));
    await db.delete(preferenceFacts).where(inArray(preferenceFacts.userId, ids));
  }
}

beforeAll(async () => {
  __setPlanningDependenciesForTests(testPlanningDependencies);
  ownerId = await ensureUser("worker-plan-owner");
  memberId = await ensureUser("worker-plan-member");
  const [profile] = await db.insert(userProfiles)
    .values({ userId: ownerId, displayName: "Owner" })
    .onConflictDoNothing({ target: userProfiles.userId })
    .returning();
  profileId = profile
    ? profile.id
    : (await db.select().from(userProfiles).where(eq(userProfiles.userId, ownerId)).limit(1))[0]!.id;
});

afterAll(cleanup);

beforeEach(async () => {
  await cleanup();
  const [trip] = await db.insert(sharedTrips).values({
    name: "Worker Planning Trip",
    createdBy: ownerId,
    departureCities: ["Shanghai"],
    destinationCandidates: ["Tokyo", "Kyoto"],
  }).returning();
  tripId = trip.id;
  await db.insert(tripMembers).values([
    { tripId, userId: ownerId, role: "CREATOR" },
    { tripId, userId: memberId, role: "MEMBER" },
  ]);
  await db.insert(consentGrants).values({
    tripId, userId: ownerId, scope: "PROFILE_PREFERENCES",
    fieldList: ["trip_pace"], granted: true,
  });
  await replaceFact({
    ctx: createRequestContext(ownerId), userId: ownerId, profileId,
    fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM",
  });
});

/** How the Worker builds a snapshot and plans from it: no member list. */
async function planTheWayTheWorkerDoes() {
  const snapshotId = await createConstraintSnapshot({
    tripId,
    memberIds: [],
    departureCities: ["Shanghai"],
    destinationCandidates: ["Tokyo"],
    travelDateStart: "2026-09-01",
    travelDateEnd: "2026-09-07",
  });
  return generatePlan({
    ctx: createRequestContext(ownerId),
    tripId,
    snapshotId,
    destination: "Tokyo",
    memberIds: [],
  });
}

describe("Worker-shaped planning", () => {
  it("commits a plan when the Worker passes no member ids", async () => {
    const planId = await planTheWayTheWorkerDoes();
    expect(planId).toEqual(expect.any(String));
  });

  it("still rejects the run when memory actually changed mid-flight", async () => {
    // The guard has to keep working for the empty list, not merely stop firing:
    // resolving members must not turn into skipping the check.
    const snapshotId = await createConstraintSnapshot({
      tripId, memberIds: [], departureCities: ["Shanghai"], destinationCandidates: ["Tokyo"],
      travelDateStart: "2026-09-01", travelDateEnd: "2026-09-07",
    });

    await replaceFact({
      ctx: createRequestContext(ownerId), userId: ownerId, profileId,
      fieldKey: "trip_pace", value: "packed", path: "PROFILE_FORM",
    });

    await expect(generatePlan({
      ctx: createRequestContext(ownerId), tripId, snapshotId,
      destination: "Tokyo", memberIds: [],
    })).rejects.toThrow(MemorySourceChangedError);
  });

  it("rejects the run when consent is revoked mid-flight", async () => {
    const snapshotId = await createConstraintSnapshot({
      tripId, memberIds: [], departureCities: ["Shanghai"], destinationCandidates: ["Tokyo"],
      travelDateStart: "2026-09-01", travelDateEnd: "2026-09-07",
    });

    await db.update(consentGrants).set({ granted: false })
      .where(eq(consentGrants.tripId, tripId));

    await expect(generatePlan({
      ctx: createRequestContext(ownerId), tripId, snapshotId,
      destination: "Tokyo", memberIds: [],
    })).rejects.toThrow(MemorySourceChangedError);
  });

  it("projects every member's memory when the Worker names none", async () => {
    const snapshotId = await createConstraintSnapshot({
      tripId, memberIds: [], departureCities: ["Shanghai"], destinationCandidates: ["Tokyo"],
      travelDateStart: "2026-09-01", travelDateEnd: "2026-09-07",
    });
    const [snapshot] = await db.select().from(constraintSnapshots)
      .where(eq(constraintSnapshots.id, snapshotId));

    // An empty list means everyone, so the projection must cover both members
    // rather than nobody.
    const meta = (snapshot.authorizedData as Record<string, unknown>)._meta as Record<string, unknown>;
    const memory = meta.memory as { members: Record<string, unknown> };
    expect(Object.keys(memory.members)).toHaveLength(2);
  });
});
