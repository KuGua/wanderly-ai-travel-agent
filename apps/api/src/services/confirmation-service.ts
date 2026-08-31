import { eq, and } from "drizzle-orm";
import { db } from "../db/database.js";
import { memberConfirmations, tripMembers, itineraryPlans } from "../db/schema.js";
import { recordAudit } from "./audit-service.js";
import { validateSelectedFlightOffersFresh } from "./flight-offer-freshness-service.js";
import type { RequestContext } from "../utils/context.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Set a member's confirmation status for a plan. Only allowed if the plan
 * is ACTIVE and the member is required. Upsert semantics rely on the
 * `(plan_id, user_id)` UNIQUE index added in migration 0005.
 */
export async function setConfirmation(params: {
  ctx: RequestContext;
  planId: string;
  userId: string;
  tripId: string;
  decision: "CONFIRMED" | "NEEDS_CHANGES";
}): Promise<void> {
  await db.transaction(async (tx) => {
    // Verify plan is active
    const [plan] = await tx.select().from(itineraryPlans)
      .where(eq(itineraryPlans.id, params.planId))
      .limit(1);

    if (!plan) throw new Error("Plan not found");
    if (plan.status !== "ACTIVE") {
      throw new Error(`Cannot confirm plan with status ${plan.status}`);
    }

    // Spec §6.2 — confirmation is one of the two named freshness
    // checkpoints (the other is the booking sandbox). Only gate the
    // CONFIRMED decision: a member choosing NEEDS_CHANGES is not asserting
    // the offer is still bookable, and must always be able to record that.
    if (params.decision === "CONFIRMED") {
      await validateSelectedFlightOffersFresh({ ctx: params.ctx, planId: params.planId, tripId: params.tripId, tx });
    }

    // Verify user is a required member
    const [member] = await tx.select().from(tripMembers)
      .where(and(
        eq(tripMembers.tripId, params.tripId),
        eq(tripMembers.userId, params.userId),
        eq(tripMembers.isRequired, true),
      ))
      .limit(1);

    if (!member) throw new Error("User is not a required member of this trip");

    // Single statement upsert; the UNIQUE (plan_id, user_id) index from
    // migration 0005 makes this race-safe across concurrent members.
    await tx.insert(memberConfirmations)
      .values({
        planId: params.planId,
        userId: params.userId,
        tripId: params.tripId,
        status: params.decision,
        decidedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [memberConfirmations.planId, memberConfirmations.userId],
        set: {
          status: params.decision,
          decidedAt: new Date(),
        },
      });

    await recordAudit({
      ctx: params.ctx,
      action: "CONFIRMATION_SET",
      actorUserId: params.userId,
      tripId: params.tripId,
      planId: params.planId,
      summary: { decision: params.decision },
      tx,
    });
  });
}

/**
 * Check if all required members have confirmed the latest active plan.
 */
export async function checkAllConfirmed(params: {
  planId: string;
  tripId: string;
}): Promise<{ allConfirmed: boolean; confirmations: Array<{ userId: string; status: string }> }> {
  const requiredMembers = await db.select().from(tripMembers)
    .where(and(
      eq(tripMembers.tripId, params.tripId),
      eq(tripMembers.isRequired, true),
    ));

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
 * Mark all confirmations for a plan as STALE. Caller is responsible for
 * running this inside a transaction when paired with other state changes
 * that must commit atomically.
 */
export async function markConfirmationsStale(planId: string, tx?: Tx): Promise<void> {
  const target = tx ?? db;
  await target.update(memberConfirmations)
    .set({ status: "STALE" })
    .where(eq(memberConfirmations.planId, planId));
}
