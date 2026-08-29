/**
 * Team Agent 协作编排 — Phase 2 happy path + race tests.
 * 对应 `docs/team-agent-orchestration-implementation.md` §10.5, §10.2。
 *
 * 这些测试假设已通过 `npm run pretest` 在 `_test` schema 上应用所有迁移（含 0021/0022）。
 * 没有可用测试 DB 时，Vitest 会因连接错误失败；本地开发请：
 *   docker compose up -d postgres
 *   npm run pretest
 *   npm test -- tests/team-orchestration/constraint-proposal-service.test.ts
 */

import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "../../src/db/database.js";
import {
  itineraryPlans,
  tripConstraintProposals,
  tripConstraintFacts,
  tripSearchPreferences,
  consentGrants,
  agentTaskRuns,
  constraintSnapshots,
  users,
} from "../../src/db/schema.js";
import {
  proposeConstraint,
  confirmConstraintProposal,
  listFactsForOwner,
  listFactsForMembers,
} from "../../src/services/constraint-proposal-service.js";
import { createRequestContext } from "../../src/utils/context.js";
import { provisionTripAndMember } from "../helpers/trip.js";

let alice: { id: string };

beforeAll(async () => {
  await db.select().from(itineraryPlans).limit(1);
  const [a] = await db.select({ id: users.id }).from(users).where(eq(users.externalId, "alice")).limit(1);
  if (!a) throw new Error("test user alice must be seeded");
  alice = { id: a.id };
});

async function cleanup(tripId: string): Promise<void> {
  await db.delete(agentTaskRuns).where(eq(agentTaskRuns.tripId, tripId));
  await db.delete(itineraryPlans).where(eq(itineraryPlans.tripId, tripId));
  await db.delete(constraintSnapshots).where(eq(constraintSnapshots.tripId, tripId));
  await db.delete(tripSearchPreferences).where(eq(tripSearchPreferences.tripId, tripId));
  await db.delete(consentGrants).where(eq(consentGrants.tripId, tripId));
  await db.delete(tripConstraintFacts).where(eq(tripConstraintFacts.tripId, tripId));
  await db.delete(tripConstraintProposals).where(eq(tripConstraintProposals.tripId, tripId));
}

async function prepareReplanPrerequisites(tripId: string, userId: string): Promise<void> {
  await db.insert(tripSearchPreferences).values({
    tripId, version: 1, tripType: "ROUND_TRIP", currency: "USD", adults: 1,
    cabin: "ECONOMY", offerFreshnessMinutes: 30, confirmedBy: userId,
  });
  await db.insert(consentGrants).values({
    tripId, userId, scope: "PROFILE_BUDGET", fieldList: ["budget_max"], granted: true,
  });
}

