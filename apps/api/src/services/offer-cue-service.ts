/**
 * Flight / Hotel Offer Cue state machine (docs/flight-offer-cue-model-draft.md,
 * docs/hotel-offer-cue-model-draft.md).
 *
 * Personal-only. Never writes shared_trips.constraint_snapshot, never grants
 * booking authority, never wakes the Shared agent. Phase 1 strictly DRAFT
 * Trip creator's private thread — `actOnOfferCueCandidate` enforces this
 * with `OFFER_CUE_TRIP_STATE_INCOMPATIBLE` (409).
 *
 * Capability scoping: every state machine key includes capability so Flight
 * and Hotel count prompt fatigue independently and may each carry one OPEN
 * batch simultaneously. The result-card "Select this flight / hotel" button
 * bypasses the LLM but routes through `actOnOfferCueCandidate` with
 * `source: 'RESULT_CARD_BUTTON'`.
 */

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../db/database.js";
import {
  offerCueBatches,
  offerCueCandidates,
  offerCuePromptPolicies,
  offerCueCapabilityEnum,
  personalResearchOfferCandidates,
  sharedTrips,
} from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";
import {
  offerCueActionResponseSchema,
  offerCueResponseSchema,
} from "../types/schemas.js";
import type {
  OfferCueActionResponse,
  OfferCueResponse,
  OfferCueReasonCode,
} from "../types/schemas.js";
import type { RequestContext } from "../utils/context.js";
import type { AgentTaskRow } from "../tasks/task-repository.js";
import { requireOwnedTripThread, requireOwnedTripThreadRead } from "./chat-thread-service.js";
import { claimIdempotency, completeIdempotency } from "./idempotency-service.js";
import { idempotencyRecords } from "../db/schema.js";
import { recordAudit } from "./audit-service.js";
import { listPersonalOfferSelectionsForTrip, createPersonalOfferSelection, supersedeScopeSelections, type PersonalOfferSelectionCreated } from "./personal-offer-selection-service.js";
import { incrementOfferCueMetrics } from "../observability/metrics-counters.js";
import { logSafeRuntimeEvent } from "../observability/telemetry.js";
import {
  OFFER_CUE_COOLDOWN_MS,
  OFFER_CUE_DAILY_DISMISSAL_LIMIT,
  evaluateOfferCuePromptPolicy,
  localDayKey,
  nextLocalDayStart,
  normalizeTimeZone,
} from "./offer-cue-prompt-policy.js";

export { evaluateOfferCuePromptPolicy };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const CANDIDATE_EXPIRY_SAFETY_MS = 5_000;

export type OfferCueCapability = "flight" | "hotel";

export interface ResolvedOfferCueCandidate {
  ordinal: number;
  candidateRef: string;
  intent: "EXPLICIT_SELECT" | "STRONG_PREFERENCE";
  routeKey: string | null;
  stayKey: string | null;
}

export interface ResolvedOfferCueDecision {
  capability: OfferCueCapability;
  candidates: ResolvedOfferCueCandidate[];
  reasonCode: OfferCueReasonCode;
  modelVersion: string;
  promptVersion: string;
}

export interface ResolvedOfferCueOutcome {
  cue: OfferCueResponse;
}

/**
 * Persist a new Offer Cue batch derived from the resolver decision.
 *
 * Single transaction:
 *   - dedup by `source_run_id UNIQUE` (a retried run lands on the same batch)
 *   - lock `offer_cue_prompt_policies` FOR UPDATE so dismiss bookkeeping is
 *     serialised with `actOnOfferCueCandidate`
 *   - drop candidates whose personal_research_offer_candidates row is
 *     missing, expired, or whose visible_before_message_sequence is >=
 *     currentUserMessageSequence (the user has not actually seen the offer)
 *   - drop a second candidate sharing routeKey / stayKey inside the same
 *     batch (same-leg / same-stay mutual exclusion)
 *   - supersede any OPEN batch for the same (thread, capability)
 *
 * Returns the cue payload (with the post-filter candidate set) or null when
 * the resolver decision produced no eligible candidates.
 */
