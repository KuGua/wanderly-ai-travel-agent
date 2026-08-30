/**
 * End-to-end wiring: a confirmed trip constraint becomes memory evidence.
 *
 * This is the only path that feeds `observeBehavior` in production
 * (docs/long-term-memory-implementation.md §3.2), so the tests here are about
 * what does *not* become evidence as much as what does.
 */

import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "../src/db/database.js";
import {
  agentTaskRuns,
  auditEvents,
  constraintSnapshots,
  consentGrants,
  tripSearchPreferences,
  idempotencyRecords,
  itineraryPlans,
  memoryProposals,
  outboxEvents,
  preferenceFacts,
  tripConstraintFacts,
  tripConstraintProposals,
  userProfiles,
  users,
} from "../src/db/schema.js";
import {
  confirmConstraintProposal,
  proposeConstraint,
} from "../src/services/constraint-proposal-service.js";
import { listPendingProposals } from "../src/services/memory-proposal-service.js";
import { MEMORY_OBSERVATION_EVENT_TYPE } from "../src/services/memory-observation-bridge.js";
import {
  OBSERVATION_LEASE_SECONDS,
  OBSERVATION_MAX_ATTEMPTS,
  processNextMemoryObservation,
} from "../src/workers/memory-observation-worker.js";
import { createRequestContext } from "../src/utils/context.js";
import { provisionTripAndMember } from "./helpers/trip.js";

let ownerId: string;
const trips: string[] = [];

beforeAll(async () => {
  const [created] = await db.insert(users)
    .values({ externalId: "memory-wiring-owner", displayName: "Memory Wiring Owner" })
    .onConflictDoNothing({ target: users.externalId })
    .returning();
  ownerId = created
    ? created.id
    : (await db.select().from(users)
        .where(eq(users.externalId, "memory-wiring-owner")).limit(1))[0]!.id;

  await db.insert(userProfiles)
    .values({ userId: ownerId, displayName: "Memory Wiring Owner" })
    .onConflictDoNothing({ target: userProfiles.userId });

  // Other suites confirm constraints too, and now leave observations behind.
  // Files run sequentially, so clearing the queue here makes the counts below
  // depend only on what this suite enqueued.
  await db.delete(outboxEvents)
    .where(eq(outboxEvents.eventType, MEMORY_OBSERVATION_EVENT_TYPE));
});

afterEach(async () => {
  await db.delete(memoryProposals).where(eq(memoryProposals.userId, ownerId));
  await db.delete(preferenceFacts).where(eq(preferenceFacts.userId, ownerId));
  await db.delete(auditEvents).where(eq(auditEvents.actorUserId, ownerId));
  await db.delete(idempotencyRecords)
    .where(eq(idempotencyRecords.entityType, "memory_observation"));
  await db.delete(outboxEvents)
    .where(eq(outboxEvents.eventType, MEMORY_OBSERVATION_EVENT_TYPE));
  if (trips.length > 0) {
    // Confirming a constraint now builds the next snapshot and accepts a
    // REPLAN run in the same transaction, so both have to be cleaned up or the
    // rows block other suites that truncate globally.
    await db.delete(agentTaskRuns).where(inArray(agentTaskRuns.tripId, trips));
    await db.delete(itineraryPlans).where(inArray(itineraryPlans.tripId, trips));
    await db.delete(constraintSnapshots).where(inArray(constraintSnapshots.tripId, trips));
    await db.delete(tripConstraintFacts).where(inArray(tripConstraintFacts.tripId, trips));
    await db.delete(tripConstraintProposals).where(inArray(tripConstraintProposals.tripId, trips));
    await db.delete(consentGrants).where(inArray(consentGrants.tripId, trips));
    await db.delete(tripSearchPreferences).where(inArray(tripSearchPreferences.tripId, trips));
    trips.length = 0;
  }
});

/** Proposes a constraint and confirms it, the way the agent and member do. */
async function proposeAndConfirm(input: {
  fieldKey: string;
  valueJson: unknown;
  tripId?: string;
}): Promise<string> {
  const ctx = createRequestContext(ownerId);
  let tripId = input.tripId;
  if (!tripId) {
    ({ tripId } = await provisionTripAndMember({ ownerUserId: ownerId }));
    trips.push(tripId);
    // Confirming a shared constraint now requires confirmed flight search
    // preferences and, for an agent-derived proposal, field-level consent.
    await db.insert(tripSearchPreferences).values({
      tripId, version: 1, tripType: "ROUND_TRIP", currency: "USD", adults: 1,
      cabin: "ECONOMY", offerFreshnessMinutes: 30, confirmedBy: ownerId,
    });
    await db.insert(consentGrants).values({
      tripId, userId: ownerId, scope: "PROFILE_PREFERENCES",
      fieldList: ["travel_pace", "accommodation_style", "budget_max", "interests", "no_red_eye"],
      granted: true,
    });
  }

  const { proposalId } = await proposeConstraint({
    ctx, tripId, ownerUserId: ownerId,
    envelope: {
      fieldKey: input.fieldKey,
      valueJson: input.valueJson,
      strength: "SOFT",
      proposedVisibility: "ORCHESTRATOR_CONFIDENTIAL",
      sourceKind: "PERSONAL_AGENT",
    },
    idempotencyKey: `propose-${tripId}-${input.fieldKey}-${Math.random().toString(36).slice(2)}`,
  });

  await confirmConstraintProposal({
    ctx, tripId, proposalId, ownerUserId: ownerId,
    visibility: "ORCHESTRATOR_CONFIDENTIAL",
    strength: "SOFT",
    idempotencyKey: `confirm-${proposalId}`,
  });
  return tripId;
}

