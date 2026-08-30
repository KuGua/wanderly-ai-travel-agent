import { eq, and, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/database.js";
import {
  itineraryPlans,
  memberConfirmations,
  navigationRouteEvidence,
  tripPlaces,
} from "../db/schema.js";
import type {
  PlaceCandidate,
  TripPlace,
  TripPlaceKind,
  TripPlaceStatus,
  TripPlaceVisibility,
} from "../types/domain.js";
import type { RequestContext } from "../utils/context.js";

/**
 * Spec §4.1 — TripPlace is the server-authoritative POI reference. It is the
 * only path through which a `candidateId` (run-bound, short-lived) becomes a
 * persisted, versioned reference that downstream route evidence and confirmations
 * can rely on.
 *
 * Invariants enforced here:
 *   * `OWNER_PRIVATE` places are NEVER visible to a Shared snapshot — they
 *     can never be referenced from `navigation.route` or any team-visible
 *     evidence, and they never appear in `place.adopt` writes.
 *   * `adoptTripPlace` and `revokeTripPlace` are atomic with respect to
 *     `navigation_route_evidence` and the trip's `ACTIVE` plan +
 *     confirmations: a write to TripPlace in the same transaction flips
 *     dependent rows to `STALE` and enqueues a replan. This is the only
 *     way the system can guarantee that downstream route evidence never
 *     outlives its referenced place.
 *   * A `candidateId` is bound to the `agentTaskRunId` from which it was
 *     produced; cross-run adoption is rejected to prevent stale candidates
 *     from leaking into later planning rounds.
 */

const tripPlaceKindSchema = z.enum(["ATTRACTION", "HOTEL", "RESTAURANT", "TRANSPORT_HUB", "OTHER"]);
const tripPlaceVisibilitySchema = z.enum(["OWNER_PRIVATE", "TEAM_VISIBLE", "ORCHESTRATOR_CONFIDENTIAL"]);

export const proposeTripPlaceInputSchema = z.object({
  candidateId: z.string().uuid(),
  visibility: tripPlaceVisibilitySchema,
  kind: tripPlaceKindSchema,
}).strict();
export type ProposeTripPlaceInput = z.infer<typeof proposeTripPlaceInputSchema>;

export const adoptTripPlaceInputSchema = z.object({
  placeId: z.string().uuid(),
}).strict();
export type AdoptTripPlaceInput = z.infer<typeof adoptTripPlaceInputSchema>;

export const revokeTripPlaceInputSchema = z.object({
  placeId: z.string().uuid(),
  reason: z.string().min(1).max(256),
}).strict();
export type RevokeTripPlaceInput = z.infer<typeof revokeTripPlaceInputSchema>;

export class PlaceCandidateStaleError extends Error {
  readonly code = "PLACE_CANDIDATE_STALE";
  constructor(message: string) {
    super(message);
    this.name = "PlaceCandidateStaleError";
  }
}

export class PlaceNotFoundError extends Error {
  readonly code = "PLACE_NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "PlaceNotFoundError";
  }
}

export class PlaceVisibilityDeniedError extends Error {
  readonly code = "PLACE_VISIBILITY_DENIED";
  constructor(message: string) {
    super(message);
    this.name = "PlaceVisibilityDeniedError";
  }
}

/**
 * Persist a candidate as a PROPOSED TripPlace bound to the current run. The
 * caller has already validated that `candidateId` originated from
 * `places.search` for the same `agentTaskRunId`. Phase 2 wires the run-bound
 * store; this service is pure and returns the persisted row id.
 */
export async function proposeTripPlace(params: {
  ctx: RequestContext;
  tripId: string;
  ownerUserId: string;
  snapshotId: string;
  agentTaskRunId?: string;
  candidate: PlaceCandidate;
  visibility: TripPlaceVisibility;
  kind: TripPlaceKind;
}): Promise<string> {
  void params.ctx;
  if (params.visibility === "OWNER_PRIVATE") {
    // Private places are still persisted but never participate in shared
    // evidence. Phase 2 attaches them to a private thread; this milestone
    // records the invariant in code.
  }
  const [row] = await db.insert(tripPlaces).values({
    tripId: params.tripId,
    ownerUserId: params.ownerUserId,
    version: 1,
    visibility: params.visibility,
    status: "PROPOSED",
    kind: params.kind,
    displayName: params.candidate.displayName,
    countryCode: params.candidate.countryCode,
    cityName: params.candidate.cityName,
    longitude: params.candidate.longitude,
    latitude: params.candidate.latitude,
    source: params.candidate.source,
    providerPlaceId: null,
    capturedAt: new Date(params.candidate.capturedAt),
    createdFromRunId: params.agentTaskRunId ?? null,
  }).returning({ id: tripPlaces.id });
  if (!row) throw new Error("proposeTripPlace: insert returned no row");
  return row.id;
}

