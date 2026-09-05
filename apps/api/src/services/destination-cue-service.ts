import { and, asc, desc, eq, sql } from "drizzle-orm";

import { db } from "../db/database.js";
import {
  destinationCueBatches,
  destinationCueCandidates,
  destinationCueSuppressions,
  idempotencyRecords,
  sharedTrips,
} from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";
import { destinationCueActionResponseSchema, destinationCueResponseSchema } from "../types/schemas.js";
import type { DestinationCueActionResponse, DestinationCueResponse } from "../types/schemas.js";
import type { RequestContext } from "../utils/context.js";
import type { AgentTaskRow } from "../tasks/task-repository.js";
import type { ResolvedDestinationCueDecision } from "../skills/personal/destination-cue-decision-skill.js";
import { requireOwnedTripThread, requireOwnedTripThreadRead } from "./chat-thread-service.js";
import { buildTripTitle } from "./trip-title-service.js";
import { clearTitleLabelFields } from "./trip-title-label-service.js";
import { claimIdempotency, completeIdempotency } from "./idempotency-service.js";
import { recordAudit } from "./audit-service.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const MINIMUM_REPROMPT_MS = 30 * 60 * 1000;
const SILENCE_RESET_MS = 24 * 60 * 60 * 1000;
const REQUIRED_SUBSEQUENT_MENTIONS = 2;

export function evaluateDestinationCueSuppression(input: {
  dismissedAt: Date;
  lastQualifiedMentionAt: Date;
  qualifiedMentionCount: number;
  now: Date;
}): { eligible: boolean; nextMentionCount: number; reset: boolean } {
  if (input.now.getTime() - input.lastQualifiedMentionAt.getTime() >= SILENCE_RESET_MS) {
    return { eligible: true, nextMentionCount: 0, reset: true };
  }
  const nextMentionCount = input.qualifiedMentionCount + 1;
  return {
    eligible: input.now.getTime() - input.dismissedAt.getTime() >= MINIMUM_REPROMPT_MS
      && nextMentionCount >= REQUIRED_SUBSEQUENT_MENTIONS,
    nextMentionCount,
    reset: false,
  };
}

/**
 * The same comparison the accept path uses to decide a candidate is already on
 * the trip. Shared so the two can never disagree — one deciding a name is new
 * while the other decides it is a duplicate is how a cue gets raised for a
 * destination that is then silently discarded.
 */
function isAlreadyOnTrip(destinations: string[], canonicalCityName: string): boolean {
  return destinations.some(
    (name) => name.localeCompare(canonicalCityName, undefined, { sensitivity: "accent" }) === 0,
  );
}

export async function persistDestinationCue(params: {
  run: AgentTaskRow;
  decision: ResolvedDestinationCueDecision;
  now?: Date;
}): Promise<DestinationCueResponse | null> {
  if (!params.run.threadId || !params.run.tripId) return null;
  const threadId = params.run.threadId;
  const tripId = params.run.tripId;
  const now = params.now ?? new Date();
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: destinationCueBatches.id })
      .from(destinationCueBatches)
      .where(eq(destinationCueBatches.sourceRunId, params.run.id))
      .limit(1);
    if (existing) return cueFromBatch(tx, existing.id);

    // Suppression only records a dismissal, and accepting writes none — so
    // without this a destination the traveller confirmed came straight back as
    // a question the next time the conversation mentioned it.
    const [cueTrip] = await tx.select({ destinationCandidates: sharedTrips.destinationCandidates })
      .from(sharedTrips).where(eq(sharedTrips.id, tripId)).limit(1);
    const settledDestinations = (cueTrip?.destinationCandidates as string[] | undefined) ?? [];

    const eligible: ResolvedDestinationCueDecision["candidates"] = [];
    for (const candidate of params.decision.candidates) {
      if (isAlreadyOnTrip(settledDestinations, candidate.canonicalCityName)) continue;
      const [suppression] = await tx.select().from(destinationCueSuppressions)
        .where(and(
          eq(destinationCueSuppressions.ownerUserId, params.run.createdByUserId),
          eq(destinationCueSuppressions.tripId, tripId),
          eq(destinationCueSuppressions.candidateKeyHash, candidate.candidateKeyHash),
        ))
        .for("update")
        .limit(1);
      if (!suppression) {
        eligible.push(candidate);
        continue;
      }
      const policy = evaluateDestinationCueSuppression({ ...suppression, now });
      if (policy.eligible) {
        await tx.delete(destinationCueSuppressions).where(and(
          eq(destinationCueSuppressions.ownerUserId, params.run.createdByUserId),
          eq(destinationCueSuppressions.tripId, tripId),
          eq(destinationCueSuppressions.candidateKeyHash, candidate.candidateKeyHash),
        ));
        eligible.push(candidate);
      } else {
        await tx.update(destinationCueSuppressions).set({
          qualifiedMentionCount: policy.nextMentionCount,
          lastQualifiedMentionAt: now,
          version: suppression.version + 1,
          updatedAt: now,
        }).where(and(
          eq(destinationCueSuppressions.ownerUserId, params.run.createdByUserId),
          eq(destinationCueSuppressions.tripId, tripId),
          eq(destinationCueSuppressions.candidateKeyHash, candidate.candidateKeyHash),
        ));
      }
    }
    if (eligible.length === 0) return null;

    const open = await tx.select({ id: destinationCueBatches.id })
      .from(destinationCueBatches)
      .where(and(eq(destinationCueBatches.threadId, threadId), eq(destinationCueBatches.status, "OPEN")))
      .for("update");
    for (const row of open) {
      await tx.update(destinationCueCandidates).set({ status: "SUPERSEDED", resolvedAt: now })
        .where(and(eq(destinationCueCandidates.batchId, row.id), eq(destinationCueCandidates.status, "PENDING")));
      await tx.update(destinationCueBatches).set({ status: "SUPERSEDED", updatedAt: now })
        .where(eq(destinationCueBatches.id, row.id));
    }
    const [batch] = await tx.insert(destinationCueBatches).values({
      sourceRunId: params.run.id,
      threadId,
      tripId,
      ownerUserId: params.run.createdByUserId,
      modelVersion: params.decision.modelVersion,
      promptVersion: params.decision.promptVersion,
      createdAt: now,
      updatedAt: now,
    }).returning({ id: destinationCueBatches.id });
    await tx.insert(destinationCueCandidates).values(eligible.map((candidate, ordinal) => ({
      batchId: batch.id,
      ordinal,
      canonicalCityName: candidate.canonicalCityName,
      countryCode: candidate.countryCode,
      candidateKeyHash: candidate.candidateKeyHash,
      createdAt: now,
    })));
    return cueFromBatch(tx, batch.id);
  });
}

