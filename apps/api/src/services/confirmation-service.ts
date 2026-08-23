import { db } from "../db/database.js";
import { memberConfirmations, tripMembers, itineraryPlans } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { recordAudit } from "./audit-service.js";
import type { RequestContext } from "../utils/context.js";

/**
 * Set a member's confirmation status for a plan.
 * Only allowed if the plan is ACTIVE and the member is required.
 */
export async function setConfirmation(params: {
  ctx: RequestContext;
  planId: string;
  userId: string;
  tripId: string;
  decision: "CONFIRMED" | "NEEDS_CHANGES";
}): Promise<void> {
  // Verify plan is active
  const [plan] = await db.select().from(itineraryPlans)
    .where(eq(itineraryPlans.id, params.planId))
    .limit(1);

  if (!plan) throw new Error("Plan not found");
  if (plan.status !== "ACTIVE") throw new Error(`Cannot confirm plan with status ${plan.status}`);

  // Verify user is a required member
  const [member] = await db.select().from(tripMembers)
    .where(and(
      eq(tripMembers.tripId, params.tripId),
      eq(tripMembers.userId, params.userId),
      eq(tripMembers.isRequired, true),
    ))
    .limit(1);

  if (!member) throw new Error("User is not a required member of this trip");

  // Upsert confirmation
  const existing = await db.select().from(memberConfirmations)
    .where(and(
      eq(memberConfirmations.planId, params.planId),
      eq(memberConfirmations.userId, params.userId),
    ))
    .limit(1);

  if (existing.length > 0) {
    await db.update(memberConfirmations)
      .set({ status: params.decision, decidedAt: new Date() })
      .where(and(
        eq(memberConfirmations.planId, params.planId),
        eq(memberConfirmations.userId, params.userId),
      ));
  } else {
    await db.insert(memberConfirmations).values({
      planId: params.planId,
      userId: params.userId,
      tripId: params.tripId,
      status: params.decision,
      decidedAt: new Date(),
    });
  }

  await recordAudit({
    ctx: params.ctx,
    action: "CONFIRMATION_SET",
    actorUserId: params.userId,
    tripId: params.tripId,
    planId: params.planId,
    summary: { decision: params.decision },
  });
}

/**
 * Check if all required members have confirmed the latest active plan.
 */
export async function checkAllConfirmed(params: {
  planId: string;
  tripId: string;
}): Promise<{ allConfirmed: boolean; confirmations: Array<{ userId: string; status: string }> }> {
  // Get all required members
  const requiredMembers = await db.select().from(tripMembers)
    .where(and(
      eq(tripMembers.tripId, params.tripId),
      eq(tripMembers.isRequired, true),
    ));

  // Get confirmations for this plan
  const confirmations = await db.select().from(memberConfirmations)
    .where(eq(memberConfirmations.planId, params.planId));

  const confirmationMap = new Map(confirmations.map(c => [c.userId, c.status]));

  const results = requiredMembers.map(m => ({
    userId: m.userId,
    status: confirmationMap.get(m.userId) ?? "PENDING",
  }));

  const allConfirmed = results.every(r => r.status === "CONFIRMED");

  return { allConfirmed, confirmations: results };
}

/**
 * Mark all confirmations for a plan as STALE.
 */
export async function markConfirmationsStale(planId: string): Promise<void> {
  await db.update(memberConfirmations)
    .set({ status: "STALE" })
    .where(eq(memberConfirmations.planId, planId));
}
