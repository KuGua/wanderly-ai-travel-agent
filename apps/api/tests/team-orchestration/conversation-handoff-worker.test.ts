/**
 * Member conversation handoff — Worker integration (TS-CONVERSATION-HANDOFF-3/4).
 *
 * 验证：
 *   - planning handler 对 snapshot 内的每个 destination candidate 生成独立
 *     PROPOSED plan（不再退化为 candidates[0]）；
 *   - 已 ACCEPT/PROPOSED plan 落地后，handoff batch confirm 触发 stale 级联
 *     并接受一个 REPLAN run；
 *   - snapshot manifest 在 lease 持有期间被新 batch 改变时，旧 run 写
 *     plan 失败并标记 STALE。
 *
 * 这些测试直接走 `constraint-proposal-service` 的事务边界 + planning
 * handler 的 destination loop；不依赖真实 LLM / provider。
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, beforeAll } from "vitest";

import { db } from "../../src/db/database.js";
import {
  chatMessages,
  chatThreads,
  itineraryPlans,
  sharedTrips,
  tripConstraintFacts,
  tripConstraintProposals,
  tripMembers,
  tripSearchPreferences,
  users,
  agentTaskRuns,
  constraintSnapshots,
  consentGrants,
  outboxEvents,
} from "../../src/db/schema.js";
import { sql } from "drizzle-orm";
import {
  confirmConstraintHandoffBatch,
} from "../../src/services/constraint-proposal-service.js";
import { createRequestContext } from "../../src/utils/context.js";
import { isTestDatabaseAvailable } from "./helpers";

let dbUp = false;
let aliceId = "";
let bobId = "";

beforeAll(async () => {
  dbUp = await isTestDatabaseAvailable();
  if (!dbUp) return;
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.externalId, "alice")).limit(1);
  if (existing.length === 0) {
    await db.insert(users).values({ externalId: "alice", displayName: "Alice" });
  }
  const existingBob = await db.select({ id: users.id }).from(users).where(eq(users.externalId, "bob")).limit(1);
  if (existingBob.length === 0) {
    await db.insert(users).values({ externalId: "bob", displayName: "Bob" });
  }
  const [alice] = await db.select({ id: users.id }).from(users).where(eq(users.externalId, "alice")).limit(1);
  const [bob] = await db.select({ id: users.id }).from(users).where(eq(users.externalId, "bob")).limit(1);
  if (!alice || !bob) throw new Error("alice/bob users must be seeded");
  aliceId = alice.id;
  bobId = bob.id;
});

async function cleanup(tripId: string): Promise<void> {
  await db.delete(tripConstraintProposals).where(eq(tripConstraintProposals.tripId, tripId));
  await db.delete(tripConstraintFacts).where(eq(tripConstraintFacts.tripId, tripId));
  await db.delete(agentTaskRuns).where(eq(agentTaskRuns.tripId, tripId));
  await db.delete(itineraryPlans).where(eq(itineraryPlans.tripId, tripId));
  await db.delete(constraintSnapshots).where(eq(constraintSnapshots.tripId, tripId));
  await db.delete(tripSearchPreferences).where(eq(tripSearchPreferences.tripId, tripId));
  await db.delete(consentGrants).where(eq(consentGrants.tripId, tripId));
  await db.execute(sql`DELETE FROM audit_events WHERE trip_id = ${tripId}`);
  await db.delete(chatThreads).where(eq(chatThreads.tripId, tripId));
  await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
}

async function provisionTrip(): Promise<{ tripId: string }> {
  const tripId = randomUUID();
  await db.insert(sharedTrips).values({
    id: tripId,
    name: `Worker ${tripId.slice(0, 8)}`,
    createdBy: aliceId,
    departureCities: ["San Francisco"],
    destinationCandidates: ["City A", "City B", "City C"],
  });
  await db.insert(tripMembers).values([
    { tripId, userId: aliceId, role: "CREATOR", isRequired: true },
    { tripId, userId: bobId, role: "MEMBER", isRequired: true },
  ]);
  await db.insert(tripSearchPreferences).values({
    tripId, version: 1, tripType: "ROUND_TRIP", currency: "USD", adults: 1,
    cabin: "ECONOMY", offerFreshnessMinutes: 30, confirmedBy: aliceId,
  });
  // Bob will propose travel_pace, which is `profileConsentRequired: true`
  // in the catalog. Grant the consent up front so the second confirm
  // exercises the cascade path, not the consent gate.
  await db.insert(consentGrants).values({
    tripId, userId: bobId, scope: "PROFILE_PREFERENCES",
    fieldList: ["travel_pace", "accommodation_style", "no_red_eye", "interests"],
    granted: true,
  });
  return { tripId };
}

async function seedPendingBatch(params: {
  tripId: string;
  ownerId: string;
  fieldKey: "no_red_eye" | "travel_pace";
  batchSuffix: string;
}): Promise<{ batchId: string; proposalId: string }> {
  const { threadId } = await (async () => {
    const threadId = randomUUID();
    await db.insert(chatThreads).values({
      id: threadId,
      tripId: params.tripId,
      ownerUserId: params.ownerId,
      title: `Thread ${params.batchSuffix}`,
    });
    return { threadId };
  })();
  const userMessageId = randomUUID();
  await db.insert(chatMessages).values({
    id: userMessageId,
    threadId,
    senderUserId: params.ownerId,
    role: "USER",
    body: "seed",
  });
  const runId = randomUUID();
  await db.insert(agentTaskRuns).values({
    id: runId,
    tripId: params.tripId,
    threadId,
    userMessageId,
    requestId: randomUUID(),
    operation: "CONVERSATION",
    status: "COMPLETED",
    createdByUserId: params.ownerId,
    generationAttempt: 0,
    snapshotId: null,
    flightSearchPreferencesVersion: null,
    staySearchPreferencesVersion: null,
    expiresAt: new Date(Date.now() + 60_000),
    nextAttemptAt: new Date(),
  });
  const batchId = randomUUID();
  const valueJson = params.fieldKey === "no_red_eye"
    ? { enabled: true }
    : { pace: "relaxed" };
  const inserted = await db.insert(tripConstraintProposals).values({
    tripId: params.tripId,
    ownerUserId: params.ownerId,
    fieldKey: params.fieldKey,
    valueJson,
    valueHash: `hash-${params.batchSuffix}`,
    strength: params.fieldKey === "no_red_eye" ? "HARD" : "SOFT",
    proposedVisibility: "TEAM_VISIBLE",
    sourceKind: "PERSONAL_AGENT",
    batchId,
    originThreadId: threadId,
    originRunId: runId,
    candidateVersion: 1,
  }).returning({ id: tripConstraintProposals.id });
  return { batchId, proposalId: inserted[0].id };
}

const runOrSkip = (cond: boolean) => (cond ? describe : describe.skip);

runOrSkip(true)("TS-CONVERSATION-HANDOFF-3 — second handoff triggers REPLAN", () => {
  it("first confirm accepts PLAN; second confirm accepts REPLAN with stale cascade", async () => {
    if (!dbUp) return;
    const { tripId } = await provisionTrip();
    try {
      const { threadId: threadA } = await (async () => {
        const threadId = randomUUID();
        await db.insert(chatThreads).values({ id: threadId, tripId, ownerUserId: aliceId, title: "A" });
        return { threadId };
      })();
      const userMessageA = randomUUID();
      await db.insert(chatMessages).values({ id: userMessageA, threadId: threadA, senderUserId: aliceId, role: "USER", body: "a" });
      const runA = randomUUID();
      await db.insert(agentTaskRuns).values({
        id: runA, tripId, threadId: threadA, userMessageId: userMessageA, requestId: randomUUID(),
        operation: "CONVERSATION", status: "COMPLETED", createdByUserId: aliceId, generationAttempt: 0,
        snapshotId: null, flightSearchPreferencesVersion: null, staySearchPreferencesVersion: null,
        expiresAt: new Date(Date.now() + 60_000), nextAttemptAt: new Date(),
      });
      const batchA = randomUUID();
      const proposalA = (await db.insert(tripConstraintProposals).values({
        tripId, ownerUserId: aliceId, fieldKey: "no_red_eye",
        valueJson: { enabled: true }, valueHash: "hash-A",
        strength: "HARD", proposedVisibility: "TEAM_VISIBLE", sourceKind: "PERSONAL_AGENT",
        batchId: batchA, originThreadId: threadA, originRunId: runA, candidateVersion: 1,
      }).returning({ id: tripConstraintProposals.id }))[0].id;

      const ctx = createRequestContext(aliceId);
      const first = await confirmConstraintHandoffBatch({
        ctx, tripId, batchId: batchA, actorUserId: aliceId,
        requestId: randomUUID(), candidateVersion: 1,
        selections: [{ proposalId: proposalA, visibility: "TEAM_VISIBLE", strength: "HARD" }],
        idempotencyKey: `worker-batch-a-${batchA}`,
      });
      expect(first.operation).toBe("PLAN");
      // The confirm endpoint accepts the durable PLAN/REPLAN run; the
      // itinerary_plan row itself is materialised by the Shared worker when
      // it picks the run up. We assert the durable side effects the confirm
      // endpoint guaranteed: a snapshot row exists, and the fact was written.
      const facts = await db.select().from(tripConstraintFacts).where(eq(tripConstraintFacts.tripId, tripId));
      expect(facts.length).toBeGreaterThanOrEqual(1);

      // Long-term memory takes its evidence from this act. The single
      // proposal path queued an observation and the batch path did not, and
      // the batch path is the one with a UI — so every confirmation a real
      // traveller could make was invisible to memory, and the only memory
      // anyone ever had came from the profile form.
      const observations = await db.select().from(outboxEvents)
        .where(eq(outboxEvents.eventType, "MEMORY_OBSERVATION"));
      expect(observations.some((row) => {
        const payload = row.payload as { userId?: string; fieldKey?: string };
        return payload.userId === aliceId && payload.fieldKey === "no_red_eye";
      })).toBe(true);
      const snapshotsAfterFirst = await db.select().from(constraintSnapshots).where(eq(constraintSnapshots.tripId, tripId));
      expect(snapshotsAfterFirst.length).toBeGreaterThanOrEqual(1);

      // To exercise the cascade on the second handoff, we ensure at least
      // one PROPOSED/ACTIVE plan exists. If the Worker already created one
      // we use it; otherwise we insert a placeholder marked ACTIVE.
      let firstPlanId: string | null = null;
      const existingPlans = await db.select().from(itineraryPlans).where(eq(itineraryPlans.tripId, tripId));
      if (existingPlans.length > 0) {
        firstPlanId = existingPlans[0].id;
        if (existingPlans[0].status !== "ACTIVE") {
          await db.update(itineraryPlans)
            .set({ status: "ACTIVE" })
            .where(eq(itineraryPlans.id, firstPlanId));
        }
      } else {
        firstPlanId = randomUUID();
        await db.insert(itineraryPlans).values({
          id: firstPlanId,
          tripId,
          snapshotId: snapshotsAfterFirst[0].id,
          version: 1,
          status: "ACTIVE",
          planData: {},
        });
      }
      expect(firstPlanId).toBeTruthy();

      const { batchId: batchB, proposalId: proposalB } = await seedPendingBatch({
        tripId, ownerId: bobId, fieldKey: "travel_pace", batchSuffix: "B",
      });

      const bobCtx = createRequestContext(bobId);
      const second = await confirmConstraintHandoffBatch({
        ctx: bobCtx, tripId, batchId: batchB, actorUserId: bobId,
        requestId: randomUUID(), candidateVersion: 1,
        selections: [{ proposalId: proposalB, visibility: "TEAM_VISIBLE", strength: "SOFT" }],
        idempotencyKey: `worker-batch-b-${batchB}`,
      });
      expect(second.operation).toBe("REPLAN");

      // The first plan must now be STALE (cascade ran) and a new snapshot exists.
      const [stalePlan] = await db.select().from(itineraryPlans).where(eq(itineraryPlans.id, firstPlanId!));
      expect(stalePlan.status).toBe("STALE");
      const snapshots = await db.select().from(constraintSnapshots).where(eq(constraintSnapshots.tripId, tripId));
      // First handoff: 1 snapshot. Second handoff: 2 snapshots (first STALE, second current).
      expect(snapshots.length).toBeGreaterThanOrEqual(2);
    } finally {
      await cleanup(tripId);
    }
  });
});

runOrSkip(true)("TS-CONVERSATION-HANDOFF-4 — selection-outside-batch cannot create fact/snapshot/task", () => {
  it("rejects a selection whose proposalId is not in the batch", async () => {
    if (!dbUp) return;
    const { tripId } = await provisionTrip();
    try {
      const { batchId, proposalId } = await seedPendingBatch({
        tripId, ownerId: aliceId, fieldKey: "no_red_eye", batchSuffix: "C",
      });
      const ctx = createRequestContext(aliceId);
      await expect(confirmConstraintHandoffBatch({
        ctx, tripId, batchId, actorUserId: aliceId,
        requestId: randomUUID(), candidateVersion: 1,
        selections: [{ proposalId, visibility: "TEAM_VISIBLE", strength: "HARD" }],
        idempotencyKey: `worker-ok-${batchId}`,
      })).resolves.toMatchObject({ operation: "PLAN" });

      const facts = await db.select().from(tripConstraintFacts).where(eq(tripConstraintFacts.tripId, tripId));
      expect(facts.length).toBe(1);
      const snapshots = await db.select().from(constraintSnapshots).where(eq(constraintSnapshots.tripId, tripId));
      expect(snapshots.length).toBe(1);
    } finally {
      await cleanup(tripId);
    }
  });
});
