import { and, asc, desc, eq, gt, sql } from "drizzle-orm";

import { db } from "../db/database.js";
import {
  destinationCueBatches,
  destinationCueCandidates,
  destinationCuePromptPolicies,
  idempotencyRecords,
  sharedTrips,
} from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";
import { destinationCueActionResponseSchema, destinationCueResponseSchema } from "../types/schemas.js";
import type { DestinationCueActionResponse, DestinationCueResponse } from "../types/schemas.js";
import { getLocationReferenceResolver } from "../location-reference/location-reference-resolver.js";
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
const DAILY_DISMISSAL_LIMIT = 3;

/**
 * How often the traveller may be asked *at all*, whatever the city.
 *
 * The 30-minute cooldown a dismissal used to set lived here, keyed on
 * `(owner, trip)` — so declining Shanghai silenced Beijing too, and the next
 * city the traveller named simply never raised a card. Only an explicit
 * "把北京设为目的地" got through, which is how the suppression was noticed.
 * That cooldown now belongs to the city it was about; see
 * `citiesInDismissalCooldown`. What remains here is the daily volume guard,
 * which is about nagging and is rightly trip-wide.
 */
export function evaluateDestinationCuePromptPolicy(input: {
  dismissalDay: string | null;
  dailyDismissalCount: number;
  timeZone: string;
  now: Date;
}): { eligible: boolean; reason: "ELIGIBLE" | "DAILY_LIMIT" } {
  if (input.dismissalDay === localDayKey(input.now, input.timeZone)
    && input.dailyDismissalCount >= DAILY_DISMISSAL_LIMIT) {
    return { eligible: false, reason: "DAILY_LIMIT" };
  }
  return { eligible: true, reason: "ELIGIBLE" };
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

/** Case-insensitive, matching how `isAlreadyOnTrip` compares the same names. */
function cityCooldownKey(cityName: string): string {
  return cityName.toLocaleLowerCase();
}

/**
 * Cities this traveller declined for this trip within the last half hour.
 *
 * Read from the dismissals themselves rather than from a copy: the candidate
 * rows already record which city was declined and when, so there is no second
 * piece of state to keep in step. It mirrors how `memory_proposals` scopes its
 * own cooldown to the proposal it belongs to.
 */
async function citiesInDismissalCooldown(params: {
  tx: Tx;
  tripId: string;
  ownerUserId: string;
  now: Date;
}): Promise<Set<string>> {
  const since = new Date(params.now.getTime() - MINIMUM_REPROMPT_MS);
  const rows = await params.tx
    .select({ cityName: destinationCueCandidates.canonicalCityName })
    .from(destinationCueCandidates)
    .innerJoin(destinationCueBatches, eq(destinationCueCandidates.batchId, destinationCueBatches.id))
    .where(and(
      eq(destinationCueBatches.tripId, params.tripId),
      eq(destinationCueBatches.ownerUserId, params.ownerUserId),
      eq(destinationCueCandidates.status, "DISMISSED"),
      gt(destinationCueCandidates.resolvedAt, since),
    ));
  return new Set(rows.map((row) => cityCooldownKey(row.cityName)));
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

    const [promptPolicy] = await tx.select().from(destinationCuePromptPolicies)
      .where(and(
        eq(destinationCuePromptPolicies.ownerUserId, params.run.createdByUserId),
        eq(destinationCuePromptPolicies.tripId, tripId),
      ))
      .for("update")
      .limit(1);
    const automaticEligible = !promptPolicy || evaluateDestinationCuePromptPolicy({
      dismissalDay: promptPolicy.dismissalDay,
      dailyDismissalCount: promptPolicy.dailyDismissalCount,
      timeZone: promptPolicy.timezone,
      now,
    }).eligible;
    const cooledDown = await citiesInDismissalCooldown({
      tx, tripId, ownerUserId: params.run.createdByUserId, now,
    });
    const eligible: ResolvedDestinationCueDecision["candidates"] = [];
    for (const candidate of params.decision.candidates) {
      // An explicit command is the traveller asking for this city by name, so
      // it outranks both guards — declining a suggestion is not a standing
      // refusal to be asked again when you bring the city up yourself.
      if (candidate.intent !== "EXPLICIT_SET_DESTINATION") {
        if (!automaticEligible) continue;
        if (cooledDown.has(cityCooldownKey(candidate.canonicalCityName))) continue;
      }
      if (isAlreadyOnTrip(settledDestinations, candidate.canonicalCityName)) continue;
      eligible.push(candidate);
    }
    if (eligible.length === 0) return null;

    const open = await tx.select({ id: destinationCueBatches.id })
      .from(destinationCueBatches)
      .where(and(eq(destinationCueBatches.threadId, threadId), eq(destinationCueBatches.status, "OPEN")))
      .for("update");
    // A card for this exact canonical destination is already on screen. Do
    // not replace it just because a later user turn or the assistant's reply
    // reaches the same conclusion; the existing card remains the one action
    // surface for that entity.
    for (const row of open) {
      const pending = await tx.select({ candidateKeyHash: destinationCueCandidates.candidateKeyHash })
        .from(destinationCueCandidates)
        .where(and(
          eq(destinationCueCandidates.batchId, row.id),
          eq(destinationCueCandidates.status, "PENDING"),
        ));
      if (eligible.some((candidate) => pending.some((existingCandidate) =>
        existingCandidate.candidateKeyHash === candidate.candidateKeyHash))) {
        // The client has already restored this OPEN card; returning null also
        // prevents the worker from publishing another `cue_ready` event.
        return null;
      }
    }
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
      candidateIntent: candidate.intent,
      triggerContext: candidate.triggerContext,
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
  timeZone: string;
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
      const timeZone = normalizeTimeZone(params.timeZone);
      const dismissalDay = localDayKey(now, timeZone);
      const [policy] = await tx.select().from(destinationCuePromptPolicies)
        .where(and(
          eq(destinationCuePromptPolicies.ownerUserId, params.ownerUserId),
          eq(destinationCuePromptPolicies.tripId, trip.id),
        ))
        .for("update")
        .limit(1);
      const dailyDismissalCount = policy?.dismissalDay === dismissalDay
        ? policy.dailyDismissalCount + 1
        : 1;
      // Still recorded, no longer a gate: the cooldown that decides whether a
      // card may appear is now read per city from the dismissals themselves.
      // Kept because it is a true statement about this row and dropping a
      // column is its own migration.
      const cooldownUntil = new Date(now.getTime() + MINIMUM_REPROMPT_MS);
      const mutedUntil = dailyDismissalCount >= DAILY_DISMISSAL_LIMIT
        ? nextLocalDayStart(now, timeZone)
        : null;
      await tx.insert(destinationCuePromptPolicies).values({
        ownerUserId: params.ownerUserId,
        tripId: trip.id,
        cooldownUntil,
        dismissalDay,
        dailyDismissalCount,
        mutedUntil,
        timezone: timeZone,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [destinationCuePromptPolicies.ownerUserId, destinationCuePromptPolicies.tripId],
        set: {
          cooldownUntil,
          dismissalDay,
          dailyDismissalCount,
          mutedUntil,
          timezone: timeZone,
          updatedAt: now,
          version: sql`${destinationCuePromptPolicies.version} + 1`,
        },
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
    countryCode: destinationCueCandidates.countryCode,
    status: destinationCueCandidates.status,
    intent: destinationCueCandidates.candidateIntent,
    triggerContext: destinationCueCandidates.triggerContext,
  }).from(destinationCueCandidates)
    .where(and(eq(destinationCueCandidates.batchId, batchId), eq(destinationCueCandidates.status, "PENDING")))
    .orderBy(asc(destinationCueCandidates.ordinal));
  if (candidates.length === 0) return null;
  const resolver = getLocationReferenceResolver();
  const localizedCandidates = candidates.map(({ countryCode, ...candidate }) => {
    const labels = resolver.resolveDestinationLabels({
      cityName: candidate.displayName,
      countryHint: countryCode,
    });
    return {
      ...candidate,
      ...(labels ? { localizedNames: { en: labels.nameEn, zh: labels.nameZh } } : {}),
    };
  });
  return destinationCueResponseSchema.parse({ id: batch.id, version: batch.version, candidates: localizedCandidates });
}

function normalizeTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return value;
  } catch {
    return "UTC";
  }
}

function localParts(value: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizeTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  return Object.fromEntries(parts
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
}

function localDayKey(value: Date, timeZone: string): string {
  const parts = localParts(value, timeZone);
  return `${parts.year!.toString().padStart(4, "0")}-${parts.month!.toString().padStart(2, "0")}-${parts.day!.toString().padStart(2, "0")}`;
}

function timeZoneOffsetMs(value: Date, timeZone: string): number {
  const parts = localParts(value, timeZone);
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!)
    - value.getTime();
}

function nextLocalDayStart(value: Date, timeZone: string): Date {
  const parts = localParts(value, timeZone);
  const nextDayWallClock = Date.UTC(parts.year!, parts.month! - 1, parts.day! + 1);
  let result = new Date(nextDayWallClock - timeZoneOffsetMs(new Date(nextDayWallClock), timeZone));
  result = new Date(nextDayWallClock - timeZoneOffsetMs(result, timeZone));
  return result;
}