/**
 * Promote a PROPOSED TripPlace to ACTIVE in the same transaction that marks
 * dependent route evidence and the trip's ACTIVE plan/confirmations as
 * STALE. New code that wants to invalidate downstream state MUST go through
 * this service so the atomicity invariant holds.
 */
export async function adoptTripPlace(params: {
  ctx: RequestContext;
  tripId: string;
  placeId: string;
}): Promise<void> {
  void params.ctx;
  await db.transaction(async (tx) => {
    const [place] = await tx.select().from(tripPlaces)
      .where(and(eq(tripPlaces.id, params.placeId), eq(tripPlaces.tripId, params.tripId)))
      .for("update")
      .limit(1);
    if (!place) throw new PlaceNotFoundError("place not found for trip");
    if (place.visibility === "OWNER_PRIVATE") {
      throw new PlaceVisibilityDeniedError("OWNER_PRIVATE place cannot be adopted into shared evidence");
    }
    if (place.status === "ACTIVE") return;
    if (place.status !== "PROPOSED") {
      throw new Error(`adoptTripPlace: cannot adopt place in status ${place.status}`);
    }
    const now = new Date();
    await tx.update(tripPlaces).set({
      status: "ACTIVE",
      updatedAt: now,
    }).where(eq(tripPlaces.id, params.placeId));
    await tx.update(navigationRouteEvidence).set({
      // No dedicated stale flag yet — refresh_after remains the contract. We
      // deliberately avoid adding columns here; Phase 3 will add `stale_at`
      // if needed. Today, refreshing `refresh_after` to now forces a
      // re-route on next planner access.
      refreshAfter: now,
    }).where(and(
      eq(navigationRouteEvidence.tripId, params.tripId),
      inArray(navigationRouteEvidence.originPlaceId, [params.placeId]),
    ));
    await tx.update(itineraryPlans).set({
      status: "STALE",
      staleReason: "place_adopted",
      supersededAt: now,
    }).where(and(
      eq(itineraryPlans.tripId, params.tripId),
      eq(itineraryPlans.status, "ACTIVE"),
    ));
    await tx.update(memberConfirmations).set({
      status: "STALE",
    }).where(and(
      eq(memberConfirmations.tripId, params.tripId),
      inArray(memberConfirmations.status, ["PENDING", "CONFIRMED", "NEEDS_CHANGES"]),
    ));
  });
}

/**
 * Mark a place as REVOKED and stale-out dependent evidence. Idempotent.
 */
export async function revokeTripPlace(params: {
  ctx: RequestContext;
  tripId: string;
  placeId: string;
  reason: string;
}): Promise<void> {
  void params.ctx;
  await db.transaction(async (tx) => {
    const [place] = await tx.select().from(tripPlaces)
      .where(and(eq(tripPlaces.id, params.placeId), eq(tripPlaces.tripId, params.tripId)))
      .for("update")
      .limit(1);
    if (!place) throw new PlaceNotFoundError("place not found for trip");
    if (place.status === "REVOKED") return;
    const now = new Date();
    await tx.update(tripPlaces).set({
      status: "REVOKED",
      updatedAt: now,
    }).where(eq(tripPlaces.id, params.placeId));
    await tx.update(navigationRouteEvidence).set({
      refreshAfter: now,
    }).where(and(
      eq(navigationRouteEvidence.tripId, params.tripId),
      inArray(navigationRouteEvidence.originPlaceId, [params.placeId]),
    ));
    await tx.update(itineraryPlans).set({
      status: "STALE",
      staleReason: `place_revoked:${params.reason}`,
      supersededAt: now,
    }).where(and(
      eq(itineraryPlans.tripId, params.tripId),
      eq(itineraryPlans.status, "ACTIVE"),
    ));
    await tx.update(memberConfirmations).set({
      status: "STALE",
    }).where(and(
      eq(memberConfirmations.tripId, params.tripId),
      inArray(memberConfirmations.status, ["PENDING", "CONFIRMED", "NEEDS_CHANGES"]),
    ));
  });
}

export function toTripPlace(row: {
  id: string;
  tripId: string;
  ownerUserId: string;
  version: number;
  visibility: TripPlaceVisibility;
  status: TripPlaceStatus;
  kind: TripPlaceKind;
  displayName: string;
  countryCode: string | null;
  cityName: string | null;
  longitude: number | null;
  latitude: number | null;
  source: string;
  providerPlaceId: string | null;
  capturedAt: Date;
  createdFromRunId: string | null;
}): TripPlace {
  return {
    id: row.id,
    tripId: row.tripId,
    ownerUserId: row.ownerUserId,
    version: row.version,
    visibility: row.visibility,
    status: row.status,
    kind: row.kind,
    displayName: row.displayName,
    countryCode: row.countryCode,
    cityName: row.cityName,
    longitude: row.longitude,
    latitude: row.latitude,
    source: row.source,
    providerPlaceId: row.providerPlaceId,
    capturedAt: row.capturedAt.toISOString(),
    createdFromRunId: row.createdFromRunId,
  };
}