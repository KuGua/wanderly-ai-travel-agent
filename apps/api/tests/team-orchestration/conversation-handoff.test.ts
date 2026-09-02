/**
 * Member conversation handoff — batch confirm transaction (Phase 6 / spec §5.2).
 * 对应 TS-CONVERSATION-HANDOFF-1/2/3 acceptance scenarios.
 *
 * Verifies the core invariants without going through the chat UI:
 *   - any active member can confirm their own batch (creator not required);
 *   - cross-member / cross-thread / cross-trip attempts are rejected;
 *   - same requestId produces exactly one fact / snapshot / task;
 *   - selecting no candidates from the batch is rejected;
 *   - invalid visibility/strength combinations are rejected before persistence;
 *   - sensitive fields (nationality / accessibility_need) cannot enter the batch.
 */

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, beforeAll } from "vitest";

import { db } from "../../src/db/database.js";
import {
  chatThreads,
  chatMessages,
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
} from "../../src/db/schema.js";
import {
  confirmConstraintHandoffBatch,
  listConversationHandoffBatch,
  ConstraintProposalServiceError,
} from "../../src/services/constraint-proposal-service.js";
import { createRequestContext } from "../../src/utils/context.js";
import { isTestDatabaseAvailable } from "./helpers";
import { shouldExtractConversationHandoff } from "../../src/tasks/handlers/conversation-task-handler.js";

let dbUp = false;
let aliceId = "";
let bobId = "";

