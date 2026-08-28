import { eq, and } from "drizzle-orm";
import { db } from "../db/database.js";
import {
  outboxEvents,
  sharedTrips,
  tripMembers,
  constraintSnapshots,
} from "../db/schema.js";
import { claimIdempotency } from "./idempotency-service.js";
import { createConstraintSnapshot } from "./planning-service.js";
import { acceptPlanningTask } from "../tasks/task-repository.js";
import { tripSearchPreferences } from "../db/schema.js";
import { desc } from "drizzle-orm";
import { stalePlansAndConfirmationsForTrip } from "./consent-service.js";
import { recordAudit } from "./audit-service.js";
import type { RequestContext } from "../utils/context.js";

// Drizzle's transaction callback parameter type. Aliased for readability.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Process a change event: persist a candidate/constraint diff, mark every
 * active plan stale, and trigger a replan against the persisted trip.
 *
 * Atomicity: the whole flow runs in one transaction so a crash cannot
 * leave a stale plan alongside a partial diff. Idempotency is provided by
 * `claimIdempotency`, which uses INSERT … ON CONFLICT DO NOTHING to make
 * the eventId claim race-free.
 */
export async function processChangeEvent(params: {
  ctx: RequestContext;
  tripId: string;
  eventId: string;
  eventType: "PRICE_CHANGE" | "INVENTORY_CHANGE" | "DEPARTURE_RESTRICTION";
  payload: Record<string, unknown>;
}): Promise<{
  replanned: boolean;
  runId?: string;
  newPlanId?: string;
  oldPlanId?: string;
  diff?: Record<string, unknown>;
}> {
  const actorUserId = params.ctx.actorUserId;
  if (!actorUserId) throw new Error("Change event requires an authenticated actor");
  const idempotencyKey = `change_event:${params.eventId}`;
  return await db.transaction(async (tx) => {
    const claimed = await claimIdempotency(tx, {
      key: idempotencyKey,
      entityType: "change_event",
    });
    if (!claimed) {
      return { replanned: false };
    }

    // Source of truth: persisted trip. Never hardcoded data.
    const [trip] = await tx.select().from(sharedTrips)
      .where(eq(sharedTrips.id, params.tripId))
      .limit(1);
    if (!trip) {
      throw new Error(`Trip ${params.tripId} not found`);
    }

    const departureCities = (trip.departureCities as string[]) ?? [];
    const destinationCandidates = (trip.destinationCandidates as string[]) ?? [];
    const travelDateStart = trip.travelDateStart ?? undefined;
    const travelDateEnd = trip.travelDateEnd ?? undefined;

    const members = await tx.select().from(tripMembers)
      .where(and(
        eq(tripMembers.tripId, params.tripId),
        eq(tripMembers.isRequired, true),
      ));
    const memberIds = members.map(m => m.userId);

    const previous = await getPreviousSnapshot(tx, params.tripId);
    const diff = buildChangeDiff({
      previous,
      next: { departureCities, destinationCandidates, travelDateStart, travelDateEnd },
      eventType: params.eventType,
    });

    await tx.insert(outboxEvents).values({
      eventId: params.eventId,
      eventType: params.eventType,
      payload: { ...params.payload, diff },
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
        changedFields: diff.changedFields,
      },
      tx,
    });

    const { stalePlanIds } = await stalePlansAndConfirmationsForTrip(tx, {
      tripId: params.tripId,
      reason: `change_event:${params.eventType}`,
    });

    if (destinationCandidates.length === 0) {
      await tx.update(outboxEvents)
        .set({ status: "PROCESSED", processedAt: new Date() })
        .where(eq(outboxEvents.eventId, params.eventId));
      return { replanned: false, diff, reason: "no_destination_candidates" } as never;
    }

    const newSnapshotId = await createConstraintSnapshot({
      tripId: params.tripId,
      memberIds,
      departureCities,
      destinationCandidates,
      travelDateStart,
      travelDateEnd,
    });

    const [preference] = await tx.select().from(tripSearchPreferences)
      .where(eq(tripSearchPreferences.tripId, params.tripId))
      .orderBy(desc(tripSearchPreferences.version)).limit(1);
    if (!preference) throw new Error("Confirmed flight search preferences are required for replan");
    // This is durable acceptance only.  Provider/model execution belongs to
    // the Worker after the transaction commits.
    const accepted = await acceptPlanningTask({
      ctx: params.ctx, tripId: params.tripId, userId: actorUserId,
      snapshotId: newSnapshotId, flightSearchPreferencesVersion: preference.version,
      operation: "REPLAN", requestId: params.eventId, tx,
    });

    await recordAudit({
      ctx: params.ctx,
      action: "PLAN_REPLAN",
      tripId: params.tripId,
      summary: {
        oldPlanIds: stalePlanIds,
        eventId: params.eventId,
        runId: accepted.runId,
        changedFields: diff.changedFields,
      },
      tx,
    });

    await tx.update(outboxEvents)
      .set({ status: "PROCESSED", processedAt: new Date() })
      .where(eq(outboxEvents.eventId, params.eventId));

    return {
      replanned: true,
      newPlanId: undefined,
      runId: accepted.runId,
      oldPlanId: stalePlanIds[0],
      diff,
    };
  });
}

async function getPreviousSnapshot(
  tx: Tx,
  tripId: string,
): Promise<{
  departureCities: string[];
  destinationCandidates: string[];
  travelDateStart?: string;
  travelDateEnd?: string;
} | null> {
  const rows = await tx.select()
    .from(constraintSnapshots)
    .where(eq(constraintSnapshots.tripId, tripId))
    .orderBy(constraintSnapshots.version)
    .limit(1);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    departureCities: (row.departureCities as string[]) ?? [],
    destinationCandidates: (row.destinationCandidates as string[]) ?? [],
    travelDateStart: row.travelDateStart ?? undefined,
    travelDateEnd: row.travelDateEnd ?? undefined,
  };
}

function buildChangeDiff(params: {
  previous: Awaited<ReturnType<typeof getPreviousSnapshot>>;
  next: {
    departureCities: string[];
    destinationCandidates: string[];
    travelDateStart?: string;
    travelDateEnd?: string;
  };
  eventType: string;
}): {
  prevCandidates: string[];
  nextCandidates: string[];
  prevDepartures: string[];
  nextDepartures: string[];
  prevDates: { start?: string; end?: string };
  nextDates: { start?: string; end?: string };
  changedFields: string[];
} {
  const prev = params.previous;
  const next = params.next;
  const prevCandidates = prev?.destinationCandidates ?? [];
  const nextCandidates = next.destinationCandidates;
  const prevDepartures = prev?.departureCities ?? [];
  const nextDepartures = next.departureCities;
  const prevDates = { start: prev?.travelDateStart, end: prev?.travelDateEnd };
  const nextDates = { start: next.travelDateStart, end: next.travelDateEnd };

  const changedFields: string[] = [];
  if (JSON.stringify(prevCandidates) !== JSON.stringify(nextCandidates)) changedFields.push("destinationCandidates");
  if (JSON.stringify(prevDepartures) !== JSON.stringify(nextDepartures)) changedFields.push("departureCities");
  if (prevDates.start !== nextDates.start) changedFields.push("travelDateStart");
  if (prevDates.end !== nextDates.end) changedFields.push("travelDateEnd");
  if (changedFields.length === 0) changedFields.push(params.eventType);

  return {
    prevCandidates,
    nextCandidates,
    prevDepartures,
    nextDepartures,
    prevDates,
    nextDates,
    changedFields,
  };
}