/** Runs the Worker until the queue drains. */
async function drain(): Promise<void> {
  for (let guard = 0; guard < 20; guard += 1) {
    if (!await processNextMemoryObservation()) return;
  }
  throw new Error("memory observation queue did not drain");
}

const pendingCount = async () => (await db.select().from(outboxEvents).where(and(
  eq(outboxEvents.eventType, MEMORY_OBSERVATION_EVENT_TYPE),
  eq(outboxEvents.status, "PENDING"),
))).length;

describe("confirmed constraint to memory evidence", () => {
  it("queues an observation without aggregating inside the confirmation", async () => {
    await proposeAndConfirm({ fieldKey: "travel_pace", valueJson: { pace: "packed" } });

    // The confirmation the member waits on must not depend on memory, so the
    // evidence exists only as a queued row until the Worker picks it up.
    expect(await pendingCount()).toBe(1);
    expect(await listPendingProposals(ownerId)).toHaveLength(0);

    await drain();
    const proposals = await listPendingProposals(ownerId);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ fieldKey: "trip_pace", observationCount: 1 });
  });

  it("does not queue anything for a constraint memory does not model", async () => {
    await proposeAndConfirm({ fieldKey: "budget_max", valueJson: { amountUsd: 3000 } });

    // A budget is a decision, not a habit. It must not even reach the queue.
    expect(await pendingCount()).toBe(0);
  });

  it("counts the same value in the same trip only once", async () => {
    const tripId = await proposeAndConfirm({
      fieldKey: "travel_pace", valueJson: { pace: "packed" },
    });
    await drain();

    // Re-confirming in the same trip is the same episode by construction, so
    // a member cannot build a habit by toggling a setting back and forth.
    await proposeAndConfirm({ fieldKey: "travel_pace", valueJson: { pace: "packed" }, tripId });
    await drain();

    expect((await listPendingProposals(ownerId))[0].observationCount).toBe(1);
  });

  it("counts the same value in different trips separately", async () => {
    await proposeAndConfirm({ fieldKey: "travel_pace", valueJson: { pace: "packed" } });
    await proposeAndConfirm({ fieldKey: "travel_pace", valueJson: { pace: "packed" } });
    await drain();

    const [proposal] = await listPendingProposals(ownerId);
    expect(proposal.observationCount).toBe(2);
    expect(proposal.distinctTripCount).toBe(2);
  });

  it("drops a value the constraint catalog allows but memory does not", async () => {
    await proposeAndConfirm({
      fieldKey: "accommodation_style", valueJson: { style: "boutique" },
    });

    // `boutique` is a valid constraint and an invalid memory value. It has to
    // be dropped by the aggregator, not throw and strand the outbox row.
    await drain();
    expect(await listPendingProposals(ownerId)).toHaveLength(0);
    expect(await pendingCount()).toBe(0);
  });

  it("leaves no observation pending after a drain", async () => {
    await proposeAndConfirm({ fieldKey: "travel_pace", valueJson: { pace: "relaxed" } });
    await drain();
    expect(await pendingCount()).toBe(0);
  });
});

