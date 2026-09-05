/**
 * Personal Research Offer Candidate service — opaque identity layer for the
 * Flight / Hotel Offer Cue decision model (docs/flight-offer-cue-model-
 * draft.md §6, docs/hotel-offer-cue-model-draft.md §6).
 *
 * Each Personal Research AVAILABLE summary for a Flight or Hotel search
 * produces up to 5 `personal_research_offer_candidates` rows. Each row
 * carries an opaque server-issued id, a `routeKey` (flight) or `stayKey`
 * (hotel) the resolver uses to group candidates by leg / stay, the bounded
 * `normalized_offer_json` the model reads, and `visible_before_message_
 * sequence` so the resolver can exclude offers the user has not seen yet.
 *
 * Privacy:
 *   - `providerOfferId` / raw provider payload / coordinates / PII are
 *     stripped at the executor boundary; the persisted JSON is exactly
 *     the Zod-validated bounded shape used by the chat DTO.
 *   - The browser never receives `routeKey`, `stayKey`, or `candidate.id`;
 *     only an opaque `candidateRef` and the ordinal.
 */

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db/database.js";
import {
  offerCueCapabilityEnum,
  personalResearchOfferCandidates,
} from "../db/schema.js";
import {
  personalResearchFlightOfferCandidateJsonSchema,
  personalResearchHotelOfferCandidateJsonSchema,
} from "../types/schemas.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

export type OfferCueCapability = "flight" | "hotel";

export interface FlightOfferCandidateProjection {
  ordinal: number;
  carrierCode: string;
  flightNumber: string | null;
  departureAt: string;
  arrivalAt: string;
  totalDuration: string;
  totalPrice: number;
  currency: string;
  stopCount: number;
}

export interface HotelOfferCandidateProjection {
  ordinal: number;
  propertyName: string;
  pricePerNight: number;
  totalPrice: number;
  currency: string;
  checkIn: string;
  checkOut: string;
  cancellationSummary: string | null;
  roomSummary: string | null;
  taxStatus: "INCLUDED" | "PARTIAL" | "UNKNOWN";
}

export interface FlightCandidateUpsertInput {
  projection: FlightOfferCandidateProjection;
  routeKey: string;
}

export interface HotelCandidateUpsertInput {
  projection: HotelOfferCandidateProjection;
  stayKey: string;
}

function normalizeFlightProjection(projection: FlightOfferCandidateProjection) {
  return personalResearchFlightOfferCandidateJsonSchema.parse(projection);
}

