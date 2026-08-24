import { db } from "../db/database.js";
import { outboxEvents, tripMembers } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { checkIdempotency, recordIdempotency } from "./idempotency-service.js";
import { markPlanStale, getLatestActivePlan, createConstraintSnapshot, generatePlan } from "./planning-service.js";
import { markConfirmationsStale } from "./confirmation-service.js";
import { recordAudit } from "./audit-service.js";
import type { RequestContext } from "../utils/context.js";

/**
 * Process a change event: mark current plan stale, trigger replan.
 * Idempotent by eventId.
 */
export async function processChangeEvent(params: {
  ctx: RequestContext;
  tripId: string;
  eventId: string;
  eventType: "PRICE_CHANGE" | "INVENTORY_CHANGE" | "DEPARTURE_RESTRICTION";
  payload: Record<string, unknown>;
}): Promise<{ replanned: boolean; newPlanId?: string; diff?: Record<string, unknown> }> {
  // Check idempotency
  const idempotencyKey = `change_event:${params.eventId}`;
  const existing = await checkIdempotency(idempotencyKey);
  if (existing.exists) {
    return { replanned: false };
  }

  // Record outbox event
  await db.insert(outboxEvents).values({
    eventId: params.eventId,
    eventType: params.eventType,
    payload: params.payload,
    status: "PENDING",
  });

  await recordAudit({
    ctx: params.ctx,
    action: "CHANGE_EVENT",
    tripId: params.tripId,
    summary: {
      eventId: params.eventId,
      eventType: params.eventType,
      hasEventData: Object.keys(params.payload).length > 0,
    },
  });

  // Get latest active plan
  const latestPlan = await getLatestActivePlan(params.tripId);
  if (!latestPlan) {
    // No active plan to stale
    await recordIdempotency({
      key: idempotencyKey,
      entityType: "change_event",
      resultPayload: { replanned: false, reason: "no_active_plan" },
    });
    return { replanned: false };
  }

  // Mark current plan as STALE
  await markPlanStale({
    ctx: params.ctx,
    planId: latestPlan.id,
    reason: `Change event: ${params.eventType}`,
  });

  // Mark all confirmations for this plan as STALE
  await markConfirmationsStale(latestPlan.id);

  // Trigger replan: create new snapshot and generate new plan
  // Get trip members
  const members = await db.select().from(tripMembers)
    .where(and(eq(tripMembers.tripId, params.tripId), eq(tripMembers.isRequired, true)));

  // Get trip details (simplified — in production, fetch from sharedTrips table)
  // For demo, we'll use a fixed destination
  const destination = "Tokyo"; // Simplified for demo

  const newSnapshotId = await createConstraintSnapshot({
    tripId: params.tripId,
    memberIds: members.map(m => m.userId),
    departureCities: ["San Francisco", "Shanghai"], // Simplified
    destinationCandidates: [destination],
    travelDateStart: "2025-08-01",
    travelDateEnd: "2025-08-07",
  });

  const newPlanId = await generatePlan({
    ctx: params.ctx,
    tripId: params.tripId,
    snapshotId: newSnapshotId,
    destination,
    memberIds: members.map(m => m.userId),
  });

  await recordAudit({
    ctx: params.ctx,
    action: "PLAN_REPLAN",
    tripId: params.tripId,
    planId: newPlanId,
    summary: { oldPlanId: latestPlan.id, eventId: params.eventId },
  });

  const result = { replanned: true, newPlanId, oldPlanId: latestPlan.id };

  await recordIdempotency({
    key: idempotencyKey,
    entityType: "change_event",
    resultPayload: result as unknown as Record<string, unknown>,
  });

  // Update outbox event status
  await db.update(outboxEvents)
    .set({ status: "PROCESSED", processedAt: new Date() })
    .where(eq(outboxEvents.eventId, params.eventId));

  return result;
}