export async function loadPendingDestinationCue(params: {
  threadId: string;
  ownerUserId: string;
}): Promise<DestinationCueResponse | null> {
  await requireOwnedTripThreadRead(params.threadId, params.ownerUserId);
  const [batch] = await db.select({ id: destinationCueBatches.id })
    .from(destinationCueBatches)
    .where(and(
      eq(destinationCueBatches.threadId, params.threadId),
      eq(destinationCueBatches.ownerUserId, params.ownerUserId),
      eq(destinationCueBatches.status, "OPEN"),
    ))
    .orderBy(desc(destinationCueBatches.createdAt))
    .limit(1);
  return batch ? cueFromBatch(db, batch.id) : null;
}

export async function actOnDestinationCue(params: {
  ctx: RequestContext;
  threadId: string;
  ownerUserId: string;
  cueId: string;
  candidateId: string;
  action: "accept" | "dismiss";
  requestId: string;
  expectedVersion: number;
  titleLocale: "en" | "zh";
}): Promise<DestinationCueActionResponse> {
  const key = `destination-cue:${params.ownerUserId}:${params.candidateId}:${params.action}:${params.requestId}`;
  return db.transaction(async (tx) => {
    const thread = await requireOwnedTripThread(tx, params.threadId, params.ownerUserId);
    const claim = await claimIdempotency(tx, { key, entityType: "destination_cue_action" });
    if (!claim) {
      const [record] = await tx.select({ resultPayload: idempotencyRecords.resultPayload })
        .from(idempotencyRecords).where(eq(idempotencyRecords.idempotencyKey, key)).limit(1);
      if (record?.resultPayload) return destinationCueActionResponseSchema.parse(record.resultPayload);
      throw new ApiError(409, "Conflict", "Destination cue action is still being processed");
    }

    const [batch] = await tx.select().from(destinationCueBatches)
      .where(eq(destinationCueBatches.id, params.cueId)).for("update").limit(1);
    if (!batch || batch.threadId !== thread.id || batch.ownerUserId !== params.ownerUserId || batch.tripId !== thread.tripId) {
      throw new ApiError(404, "Not Found", "Destination cue not found");
    }
    if (batch.status !== "OPEN" || batch.version !== params.expectedVersion) {
      throw new ApiError(409, "Conflict", "Destination cue has changed");
    }
    const [candidate] = await tx.select().from(destinationCueCandidates)
      .where(and(eq(destinationCueCandidates.id, params.candidateId), eq(destinationCueCandidates.batchId, batch.id)))
      .for("update").limit(1);
    if (!candidate || candidate.status !== "PENDING") {
      throw new ApiError(409, "Conflict", "Destination candidate has already been handled");
    }
    const [trip] = await tx.select().from(sharedTrips).where(eq(sharedTrips.id, batch.tripId)).for("update").limit(1);
    if (!trip || trip.status !== "DRAFT" || trip.createdBy !== params.ownerUserId) {
      throw new ApiError(409, "Conflict", "Destination cues are available only to the draft trip creator");
    }
    const now = new Date();
    let destinations = trip.destinationCandidates as string[];
    if (params.action === "accept") {
      if (!isAlreadyOnTrip(destinations, candidate.canonicalCityName)) {
        if (destinations.length >= 5) throw new ApiError(409, "Conflict", "Trip already has five destinations");
        destinations = [...destinations, candidate.canonicalCityName];
      }
      const title = buildTripTitle({
        destinationCandidates: destinations,
        travelDateStart: trip.travelDateStart,
        travelDateEnd: trip.travelDateEnd,
        travelDays: trip.travelDays,
        locale: params.titleLocale,
      });
      await tx.update(sharedTrips).set(clearTitleLabelFields({
        destinationCandidates: destinations,
        pendingBriefProposal: sql`case
          when ${sharedTrips.pendingBriefProposal} is null then null
          when (${sharedTrips.pendingBriefProposal} - 'destinationCandidates') = '{}'::jsonb then null
          else ${sharedTrips.pendingBriefProposal} - 'destinationCandidates'
        end`,
        ...(trip.nameSource === "AUTO" ? { name: title, titleLocale: params.titleLocale } : {}),
        updatedAt: now,
      })).where(eq(sharedTrips.id, trip.id));
    } else {
      await tx.insert(destinationCueSuppressions).values({
        ownerUserId: params.ownerUserId,
        tripId: trip.id,
        candidateKeyHash: candidate.candidateKeyHash,
        dismissedAt: now,
        lastQualifiedMentionAt: now,
        qualifiedMentionCount: 0,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [destinationCueSuppressions.ownerUserId, destinationCueSuppressions.tripId, destinationCueSuppressions.candidateKeyHash],
        set: { dismissedAt: now, lastQualifiedMentionAt: now, qualifiedMentionCount: 0, updatedAt: now, version: sql`${destinationCueSuppressions.version} + 1` },
      });
    }
    await tx.update(destinationCueCandidates).set({
      status: params.action === "accept" ? "ACCEPTED" : "DISMISSED",
      resolvedAt: now,
    }).where(eq(destinationCueCandidates.id, candidate.id));
    const [remaining] = await tx.select({ count: sql<number>`count(*)::int` }).from(destinationCueCandidates)
      .where(and(eq(destinationCueCandidates.batchId, batch.id), eq(destinationCueCandidates.status, "PENDING")));
    const nextVersion = batch.version + 1;
    await tx.update(destinationCueBatches).set({
      status: remaining.count === 0 ? "RESOLVED" : "OPEN",
      version: nextVersion,
      updatedAt: now,
    }).where(eq(destinationCueBatches.id, batch.id));

    await recordAudit({
      ctx: params.ctx,
      action: params.action === "accept" ? "DESTINATION_CUE_ACCEPT" : "DESTINATION_CUE_DISMISS",
      actorUserId: params.ownerUserId,
      tripId: trip.id,
      summary: { cueId: batch.id, candidateId: candidate.id, remaining: remaining.count },
      tx,
    });
    const cue = remaining.count > 0 ? await cueFromBatch(tx, batch.id) : null;
    const response = destinationCueActionResponseSchema.parse({
      cue,
      trip: {
        id: trip.id,
        destinationCandidates: destinations,
        updatedAt: (params.action === "accept" ? now : trip.updatedAt).toISOString(),
      },
    });
    await completeIdempotency(tx, key, "destination_cue_action", batch.id, response);
    return response;
  });
}

async function cueFromBatch(target: typeof db | Tx, batchId: string): Promise<DestinationCueResponse | null> {
  const [batch] = await target.select({ id: destinationCueBatches.id, version: destinationCueBatches.version })
    .from(destinationCueBatches)
    .where(and(eq(destinationCueBatches.id, batchId), eq(destinationCueBatches.status, "OPEN")))
    .limit(1);
  if (!batch) return null;
  const candidates = await target.select({
    id: destinationCueCandidates.id,
    displayName: destinationCueCandidates.canonicalCityName,
    status: destinationCueCandidates.status,
  }).from(destinationCueCandidates)
    .where(and(eq(destinationCueCandidates.batchId, batchId), eq(destinationCueCandidates.status, "PENDING")))
    .orderBy(asc(destinationCueCandidates.ordinal));
  if (candidates.length === 0) return null;
  return destinationCueResponseSchema.parse({ id: batch.id, version: batch.version, candidates });
}