export async function persistOfferCue(params: {
  ctx: RequestContext;
  run: AgentTaskRow;
  decision: ResolvedOfferCueDecision;
  currentUserMessageSequence: number;
  capability: OfferCueCapability;
  now?: Date;
}): Promise<ResolvedOfferCueOutcome | null> {
  if (!params.run.threadId || !params.run.tripId) return null;
  const threadId = params.run.threadId;
  const tripId = params.run.tripId;
  const capability = params.decision.capability;
  const now = params.now ?? new Date();

  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: offerCueBatches.id })
      .from(offerCueBatches)
      .where(eq(offerCueBatches.sourceRunId, params.run.id))
      .limit(1);
    if (existing) {
      const cue = await cueFromBatch(tx, existing.id);
      if (!cue) return null;
      return { cue };
    }

    // Lock the prompt policy row even when we may not write it: keeps the
    // accept/dismiss path serialised with persist so an in-flight dismiss
    // can't change eligibility mid-flight.
    await tx.select().from(offerCuePromptPolicies).where(and(
      eq(offerCuePromptPolicies.ownerUserId, params.run.createdByUserId),
      eq(offerCuePromptPolicies.tripId, tripId),
      eq(offerCuePromptPolicies.capability, capability),
    )).for("update").limit(1);

    const refs = params.decision.candidates.map((c) => c.candidateRef);
    let candidateRows: Array<{
      id: string;
      ordinal: number;
      routeKey: string | null;
      stayKey: string | null;
      expiresAt: Date;
      visibleBeforeMessageSequence: number;
    }> = [];
    if (refs.length > 0) {
      candidateRows = await tx.select({
        id: personalResearchOfferCandidates.id,
        ordinal: personalResearchOfferCandidates.ordinal,
        routeKey: personalResearchOfferCandidates.routeKey,
        stayKey: personalResearchOfferCandidates.stayKey,
        expiresAt: personalResearchOfferCandidates.expiresAt,
        visibleBeforeMessageSequence: personalResearchOfferCandidates.visibleBeforeMessageSequence,
      }).from(personalResearchOfferCandidates)
        .where(and(
          inArray(personalResearchOfferCandidates.id, refs),
          eq(personalResearchOfferCandidates.threadId, threadId),
          eq(personalResearchOfferCandidates.ownerUserId, params.run.createdByUserId),
          eq(personalResearchOfferCandidates.tripId, tripId),
          eq(personalResearchOfferCandidates.capability, capability),
        ));
    }

    const eligible: ResolvedOfferCueCandidate[] = [];
    const seenScopeKeys = new Set<string>();
    for (const candidate of params.decision.candidates) {
      const row = candidateRows.find((r) => r.id === candidate.candidateRef);
      if (!row) {
        incrementOfferCueMetrics({ capability, metric: "decision", outcome: "skipped_freshness" });
        continue;
      }
      if (row.expiresAt.getTime() <= now.getTime()) {
        incrementOfferCueMetrics({ capability, metric: "decision", outcome: "skipped_freshness" });
        continue;
      }
      if (row.visibleBeforeMessageSequence >= params.currentUserMessageSequence) {
        incrementOfferCueMetrics({ capability, metric: "decision", outcome: "skipped_freshness" });
        continue;
      }
      const scopeKey = capability === "flight" ? row.routeKey : row.stayKey;
      if (scopeKey && seenScopeKeys.has(scopeKey)) {
        incrementOfferCueMetrics({ capability, metric: "decision", outcome: "skipped_duplicate" });
        continue;
      }
      if (scopeKey) seenScopeKeys.add(scopeKey);
      eligible.push({
        ordinal: eligible.length,
        candidateRef: row.id,
        intent: candidate.intent,
        routeKey: row.routeKey,
        stayKey: row.stayKey,
      });
    }

    if (eligible.length === 0) {
      incrementOfferCueMetrics({ capability, metric: "decision", outcome: "skipped_freshness" });
      return null;
    }
    if (eligible.length > 5) {
      eligible.length = 5;
    }

    // Supersede any OPEN batch for the same (thread, capability). The
    // partial unique index also enforces this, but superseding inline keeps
    // the audit history clean.
    const open = await tx.select({ id: offerCueBatches.id })
      .from(offerCueBatches)
      .where(and(
        eq(offerCueBatches.threadId, threadId),
        eq(offerCueBatches.capability, capability),
        eq(offerCueBatches.status, "OPEN"),
      )).for("update");
    for (const row of open) {
      await tx.update(offerCueCandidates).set({
        status: "EXPIRED",
        resolvedAt: now,
      }).where(and(
        eq(offerCueCandidates.batchId, row.id),
        eq(offerCueCandidates.status, "PENDING"),
      ));
      await tx.update(offerCueBatches).set({
        status: "SUPERSEDED",
        updatedAt: now,
      }).where(eq(offerCueBatches.id, row.id));
    }

    const [batch] = await tx.insert(offerCueBatches).values({
      sourceRunId: params.run.id,
      threadId,
      tripId,
      ownerUserId: params.run.createdByUserId,
      capability: capability,
      sourceMessageId: null,
      offerSetId: candidateRows[0] ? sql<string>`(SELECT offer_set_id FROM personal_research_offer_candidates WHERE id = ${candidateRows[0].id})` : (sql<string>`gen_random_uuid()`),
      modelVersion: params.decision.modelVersion,
      promptVersion: params.decision.promptVersion,
      createdAt: now,
      updatedAt: now,
    }).returning({ id: offerCueBatches.id });

    await tx.insert(offerCueCandidates).values(eligible.map((candidate) => ({
      batchId: batch.id,
      personalOfferCandidateId: candidate.candidateRef,
      intent: candidate.intent,
      ordinal: candidate.ordinal,
      createdAt: now,
    })));

    incrementOfferCueMetrics({ capability, metric: "decision", outcome: "created" });
    logSafeRuntimeEvent(params.ctx, {
      component: "offer_cue",
      event: "persist",
      operation: `${capability}.offer.cue`,
      outcome: "success",
      promptVersion: params.decision.promptVersion,
      cueReasonCode: params.decision.reasonCode,
    });

    const cue = await cueFromBatch(tx, batch.id);
    if (!cue) return null;
    return { cue };
  });
}