function normalizeHotelProjection(projection: HotelOfferCandidateProjection) {
  return personalResearchHotelOfferCandidateJsonSchema.parse(projection);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Server-derived routeKey for a Flight offer. Two flights share a routeKey
 * iff they share (origin, destination, cabin, earliest departure date). The
 * Offer Cue resolver dedups multiple candidates with the same routeKey
 * inside one batch, forcing a single recommendation per leg.
 */
export function buildFlightRouteKey(input: {
  originIata: string;
  destinationIata: string;
  cabin: string;
  earliestDepartureDate: string;
}): string {
  return sha256(
    [
      input.originIata.toUpperCase(),
      input.destinationIata.toUpperCase(),
      input.cabin,
      input.earliestDepartureDate,
    ].join("|"),
  );
}

/**
 * Server-derived stayKey for a Hotel offer. Two hotels share a stayKey iff
 * they share (city code, check-in, check-out, adults per room). The Offer
 * Cue resolver dedups multiple candidates with the same stayKey inside one
 * batch.
 */
export function buildHotelStayKey(input: {
  cityCode: string;
  checkIn: string;
  checkOut: string;
  adultsPerRoom: number;
}): string {
  return sha256(
    [
      input.cityCode.toUpperCase(),
      input.checkIn,
      input.checkOut,
      String(input.adultsPerRoom),
    ].join("|"),
  );
}

/**
 * Upsert a set of candidates for one offer set. Returns the offerSetId
 * (a new uuid when not provided). Uses `ON CONFLICT (offer_set_id,
 * ordinal)` so a retry of the same run lands idempotently on the same
 * rows; `visible_before_message_sequence` is never recomputed on update —
 * the original assistant message sequence is preserved across retries.
 *
 * Cap is 5 to match `PERSONAL_RESEARCH_EVIDENCE_ITEM_LIMIT`. Caller is
 * expected to project its top-5 in cheapest-first order.
 */
export async function upsertOfferCandidates(params: {
  tx: DbOrTx;
  evidenceId: string;
  tripId: string;
  threadId: string;
  ownerUserId: string;
  capability: OfferCueCapability;
  candidates: Array<FlightCandidateUpsertInput | HotelCandidateUpsertInput>;
  expiresAt: Date;
  visibleBeforeMessageSequence: number;
  offerSetId?: string;
  now?: Date;
}): Promise<{ offerSetId: string; inserted: number }> {
  if (params.candidates.length === 0) {
    return { offerSetId: params.offerSetId ?? randomUUID(), inserted: 0 };
  }
  if (params.candidates.length > 5) {
    throw new Error(`At most 5 offer candidates per evidence row, got ${params.candidates.length}`);
  }
  if (!Number.isInteger(params.visibleBeforeMessageSequence) || params.visibleBeforeMessageSequence < 0) {
    throw new Error("visibleBeforeMessageSequence must be a non-negative integer");
  }
  const offerSetId = params.offerSetId ?? randomUUID();
  const now = params.now ?? new Date();

  for (let index = 0; index < params.candidates.length; index++) {
    const candidate = params.candidates[index]!;
    const ordinal = index;
    if (candidate.projection.ordinal !== ordinal) {
      throw new Error(`Candidate ordinal mismatch at index ${index}: got ${candidate.projection.ordinal}`);
    }
    const isFlight = params.capability === "flight";
    const isFlightCandidate = "routeKey" in candidate;
    if (isFlight !== isFlightCandidate) {
      throw new Error(`Candidate shape does not match capability ${params.capability}`);
    }
    const normalizedJson = isFlightCandidate
      ? normalizeFlightProjection(candidate.projection as FlightOfferCandidateProjection)
      : normalizeHotelProjection(candidate.projection as HotelOfferCandidateProjection);
    const scopeKey = isFlightCandidate
      ? (candidate as FlightCandidateUpsertInput).routeKey
      : (candidate as HotelCandidateUpsertInput).stayKey;

    const baseValues = {
      evidenceId: params.evidenceId,
      tripId: params.tripId,
      threadId: params.threadId,
      ownerUserId: params.ownerUserId,
      capability: offerCueCapabilityEnum.enumValues[isFlight ? 0 : 1] ?? (isFlight ? "flight" : "hotel"),
      offerSetId,
      ordinal,
      normalizedOfferJson: normalizedJson as unknown as Record<string, unknown>,
      expiresAt: params.expiresAt,
      visibleBeforeMessageSequence: params.visibleBeforeMessageSequence,
      createdAt: now,
    } satisfies typeof personalResearchOfferCandidates.$inferInsert;

    await params.tx
      .insert(personalResearchOfferCandidates)
      .values({
        ...baseValues,
        routeKey: isFlightCandidate ? scopeKey : null,
        stayKey: isFlightCandidate ? null : scopeKey,
      })
      .onConflictDoUpdate({
        target: [personalResearchOfferCandidates.offerSetId, personalResearchOfferCandidates.ordinal],
        set: {
          evidenceId: baseValues.evidenceId,
          // `visible_before_message_sequence` is intentionally NOT updated on
          // conflict — the original assistant-message sequence is preserved.
          normalizedOfferJson: baseValues.normalizedOfferJson,
          expiresAt: baseValues.expiresAt,
        },
      });
  }

  return { offerSetId, inserted: params.candidates.length };
}

export interface VisibleOfferCandidateRow {
  candidateRef: string;
  ordinal: number;
  offerSetId: string;
  capability: OfferCueCapability;
  normalizedOfferJson: Record<string, unknown>;
  routeKey: string | null;
  stayKey: string | null;
  expiresAt: Date;
  visibleBeforeMessageSequence: number;
}

/**
 * Lists candidates for a thread whose `visible_before_message_sequence` is
 * strictly less than `beforeMessageSequence` and whose `expires_at` is
 * still in the future. The caller passes the current user message's
 * `chat_messages.message_sequence`; results are ordered most-recent offer
 * set first, then ordinal ascending within a set.
 */
export async function listVisibleOfferCandidatesForThread(params: {
  threadId: string;
  ownerUserId: string;
  capability: OfferCueCapability;
  beforeMessageSequence: number;
  now: Date;
  limit?: number;
}): Promise<VisibleOfferCandidateRow[]> {
  const limit = params.limit ?? 5;
  const rows = await db
    .select({
      candidateRef: personalResearchOfferCandidates.id,
      ordinal: personalResearchOfferCandidates.ordinal,
      offerSetId: personalResearchOfferCandidates.offerSetId,
      capability: personalResearchOfferCandidates.capability,
      normalizedOfferJson: personalResearchOfferCandidates.normalizedOfferJson,
      routeKey: personalResearchOfferCandidates.routeKey,
      stayKey: personalResearchOfferCandidates.stayKey,
      expiresAt: personalResearchOfferCandidates.expiresAt,
      visibleBeforeMessageSequence: personalResearchOfferCandidates.visibleBeforeMessageSequence,
    })
    .from(personalResearchOfferCandidates)
    .where(and(
      eq(personalResearchOfferCandidates.threadId, params.threadId),
      eq(personalResearchOfferCandidates.ownerUserId, params.ownerUserId),
      eq(personalResearchOfferCandidates.capability, params.capability),
      lt(personalResearchOfferCandidates.visibleBeforeMessageSequence, params.beforeMessageSequence),
      gt(personalResearchOfferCandidates.expiresAt, params.now),
    ))
    .orderBy(
      desc(personalResearchOfferCandidates.createdAt),
      asc(personalResearchOfferCandidates.ordinal),
    )
    .limit(limit);
  return rows.map((row) => ({
    candidateRef: row.candidateRef,
    ordinal: row.ordinal,
    offerSetId: row.offerSetId,
    capability: row.capability,
    normalizedOfferJson: row.normalizedOfferJson as Record<string, unknown>,
    routeKey: row.routeKey,
    stayKey: row.stayKey,
    expiresAt: row.expiresAt,
    visibleBeforeMessageSequence: row.visibleBeforeMessageSequence,
  }));
}

/**
 * Loads candidates by their opaque refs, scoped to (owner, thread, trip)
 * and capability. Returns a Map keyed by candidateRef; unknown refs, cross-
 * owner reads and cross-thread reads are simply omitted — the resolver must
 * treat an empty entry as "this ref is not eligible" and drop the model
 * candidate. NEVER throws on missing rows.
 */
export async function loadOfferCandidatesByRefs(params: {
  ownerUserId: string;
  threadId: string;
  tripId: string;
  capability: OfferCueCapability;
  candidateRefs: string[];
}): Promise<Map<string, VisibleOfferCandidateRow>> {
  if (params.candidateRefs.length === 0) return new Map();
  const rows = await db
    .select({
      candidateRef: personalResearchOfferCandidates.id,
      ordinal: personalResearchOfferCandidates.ordinal,
      offerSetId: personalResearchOfferCandidates.offerSetId,
      capability: personalResearchOfferCandidates.capability,
      normalizedOfferJson: personalResearchOfferCandidates.normalizedOfferJson,
      routeKey: personalResearchOfferCandidates.routeKey,
      stayKey: personalResearchOfferCandidates.stayKey,
      expiresAt: personalResearchOfferCandidates.expiresAt,
      visibleBeforeMessageSequence: personalResearchOfferCandidates.visibleBeforeMessageSequence,
    })
    .from(personalResearchOfferCandidates)
    .where(and(
      eq(personalResearchOfferCandidates.ownerUserId, params.ownerUserId),
      eq(personalResearchOfferCandidates.threadId, params.threadId),
      eq(personalResearchOfferCandidates.tripId, params.tripId),
      eq(personalResearchOfferCandidates.capability, params.capability),
      inArray(personalResearchOfferCandidates.id, params.candidateRefs),
    ));
  const map = new Map<string, VisibleOfferCandidateRow>();
  for (const row of rows) {
    map.set(row.candidateRef, {
      candidateRef: row.candidateRef,
      ordinal: row.ordinal,
      offerSetId: row.offerSetId,
      capability: row.capability,
      normalizedOfferJson: row.normalizedOfferJson as Record<string, unknown>,
      routeKey: row.routeKey,
      stayKey: row.stayKey,
      expiresAt: row.expiresAt,
      visibleBeforeMessageSequence: row.visibleBeforeMessageSequence,
    });
  }
  return map;
}

// Avoid unused-import warnings when only the type is consumed.
void sql;
void z;