describe("failing events", () => {
  const rowsFor = async () => db.select().from(outboxEvents)
    .where(eq(outboxEvents.eventType, MEMORY_OBSERVATION_EVENT_TYPE));

  /**
   * An event that throws on every attempt. The user id is well-formed as a
   * string but not as a UUID, so the profile lookup itself errors — unlike a
   * merely-absent user, which settles normally as "nothing to attach to".
   */
  async function queuePoisonEvent() {
    await db.insert(outboxEvents).values({
      eventId: randomUUID(),
      eventType: MEMORY_OBSERVATION_EVENT_TYPE,
      payload: {
        userId: "not-a-uuid",
        tripId: "also-not-a-uuid",
        fieldKey: "trip_pace",
        value: "packed",
        episodeId: `poison-${randomUUID()}`,
        observedAt: new Date().toISOString(),
      },
    });
  }

  it("backs a failed event off instead of re-claiming it immediately", async () => {
    await proposeAndConfirm({ fieldKey: "travel_pace", valueJson: { pace: "packed" } });

    // Force a failure by pointing the row at a profile that cannot be resolved
    // and a value the aggregator will throw on.
    await db.update(outboxEvents)
      .set({ payload: { userId: "not-a-uuid", tripId: "x", fieldKey: "trip_pace",
        value: "packed", episodeId: "e", observedAt: new Date().toISOString() } })
      .where(eq(outboxEvents.eventType, MEMORY_OBSERVATION_EVENT_TYPE));

    expect(await processNextMemoryObservation()).toBe(true);

    // Without the backoff the same oldest event is claimed again on the next
    // pass, forever, blocking everything queued behind it.
    const [row] = await rowsFor();
    if (row.status === "PENDING") {
      expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
      expect(await processNextMemoryObservation()).toBe(false);
    } else {
      expect(row.status).toBe("FAILED");
    }
  });

  it("parks an event that can never succeed rather than retrying forever", async () => {
    await queuePoisonEvent();

    // Exhaust the budget, ignoring the backoff the way elapsed time would.
    for (let attempt = 0; attempt < OBSERVATION_MAX_ATTEMPTS + 1; attempt += 1) {
      await db.update(outboxEvents)
        .set({ nextAttemptAt: new Date(Date.now() - 1000) })
        .where(eq(outboxEvents.eventType, MEMORY_OBSERVATION_EVENT_TYPE));
      if (!await processNextMemoryObservation()) break;
    }

    const [row] = await rowsFor();
    // Parked, not deleted: it stays readable as a dead letter.
    expect(row.status).toBe("FAILED");
    expect(row.lastError).toBeTruthy();
  });

  it("does not let a parked event block a later observation", async () => {
    await queuePoisonEvent();
    for (let attempt = 0; attempt < OBSERVATION_MAX_ATTEMPTS + 1; attempt += 1) {
      await db.update(outboxEvents)
        .set({ nextAttemptAt: new Date(Date.now() - 1000) })
        .where(eq(outboxEvents.eventType, MEMORY_OBSERVATION_EVENT_TYPE));
      if (!await processNextMemoryObservation()) break;
    }

    await proposeAndConfirm({ fieldKey: "travel_pace", valueJson: { pace: "packed" } });
    await drain();

    expect((await listPendingProposals(ownerId))[0].observationCount).toBe(1);
  });
});

describe("claim recovery", () => {
  const claimedRows = async () => db.select().from(outboxEvents)
    .where(eq(outboxEvents.eventType, MEMORY_OBSERVATION_EVENT_TYPE));

  it("does not hand a claimed observation to a second worker", async () => {
    await proposeAndConfirm({ fieldKey: "travel_pace", valueJson: { pace: "packed" } });

    // Simulate a worker that claimed the row and is still running: a second
    // pass must find nothing rather than counting the same evidence twice.
    await db.update(outboxEvents)
      .set({ status: "PROCESSING", processedAt: new Date() })
      .where(eq(outboxEvents.eventType, MEMORY_OBSERVATION_EVENT_TYPE));

    expect(await processNextMemoryObservation()).toBe(false);
  });

  it("recovers an observation whose worker died mid-handler", async () => {
    await proposeAndConfirm({ fieldKey: "travel_pace", valueJson: { pace: "packed" } });

    // A crash leaves the row PROCESSING with a stale claim. Before PROCESSING
    // existed this event was simply lost.
    await db.update(outboxEvents)
      .set({
        status: "PROCESSING",
        processedAt: new Date(Date.now() - (OBSERVATION_LEASE_SECONDS + 60) * 1000),
      })
      .where(eq(outboxEvents.eventType, MEMORY_OBSERVATION_EVENT_TYPE));

    expect(await processNextMemoryObservation()).toBe(true);
    expect((await listPendingProposals(ownerId))[0].observationCount).toBe(1);
    expect((await claimedRows())[0].status).toBe("PROCESSED");
  });

  it("does not double-count an observation redelivered after a crash", async () => {
    await proposeAndConfirm({ fieldKey: "travel_pace", valueJson: { pace: "packed" } });
    await drain();

    // The worst case the lease allows: the handler committed the evidence and
    // then died before settling the row. Redelivery is safe only because the
    // episode id is idempotent.
    await db.update(outboxEvents)
      .set({
        status: "PROCESSING",
        processedAt: new Date(Date.now() - (OBSERVATION_LEASE_SECONDS + 60) * 1000),
      })
      .where(eq(outboxEvents.eventType, MEMORY_OBSERVATION_EVENT_TYPE));

    expect(await processNextMemoryObservation()).toBe(true);
    expect((await listPendingProposals(ownerId))[0].observationCount).toBe(1);
  });
});