export async function loadPendingOfferCues(params: {
  threadId: string;
  ownerUserId: string;
  capability?: OfferCueCapability;
}): Promise<OfferCueResponse[]> {
  await requireOwnedTripThreadRead(params.threadId, params.ownerUserId);
  const capabilityFilter = params.capability
    ? eq(offerCueBatches.capability, params.capability)
    : sql`TRUE`;
  const rows = await db.select({ id: offerCueBatches.id })
    .from(offerCueBatches)
    .where(and(
      eq(offerCueBatches.threadId, params.threadId),
      eq(offerCueBatches.ownerUserId, params.ownerUserId),
      eq(offerCueBatches.status, "OPEN"),
      capabilityFilter,
    ))
    .orderBy(desc(offerCueBatches.createdAt));
  const cues: OfferCueResponse[] = [];
  for (const row of rows) {
    const cue = await cueFromBatch(db, row.id);
    if (cue) cues.push(cue);
  }
  return cues;
}

export async function actOnOfferCueCandidate(params: {
  ctx: RequestContext;
  threadId: string;
  ownerUserId: string;
  cueId: string;
  candidateId: string;
  action: "accept" | "dismiss";
  requestId: string;
  expectedVersion: number;
  timeZone: string;
  source?: "CARD_BUTTON" | "RESULT_CARD_BUTTON";
  now?: Date;
}): Promise<OfferCueActionResponse> {
  const now = params.now ?? new Date();
  const key = `offer-cue:${params.ownerUserId}:${params.candidateId}:${params.action}:${params.requestId}`;
  const entityType = "offer_cue_action";

  return db.transaction(async (tx) => {
    const thread = await requireOwnedTripThread(tx, params.threadId, params.ownerUserId);
    const claim = await claimIdempotency(tx, { key, entityType });
    if (!claim) {
      const [record] = await tx.select({ resultPayload: idempotencyRecords.resultPayload })
        .from(idempotencyRecords).where(eq(idempotencyRecords.idempotencyKey, key)).limit(1);
      if (record?.resultPayload) return offerCueActionResponseSchema.parse(record.resultPayload);
      throw new ApiError(409, "Conflict", "Offer cue action is still being processed");
    }

    const [batch] = await tx.select().from(offerCueBatches)
      .where(eq(offerCueBatches.id, params.cueId)).for("update").limit(1);
    if (!batch || batch.threadId !== thread.id || batch.ownerUserId !== params.ownerUserId || batch.tripId !== thread.tripId) {
      throw new ApiError(404, "Not Found", "Offer cue not found");
    }
    if (batch.status !== "OPEN" || batch.version !== params.expectedVersion) {
      incrementOfferCueMetrics({
        capability: batch.capability,
        metric: "action",
        outcome: "stale_version",
        action: params.action,
        source: params.source ?? "card_button",
      });
      throw new ApiError(409, "Conflict", "Offer cue has changed", "OFFER_CUE_VERSION_CONFLICT");
    }
    const [candidate] = await tx.select().from(offerCueCandidates)
      .where(and(
        eq(offerCueCandidates.id, params.candidateId),
        eq(offerCueCandidates.batchId, batch.id),
      ))
      .for("update").limit(1);
    if (!candidate || candidate.status !== "PENDING") {
      incrementOfferCueMetrics({
        capability: batch.capability,
        metric: "action",
        outcome: "conflict",
        action: params.action,
        source: params.source ?? "card_button",
      });
      throw new ApiError(409, "Conflict", "Offer candidate has already been handled", "OFFER_CUE_CANDIDATE_NOT_PENDING");
    }

    const [trip] = await tx.select().from(sharedTrips)
      .where(eq(sharedTrips.id, batch.tripId)).for("update").limit(1);
    if (!trip || trip.status !== "DRAFT" || trip.createdBy !== params.ownerUserId) {
      incrementOfferCueMetrics({
        capability: batch.capability,
        metric: "action",
        outcome: "trip_state",
        action: params.action,
        source: params.source ?? "card_button",
      });
      throw new ApiError(
        409,
        "Conflict",
        "Offer cues are available only to the draft trip creator",
        "OFFER_CUE_TRIP_STATE_INCOMPATIBLE",
      );
    }

    // Validate that the underlying candidate row is still present and not
    // expired at the moment of acceptance. Re-check inside the transaction
    // so a parallel expiry cannot race an accept.
    const nowMs = now.getTime();
    const candidateRows = await tx.select({
      id: personalResearchOfferCandidates.id,
      expiresAt: personalResearchOfferCandidates.expiresAt,
      routeKey: personalResearchOfferCandidates.routeKey,
      stayKey: personalResearchOfferCandidates.stayKey,
      tripId: personalResearchOfferCandidates.tripId,
      threadId: personalResearchOfferCandidates.threadId,
      ownerUserId: personalResearchOfferCandidates.ownerUserId,
      capability: personalResearchOfferCandidates.capability,
    }).from(personalResearchOfferCandidates)
      .where(eq(personalResearchOfferCandidates.id, candidate.personalOfferCandidateId))
      .limit(1);
    const sourceRow = candidateRows[0];
    if (!sourceRow) {
      throw new ApiError(404, "Not Found", "Offer candidate source not found", "OFFER_CUE_NOT_FOUND");
    }
    if (sourceRow.expiresAt.getTime() <= nowMs + CANDIDATE_EXPIRY_SAFETY_MS) {
      incrementOfferCueMetrics({
        capability: batch.capability,
        metric: "action",
        outcome: "expired",
        action: params.action,
        source: params.source ?? "card_button",
      });
      throw new ApiError(409, "Conflict", "Offer has expired", "OFFER_CUE_EXPIRED");
    }

    const scopeKey = batch.capability === "flight" ? sourceRow.routeKey : sourceRow.stayKey;
    let selectionCreated: PersonalOfferSelectionCreated | null = null;

    if (params.action === "accept") {
      if (!scopeKey) {
        throw new ApiError(409, "Conflict", "Offer candidate is missing scope key", "OFFER_CUE_NOT_FOUND");
      }
      const superseded = await supersedeScopeSelections({
        tx,
        ownerUserId: params.ownerUserId,
        tripId: trip.id,
        capability: batch.capability,
        scopeKey,
      });
      selectionCreated = await createPersonalOfferSelection({
        tx,
        ownerUserId: params.ownerUserId,
        threadId: thread.id,
        tripId: trip.id,
        capability: batch.capability,
        personalOfferCandidateId: candidate.personalOfferCandidateId,
        scopeKey,
        now,
      });
      incrementOfferCueMetrics({
        capability: batch.capability,
        metric: "selection",
        outcome: "created",
      });
      if (superseded.supersededIds.length > 0) {
        incrementOfferCueMetrics({
          capability: batch.capability,
          metric: "selection",
          outcome: "superseded",
        });
      }
    } else {
      const timeZone = normalizeTimeZone(params.timeZone);
      const dismissalDay = localDayKey(now, timeZone);
      const [policy] = await tx.select().from(offerCuePromptPolicies)
        .where(and(
          eq(offerCuePromptPolicies.ownerUserId, params.ownerUserId),
          eq(offerCuePromptPolicies.tripId, trip.id),
          eq(offerCuePromptPolicies.capability, batch.capability),
        )).for("update").limit(1);
      const dailyDismissalCount = policy?.dismissalDay === dismissalDay
        ? policy.dailyDismissalCount + 1
        : 1;
      const cooldownUntil = new Date(nowMs + OFFER_CUE_COOLDOWN_MS);
      const mutedUntil = dailyDismissalCount >= OFFER_CUE_DAILY_DISMISSAL_LIMIT
        ? nextLocalDayStart(now, timeZone)
        : null;
      await tx.insert(offerCuePromptPolicies).values({
        ownerUserId: params.ownerUserId,
        tripId: trip.id,
        capability: batch.capability,
        cooldownUntil,
        dismissalDay,
        dailyDismissalCount,
        mutedUntil,
        timezone: timeZone,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [
          offerCuePromptPolicies.ownerUserId,
          offerCuePromptPolicies.tripId,
          offerCuePromptPolicies.capability,
        ],
        set: {
          cooldownUntil,
          dismissalDay,
          dailyDismissalCount,
          mutedUntil,
          timezone: timeZone,
          updatedAt: now,
          version: sql`${offerCuePromptPolicies.version} + 1`,
        },
      });
    }

    await tx.update(offerCueCandidates).set({
      status: params.action === "accept" ? "ACCEPTED" : "DISMISSED",
      resolvedAt: now,
    }).where(eq(offerCueCandidates.id, candidate.id));

    const [remaining] = await tx.select({ count: sql<number>`count(*)::int` })
      .from(offerCueCandidates)
      .where(and(
        eq(offerCueCandidates.batchId, batch.id),
        eq(offerCueCandidates.status, "PENDING"),
      ));
    const nextVersion = batch.version + 1;
    await tx.update(offerCueBatches).set({
      status: remaining.count === 0 ? "RESOLVED" : "OPEN",
      version: nextVersion,
      updatedAt: now,
    }).where(eq(offerCueBatches.id, batch.id));

    await recordAudit({
      ctx: params.ctx,
      action: offerCueAuditAction(batch.capability, params.action),
      actorUserId: params.ownerUserId,
      tripId: trip.id,
      summary: {
        cueId: batch.id,
        candidateId: candidate.id,
        capability: batch.capability,
        source: params.source ?? "CARD_BUTTON",
        remaining: remaining.count,
      },
      tx,
    });

    incrementOfferCueMetrics({
      capability: batch.capability,
      metric: "action",
      outcome: "success",
      action: params.action,
      source: params.source ?? "card_button",
    });

    const cue = remaining.count > 0 ? await cueFromBatch(tx, batch.id) : null;
    const response = offerCueActionResponseSchema.parse({
      cue,
      selection: selectionCreated
        ? {
            id: selectionCreated.id,
            capability: batch.capability,
            status: "ACTIVE",
            selectedAt: selectionCreated.selectedAt.toISOString(),
            supersededIds: selectionCreated.supersededIds,
          }
        : null,
    });
    await completeIdempotency(tx, key, entityType, batch.id, response);

    if (remaining.count === 0) {
      incrementOfferCueMetrics({
        capability: batch.capability,
        metric: "resolution",
        outcome: "resolved",
      });
    }

    return response;
  });
}