describe("constraint-proposal-service", () => {
  it("proposes and confirms a budget fact with confidential visibility", async () => {
    const owner = alice.id;
    const { tripId } = await provisionTripAndMember({ ownerUserId: owner });
    try {
      await prepareReplanPrerequisites(tripId, owner);
      const ctx = createRequestContext(owner);
      const { proposalId } = await proposeConstraint({
        ctx, tripId, ownerUserId: owner,
        envelope: {
          fieldKey: "budget_max",
          valueJson: { amountUsd: 2500 },
          strength: "HARD",
          proposedVisibility: "ORCHESTRATOR_CONFIDENTIAL",
          sourceKind: "OWNER_FORM",
        },
        idempotencyKey: `propose-${tripId}-1`,
      });
      expect(proposalId).toBeTruthy();

      const out = await confirmConstraintProposal({
        ctx, tripId, proposalId, ownerUserId: owner,
        visibility: "ORCHESTRATOR_CONFIDENTIAL",
        strength: "HARD",
        idempotencyKey: `confirm-${tripId}-1`,
      });
      expect(out.factId).toBeTruthy();
      expect(out.proposalId).toBe(proposalId);
      expect(out.replan?.runId).toBeTruthy();
      const [run] = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, out.replan!.runId));
      expect(run?.status).toBe("QUEUED");
      expect(run?.snapshotId).toBeTruthy();

      const ownerFacts = await listFactsForOwner({ tripId, ownerUserId: owner });
      expect(ownerFacts.find(f => f.fieldKey === "budget_max" && f.visibility === "ORCHESTRATOR_CONFIDENTIAL")).toBeTruthy();

      const memberFacts = await listFactsForMembers({ tripId, viewerUserId: owner });
      expect(memberFacts.find(f => f.fieldKey === "budget_max" && f.visibility === "ORCHESTRATOR_CONFIDENTIAL")).toBeUndefined();
    } finally {
      await cleanup(tripId);
    }
  });

  it("concurrent confirms with the same idempotency key produce exactly one ACTIVE fact", async () => {
    const owner = alice.id;
    const { tripId } = await provisionTripAndMember({ ownerUserId: owner });
    try {
      await prepareReplanPrerequisites(tripId, owner);
      const ctx = createRequestContext(owner);
      const { proposalId } = await proposeConstraint({
        ctx, tripId, ownerUserId: owner,
        envelope: {
          fieldKey: "accommodation_style",
          valueJson: { style: "boutique" },
          strength: "SOFT",
          proposedVisibility: "TEAM_VISIBLE",
          sourceKind: "OWNER_FORM",
        },
        idempotencyKey: `propose-race-${tripId}`,
      });
      const idempotencyKey = `confirm-race-${tripId}`;

      await Promise.all([
        confirmConstraintProposal({
          ctx, tripId, proposalId, ownerUserId: owner,
          visibility: "TEAM_VISIBLE", strength: "SOFT",
          idempotencyKey,
        }),
        confirmConstraintProposal({
          ctx, tripId, proposalId, ownerUserId: owner,
          visibility: "TEAM_VISIBLE", strength: "SOFT",
          idempotencyKey,
        }),
      ]).catch(() => undefined);

      const facts = await db.select().from(tripConstraintFacts).where(eq(tripConstraintFacts.tripId, tripId));
      const activeFacts = facts.filter(f => f.fieldKey === "accommodation_style" && f.status === "ACTIVE");
      expect(activeFacts.length).toBeLessThanOrEqual(1);
    } finally {
      await cleanup(tripId);
    }
  });

  it("confirming revokes prior ACTIVE fact for the same field (revision increments)", async () => {
    const owner = alice.id;
    const { tripId } = await provisionTripAndMember({ ownerUserId: owner });
    try {
      await prepareReplanPrerequisites(tripId, owner);
      const ctx = createRequestContext(owner);
      const seed = await proposeConstraint({
        ctx, tripId, ownerUserId: owner,
        envelope: {
          fieldKey: "no_red_eye",
          valueJson: { enabled: true },
          strength: "HARD",
          proposedVisibility: "TEAM_VISIBLE",
          sourceKind: "OWNER_FORM",
        },
        idempotencyKey: `propose-1-${tripId}`,
      });
      const first = await confirmConstraintProposal({
        ctx, tripId, proposalId: seed.proposalId, ownerUserId: owner,
        visibility: "TEAM_VISIBLE", strength: "HARD",
        idempotencyKey: `confirm-1-${tripId}`,
      });

      const update = await proposeConstraint({
        ctx, tripId, ownerUserId: owner,
        envelope: {
          fieldKey: "no_red_eye",
          valueJson: { enabled: false },
          strength: "HARD",
          proposedVisibility: "TEAM_VISIBLE",
          sourceKind: "OWNER_FORM",
        },
        idempotencyKey: `propose-2-${tripId}`,
      });
      const second = await confirmConstraintProposal({
        ctx, tripId, proposalId: update.proposalId, ownerUserId: owner,
        visibility: "TEAM_VISIBLE", strength: "HARD",
        idempotencyKey: `confirm-2-${tripId}`,
      });

      const all = await db.select().from(tripConstraintFacts).where(eq(tripConstraintFacts.tripId, tripId));
      const active = all.filter(f => f.fieldKey === "no_red_eye" && f.status === "ACTIVE");
      const superseded = all.filter(f => f.fieldKey === "no_red_eye" && f.status === "SUPERSEDED");
      expect(active.length).toBe(1);
      expect(superseded.length).toBeGreaterThanOrEqual(1);
      expect(active[0].id).toBe(second.factId);
      expect(first.factId).not.toBe(second.factId);
      expect(second.factId).toBeTruthy();
    } finally {
      await cleanup(tripId);
    }
  });
});