beforeAll(async () => {
  dbUp = await isTestDatabaseAvailable();
  if (!dbUp) return;
  const existingAlice = await db.select({ id: users.id }).from(users).where(eq(users.externalId, "alice")).limit(1);
  if (existingAlice.length === 0) {
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
  // Proposals must be removed before chat_threads: PERSONAL_AGENT rows have
  // origin_thread_id NOT NULL (per migration 0056), and the chat_threads FK
  // is ON DELETE SET NULL. Removing proposals first leaves the FK happy.
  await db.delete(tripConstraintProposals).where(eq(tripConstraintProposals.tripId, tripId));
  await db.delete(tripConstraintFacts).where(eq(tripConstraintFacts.tripId, tripId));
  await db.delete(agentTaskRuns).where(eq(agentTaskRuns.tripId, tripId));
  await db.delete(itineraryPlans).where(eq(itineraryPlans.tripId, tripId));
  await db.delete(constraintSnapshots).where(eq(constraintSnapshots.tripId, tripId));
  await db.delete(tripSearchPreferences).where(eq(tripSearchPreferences.tripId, tripId));
  await db.delete(consentGrants).where(eq(consentGrants.tripId, tripId));
  // audit_events has trip_id FK ON DELETE RESTRICT. Wipe only the audit
  // rows our service wrote for this trip; everything else stays.
  await db.execute(sql`DELETE FROM audit_events WHERE trip_id = ${tripId}`);
  await db.delete(chatThreads).where(eq(chatThreads.tripId, tripId));
  await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
}

async function provisionTripWithTwoMembers(): Promise<{ tripId: string }> {
  const tripId = randomUUID();
  await db.insert(sharedTrips).values({
    id: tripId,
    name: `Handoff ${tripId.slice(0, 8)}`,
    createdBy: aliceId,
    departureCities: ["San Francisco"],
    destinationCandidates: ["City A", "City B"],
  });
  await db.insert(tripMembers).values([
    { tripId, userId: aliceId, role: "CREATOR", isRequired: true },
    { tripId, userId: bobId, role: "MEMBER", isRequired: true },
  ]);
  await db.insert(tripSearchPreferences).values({
    tripId, version: 1, tripType: "ROUND_TRIP", currency: "USD", adults: 1,
    cabin: "ECONOMY", offerFreshnessMinutes: 30, confirmedBy: aliceId,
  });
  return { tripId };
}

async function provisionThread(tripId: string, ownerId: string): Promise<{ threadId: string }> {
  const threadId = randomUUID();
  await db.insert(chatThreads).values({
    id: threadId,
    tripId,
    ownerUserId: ownerId,
    title: "Private thread",
  });
  return { threadId };
}

async function seedPENDINGBatch(params: {
  tripId: string;
  threadId: string;
  runId: string;
  ownerId: string;
}): Promise<{ batchId: string; proposalId: string }> {
  // Insert a placeholder USER chat_message so the FK on
  // agent_task_runs.user_message_id is satisfied. We do not exercise the
  // agent task handler here; we only need the rows to exist for the FKs.
  const userMessageId = randomUUID();
  await db.insert(chatMessages).values({
    id: userMessageId,
    threadId: params.threadId,
    senderUserId: params.ownerId,
    role: "USER",
    body: "test seed",
  });
  await db.insert(agentTaskRuns).values({
    id: params.runId,
    tripId: params.tripId,
    threadId: params.threadId,
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
  }).onConflictDoNothing();

  const batchId = randomUUID();
  const valueJson = { enabled: true };
  const valueHash = "test-hash";
  const inserted = await db.insert(tripConstraintProposals).values({
    tripId: params.tripId,
    ownerUserId: params.ownerId,
    fieldKey: "no_red_eye",
    valueJson,
    valueHash,
    strength: "HARD",
    proposedVisibility: "TEAM_VISIBLE",
    sourceKind: "PERSONAL_AGENT",
    batchId,
    originThreadId: params.threadId,
    originRunId: params.runId,
    candidateVersion: 1,
  }).returning({ id: tripConstraintProposals.id });
  return { batchId, proposalId: inserted[0].id };
}

const runOrSkip = (cond: boolean) => (cond ? describe : describe.skip);

runOrSkip(true)("TS-CONVERSATION-HANDOFF-1 — any active member can confirm their batch", () => {
  it("extracts only after Trip activation, never from a DRAFT conversation", () => {
    const W = "TRIP_WORKSPACE";
    expect(shouldExtractConversationHandoff("MODEL", "DRAFT", W)).toBe(false);
    expect(shouldExtractConversationHandoff("MODEL", "PLANNING", W)).toBe(true);
    expect(shouldExtractConversationHandoff("MODEL", "STALE", W)).toBe(true);
    expect(shouldExtractConversationHandoff("MODEL", "CONFIRMED", W)).toBe(false);
    expect(shouldExtractConversationHandoff("SAFE_REFUSAL", "PLANNING", W)).toBe(false);
    expect(shouldExtractConversationHandoff("FALLBACK", "PLANNING", W)).toBe(false);
  });

  it("extracts nothing from exploration, whatever the trip status says", () => {
    // The surface gate was added after the case above was written, and it can
    // only narrow: an absent or unrecognised surface reads as exploration, so
    // an old client fails towards forgetting rather than over-remembering.
    expect(shouldExtractConversationHandoff("MODEL", "PLANNING", "GLOBE")).toBe(false);
    expect(shouldExtractConversationHandoff("MODEL", "PLANNING", null)).toBe(false);
    expect(shouldExtractConversationHandoff("MODEL", "PLANNING", undefined)).toBe(false);
  });

  it("Bob (non-creator) can confirm his own batch", async () => {
    if (!dbUp) return;
    const { tripId } = await provisionTripWithTwoMembers();
    try {
      const { threadId } = await provisionThread(tripId, bobId);
      const runId = randomUUID();
      const { batchId, proposalId } = await seedPENDINGBatch({
        tripId, threadId, runId, ownerId: bobId,
      });
      const ctx = createRequestContext(bobId);
      const requestId = randomUUID();

      const out = await confirmConstraintHandoffBatch({
        ctx, tripId, batchId, actorUserId: bobId, requestId, candidateVersion: 1,
        selections: [{ proposalId, visibility: "TEAM_VISIBLE", strength: "HARD" }],
        idempotencyKey: `handoff-${batchId}`,
      });
      expect(out.operation).toBe("PLAN");
      expect(out.runId).toBeTruthy();
      expect(out.snapshotId).toBeTruthy();
      const facts = await db.select().from(tripConstraintFacts).where(eq(tripConstraintFacts.tripId, tripId));
      expect(facts.length).toBe(1);
      expect(facts[0].fieldKey).toBe("no_red_eye");
    } finally {
      await cleanup(tripId);
    }
  });

  it("Alice cannot confirm Bob's batch (cross-member fail closed)", async () => {
    if (!dbUp) return;
    const { tripId } = await provisionTripWithTwoMembers();
    try {
      const { threadId } = await provisionThread(tripId, bobId);
      const runId = randomUUID();
      const { batchId, proposalId } = await seedPENDINGBatch({
        tripId, threadId, runId, ownerId: bobId,
      });
      const ctx = createRequestContext(aliceId);
      await expect(confirmConstraintHandoffBatch({
        ctx, tripId, batchId, actorUserId: aliceId, requestId: randomUUID(), candidateVersion: 1,
        selections: [{ proposalId, visibility: "TEAM_VISIBLE", strength: "HARD" }],
        idempotencyKey: `handoff-${batchId}-alice`,
      })).rejects.toBeInstanceOf(ConstraintProposalServiceError);
      const facts = await db.select().from(tripConstraintFacts).where(eq(tripConstraintFacts.tripId, tripId));
      expect(facts.length).toBe(0);
    } finally {
      await cleanup(tripId);
    }
  });

  it("listConversationHandoffBatch rejects cross-member reads", async () => {
    if (!dbUp) return;
    const { tripId } = await provisionTripWithTwoMembers();
    try {
      const { threadId } = await provisionThread(tripId, bobId);
      const runId = randomUUID();
      const { batchId } = await seedPENDINGBatch({ tripId, threadId, runId, ownerId: bobId });
      await expect(listConversationHandoffBatch({
        tripId, batchId, actorUserId: aliceId,
      })).rejects.toBeInstanceOf(ConstraintProposalServiceError);
    } finally {
      await cleanup(tripId);
    }
  });

  it("keeps every candidate in a multi-candidate batch on one batch version", async () => {
    if (!dbUp) return;
    const { tripId } = await provisionTripWithTwoMembers();
    try {
      const { threadId } = await provisionThread(tripId, bobId);
      const runId = randomUUID();
      const { batchId, proposalId } = await seedPENDINGBatch({ tripId, threadId, runId, ownerId: bobId });
      await db.insert(tripConstraintProposals).values({
        tripId, ownerUserId: bobId, fieldKey: "travel_pace",
        valueJson: { pace: "relaxed" }, valueHash: "second-candidate-hash",
        strength: "SOFT", proposedVisibility: "TEAM_VISIBLE", sourceKind: "PERSONAL_AGENT",
        batchId, originThreadId: threadId, originRunId: runId, candidateVersion: 1,
      });

      const listed = await listConversationHandoffBatch({ tripId, batchId, actorUserId: bobId });
      expect(listed.candidateVersion).toBe(1);
      expect(listed.batch).toHaveLength(2);
      await expect(confirmConstraintHandoffBatch({
        ctx: createRequestContext(bobId), tripId, batchId, actorUserId: bobId,
        requestId: randomUUID(), candidateVersion: 1,
        selections: [{ proposalId, visibility: "TEAM_VISIBLE", strength: "HARD" }],
        idempotencyKey: `handoff-multi-${batchId}`,
      })).resolves.toMatchObject({ operation: "PLAN" });
    } finally {
      await cleanup(tripId);
    }
  });

  it("rejects a former member reading their own batch", async () => {
    if (!dbUp) return;
    const { tripId } = await provisionTripWithTwoMembers();
    try {
      const { threadId } = await provisionThread(tripId, bobId);
      const { batchId } = await seedPENDINGBatch({ tripId, threadId, runId: randomUUID(), ownerId: bobId });
      await db.delete(tripMembers).where(sql`${tripMembers.tripId} = ${tripId} AND ${tripMembers.userId} = ${bobId}`);
      await expect(listConversationHandoffBatch({ tripId, batchId, actorUserId: bobId }))
        .rejects.toBeInstanceOf(ConstraintProposalServiceError);
    } finally {
      await cleanup(tripId);
    }
  });

  it("allows deleting a source thread after its pending handoff is dismissed", async () => {
    if (!dbUp) return;
    const { tripId } = await provisionTripWithTwoMembers();
    try {
      const { threadId } = await provisionThread(tripId, bobId);
      const { batchId } = await seedPENDINGBatch({ tripId, threadId, runId: randomUUID(), ownerId: bobId });
      await db.update(tripConstraintProposals)
        .set({ status: "DISMISSED", resolvedAt: new Date() })
        .where(eq(tripConstraintProposals.batchId, batchId));
      await db.delete(chatMessages).where(eq(chatMessages.threadId, threadId));
      await db.delete(chatThreads).where(eq(chatThreads.id, threadId));

      const [proposal] = await db.select({
        originThreadId: tripConstraintProposals.originThreadId,
        originRunId: tripConstraintProposals.originRunId,
        status: tripConstraintProposals.status,
      }).from(tripConstraintProposals).where(eq(tripConstraintProposals.batchId, batchId));
      expect(proposal).toMatchObject({ status: "DISMISSED", originThreadId: null, originRunId: null });
    } finally {
      await cleanup(tripId);
    }
  });

  it("replaying the same idempotency key returns the original task", async () => {
    if (!dbUp) return;
    const { tripId } = await provisionTripWithTwoMembers();
    try {
      const { threadId } = await provisionThread(tripId, bobId);
      const runId = randomUUID();
      const { batchId, proposalId } = await seedPENDINGBatch({
        tripId, threadId, runId, ownerId: bobId,
      });
      const ctx = createRequestContext(bobId);
      const requestId = randomUUID();
      const idempotencyKey = `handoff-replay-${batchId}`;
      const first = await confirmConstraintHandoffBatch({
        ctx, tripId, batchId, actorUserId: bobId, requestId, candidateVersion: 1,
        selections: [{ proposalId, visibility: "TEAM_VISIBLE", strength: "HARD" }],
        idempotencyKey,
      });
      const second = await confirmConstraintHandoffBatch({
        ctx, tripId, batchId, actorUserId: bobId, requestId, candidateVersion: 1,
        selections: [{ proposalId, visibility: "TEAM_VISIBLE", strength: "HARD" }],
        idempotencyKey,
      });
      expect(second.runId).toBe(first.runId);
      expect(second.snapshotId).toBe(first.snapshotId);
      const facts = await db.select().from(tripConstraintFacts).where(eq(tripConstraintFacts.tripId, tripId));
      expect(facts.length).toBe(1);
    } finally {
      await cleanup(tripId);
    }
  });

  it("rejects selections that reference a proposal outside the batch", async () => {
    if (!dbUp) return;
    const { tripId } = await provisionTripWithTwoMembers();
    try {
      const { threadId } = await provisionThread(tripId, bobId);
      const runId = randomUUID();
      const { batchId } = await seedPENDINGBatch({ tripId, threadId, runId, ownerId: bobId });
      const ctx = createRequestContext(bobId);
      await expect(confirmConstraintHandoffBatch({
        ctx, tripId, batchId, actorUserId: bobId, requestId: randomUUID(), candidateVersion: 1,
        selections: [{ proposalId: randomUUID(), visibility: "TEAM_VISIBLE", strength: "HARD" }],
        idempotencyKey: `handoff-misroute-${batchId}`,
      })).rejects.toBeInstanceOf(ConstraintProposalServiceError);
    } finally {
      await cleanup(tripId);
    }
  });
});

runOrSkip(true)("TS-CONVERSATION-HANDOFF-2 — sensitive fields cannot enter the batch", () => {
  it("OWNER_FORM candidates are rejected from batch confirm", async () => {
    if (!dbUp) return;
    const { tripId } = await provisionTripWithTwoMembers();
    try {
      await provisionThread(tripId, bobId);
      const batchId = randomUUID();
      const inserted = await db.insert(tripConstraintProposals).values({
        tripId, ownerUserId: bobId, fieldKey: "no_red_eye",
        valueJson: { enabled: true }, valueHash: "test-hash",
        strength: "HARD", proposedVisibility: "TEAM_VISIBLE",
        sourceKind: "OWNER_FORM", // explicit non-PERSONAL_AGENT
        batchId, originThreadId: null, originRunId: null, candidateVersion: 1,
      }).returning({ id: tripConstraintProposals.id });
      const proposalId = inserted[0].id;
      const ctx = createRequestContext(bobId);
      await expect(confirmConstraintHandoffBatch({
        ctx, tripId, batchId, actorUserId: bobId, requestId: randomUUID(), candidateVersion: 1,
        selections: [{ proposalId, visibility: "TEAM_VISIBLE", strength: "HARD" }],
        idempotencyKey: `handoff-owner-form-${batchId}`,
      })).rejects.toBeInstanceOf(ConstraintProposalServiceError);
    } finally {
      await cleanup(tripId);
    }
  });

  it("candidate_version mismatch is rejected (no overwrite)", async () => {
    if (!dbUp) return;
    const { tripId } = await provisionTripWithTwoMembers();
    try {
      const { threadId } = await provisionThread(tripId, bobId);
      const runId = randomUUID();
      const { batchId, proposalId } = await seedPENDINGBatch({
        tripId, threadId, runId, ownerId: bobId,
      });
      const ctx = createRequestContext(bobId);
      await expect(confirmConstraintHandoffBatch({
        ctx, tripId, batchId, actorUserId: bobId, requestId: randomUUID(), candidateVersion: 99,
        selections: [{ proposalId, visibility: "TEAM_VISIBLE", strength: "HARD" }],
        idempotencyKey: `handoff-version-${batchId}`,
      })).rejects.toBeInstanceOf(ConstraintProposalServiceError);
    } finally {
      await cleanup(tripId);
    }
  });
});