async function cueFromBatch(target: typeof db | Tx, batchId: string): Promise<OfferCueResponse | null> {
  const [batch] = await target.select({
    id: offerCueBatches.id,
    version: offerCueBatches.version,
    capability: offerCueBatches.capability,
    offerSetId: offerCueBatches.offerSetId,
  })
    .from(offerCueBatches)
    .where(and(eq(offerCueBatches.id, batchId), eq(offerCueBatches.status, "OPEN")))
    .limit(1);
  if (!batch) return null;
  const candidates = await target.select({
    id: offerCueCandidates.id,
    personalOfferCandidateId: offerCueCandidates.personalOfferCandidateId,
    intent: offerCueCandidates.intent,
    ordinal: offerCueCandidates.ordinal,
    status: offerCueCandidates.status,
  }).from(offerCueCandidates)
    .where(and(
      eq(offerCueCandidates.batchId, batchId),
      eq(offerCueCandidates.status, "PENDING"),
    ))
    .orderBy(asc(offerCueCandidates.ordinal));
  if (candidates.length === 0) return null;

  const refs = candidates.map((c) => c.personalOfferCandidateId);
  let rows: Array<{ id: string; expiresAt: Date; normalizedOfferJson: unknown }> = [];
  if (refs.length > 0) {
    rows = await target.select({
      id: personalResearchOfferCandidates.id,
      expiresAt: personalResearchOfferCandidates.expiresAt,
      normalizedOfferJson: personalResearchOfferCandidates.normalizedOfferJson,
    }).from(personalResearchOfferCandidates)
      .where(inArray(personalResearchOfferCandidates.id, refs))
      .limit(refs.length);
  }
  const byId = new Map(rows.map((row) => [row.id, row]));

  const fallbackExpiry = new Date(Date.now() + 30 * 60_000);
  const projected = candidates.map((c) => {
    const row = byId.get(c.personalOfferCandidateId);
    const display = row
      ? projectDisplay(batch.capability, row.normalizedOfferJson)
      : { capability: batch.capability, headline: "(unavailable)", subline: null, priceLabel: null };
    return {
      id: c.id,
      candidateRef: c.personalOfferCandidateId,
      ordinal: c.ordinal,
      intent: c.intent,
      status: c.status,
      display,
    };
  });

  return offerCueResponseSchema.parse({
    id: batch.id,
    version: batch.version,
    capability: batch.capability,
    candidates: projected,
    reasonCode: "EXPLICIT_SELECTION",
    expiresAt: (rows[0]?.expiresAt ?? fallbackExpiry).toISOString(),
  });
}

