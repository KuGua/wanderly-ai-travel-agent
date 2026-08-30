import { and, eq } from "drizzle-orm";

import { db } from "../db/database.js";
import { consentGrants, tripMembers } from "../db/schema.js";
import type { RequestContext } from "../utils/context.js";
import { recordAudit } from "./audit-service.js";
import { stalePlansAndConfirmationsForTrip } from "./consent-service.js";

/**
 * MemoryInvalidationService — keeps plans from outliving the memory they were
 * built on (docs/long-term-memory-implementation.md §6).
 *
 * Changing a personal fact only affects a trip that was actually allowed to see
 * it. Membership alone is not enough: without an active consent grant covering
 * that field, the trip never received the value, so nothing it planned depends
 * on it and staling would be gratuitous churn.
 *
 * Trip-scoped memory is simpler — it belongs to exactly one trip, so only that
 * trip's plans are affected.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Trips where this owner has an active consent grant covering `fieldKey`.
 *
 * A grant with an empty or absent `fieldList` covers its whole scope, so it is
 * treated as covering the field: failing open here would be a privacy leak in
 * the other direction — we would skip staling a plan that did see the value.
 */
export async function tripsDependingOnPersonalFact(
  userId: string,
  fieldKey: string,
  tx?: Tx,
): Promise<string[]> {
  const target = tx ?? db;

  const grants = await target.select({
    tripId: consentGrants.tripId,
    fieldList: consentGrants.fieldList,
  })
    .from(consentGrants)
    .innerJoin(tripMembers, and(
      eq(tripMembers.tripId, consentGrants.tripId),
      eq(tripMembers.userId, consentGrants.userId),
    ))
    .where(and(eq(consentGrants.userId, userId), eq(consentGrants.granted, true)));

  const tripIds = new Set<string>();
  for (const grant of grants) {
    const fields = grant.fieldList ?? [];
    if (fields.length === 0 || fields.includes(fieldKey)) tripIds.add(grant.tripId);
  }
  return [...tripIds];
}

/**
 * Stales every trip whose plans depended on a personal fact that just changed.
 *
 * Must run inside the same transaction as the fact mutation, so a plan can
 * never be observed as active against a value that no longer exists.
 */
export async function invalidateForPersonalFact(input: {
  ctx: RequestContext;
  tx: Tx;
  userId: string;
  fieldKey: string;
  reason: string;
}): Promise<{ staleTripIds: string[]; stalePlanIds: string[] }> {
  const tripIds = await tripsDependingOnPersonalFact(input.userId, input.fieldKey, input.tx);

  const stalePlanIds: string[] = [];
  const staleTripIds: string[] = [];
  for (const tripId of tripIds) {
    const result = await stalePlansAndConfirmationsForTrip(input.tx, {
      tripId,
      reason: input.reason,
    });
    if (result.stalePlanIds.length > 0) {
      staleTripIds.push(tripId);
      stalePlanIds.push(...result.stalePlanIds);
    }
  }

  if (stalePlanIds.length > 0) {
    await recordAudit({
      ctx: input.ctx,
      action: "MEMORY_INVALIDATION",
      actorUserId: input.userId,
      // Counts and scope only — never the field value or the trip list.
      summary: { scope: "personal_fact", count: stalePlanIds.length },
      tx: input.tx,
    });
  }

  return { staleTripIds, stalePlanIds };
}

/** Stales the one trip whose own memory just changed. */
export async function invalidateForTripMemory(input: {
  ctx: RequestContext;
  tx: Tx;
  tripId: string;
  actorUserId: string;
  reason: string;
}): Promise<{ stalePlanIds: string[] }> {
  const result = await stalePlansAndConfirmationsForTrip(input.tx, {
    tripId: input.tripId,
    reason: input.reason,
  });

  if (result.stalePlanIds.length > 0) {
    await recordAudit({
      ctx: input.ctx,
      action: "MEMORY_INVALIDATION",
      actorUserId: input.actorUserId,
      tripId: input.tripId,
      summary: { scope: "trip_memory", count: result.stalePlanIds.length },
      tx: input.tx,
    });
  }

  return result;
}