function projectDisplay(
  capability: OfferCueCapability,
  normalizedOfferJson: unknown,
): { capability: OfferCueCapability; headline: string; subline: string | null; priceLabel: string | null } {
  const json = (normalizedOfferJson ?? {}) as Record<string, unknown>;
  if (capability === "flight") {
    const carrier = typeof json.carrierCode === "string" ? json.carrierCode : "";
    const number = typeof json.flightNumber === "string" ? json.flightNumber : "";
    const departureAt = typeof json.departureAt === "string" ? json.departureAt.slice(11, 16) : "";
    const arrivalAt = typeof json.arrivalAt === "string" ? json.arrivalAt.slice(11, 16) : "";
    const totalPrice = typeof json.totalPrice === "number" ? json.totalPrice : null;
    const currency = typeof json.currency === "string" ? json.currency : null;
    const headline = [carrier, number].filter(Boolean).join(" ").trim() || "Flight option";
    const subline = [departureAt && arrivalAt ? `${departureAt} → ${arrivalAt}` : null]
      .filter(Boolean).join("") || null;
    const priceLabel = totalPrice !== null && currency
      ? `${currency} ${totalPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
      : null;
    return { capability, headline, subline, priceLabel };
  }
  const propertyName = typeof json.propertyName === "string" ? json.propertyName : "Hotel option";
  const pricePerNight = typeof json.pricePerNight === "number" ? json.pricePerNight : null;
  const currency = typeof json.currency === "string" ? json.currency : null;
  const cancellationSummary = typeof json.cancellationSummary === "string" ? json.cancellationSummary : null;
  const priceLabel = pricePerNight !== null && currency
    ? `${currency} ${pricePerNight.toLocaleString("en-US", { maximumFractionDigits: 0 })} / night`
    : null;
  return {
    capability,
    headline: propertyName,
    subline: cancellationSummary,
    priceLabel,
  };
}

function offerCueAuditAction(
  capability: OfferCueCapability,
  action: "accept" | "dismiss",
): "FLIGHT_OFFER_CUE_ACCEPT" | "FLIGHT_OFFER_CUE_DISMISS" | "HOTEL_OFFER_CUE_ACCEPT" | "HOTEL_OFFER_CUE_DISMISS" {
  if (capability === "flight" && action === "accept") return "FLIGHT_OFFER_CUE_ACCEPT";
  if (capability === "flight" && action === "dismiss") return "FLIGHT_OFFER_CUE_DISMISS";
  if (capability === "hotel" && action === "accept") return "HOTEL_OFFER_CUE_ACCEPT";
  return "HOTEL_OFFER_CUE_DISMISS";
}

// Use the capability enum so the type system keeps the constants aligned
// with the DB enum. Avoids the unused-import warning at the same time.
void offerCueCapabilityEnum;

// Hook to allow callers to inspect selections without going through the
// offer cue action path. Re-exported for the routes layer.
export async function loadPersonalOfferSelectionsForThread(params: {
  threadId: string;
  ownerUserId: string;
  capability?: OfferCueCapability;
}) {
  return listPersonalOfferSelectionsForTrip({
    threadId: params.threadId,
    ownerUserId: params.ownerUserId,
    capability: params.capability,
  });
}
