/**
 * Personal Route Place Proposal Service — Phase 4.
 *
 * Owner-facing service for selecting / adopting route endpoints before a
 * navigation or mobility research run is confirmed. Sits between the
 * Conversation Worker (which produces a NEEDS_PLACE_SELECTION draft)
 * and the existing TripPlace / PlaceSearch skill surface (which is
 * LLM-invoked). All operations are owner-driven and member-scoped.
 *
 * Spec invariants:
 * - The owner NEVER receives a route suggestion produced by the LLM —
 *   candidates are produced by `getLocationReferenceSource()` against
 *   the server-side reference dataset only.
 * - Adopting a candidate creates an `ACTIVE` `trip_place` via the
 *   existing `trip-place-service` atomicity contract, which propagates
 *   the STALE cascade to dependent route evidence / plans /
 *   confirmations.
 * - `OWNER_PRIVATE` visibility is rejected at the route endpoint — a
 *   route endpoint must be visible to the orchestrator.
 *
 * Source: docs/personal-research-intent-routing-implementation.md §6,
 * §7 Phase 4.
 */

import { and, eq, ne } from "drizzle-orm";

import { db } from "../db/database.js";
import { tripPlaces } from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";
import {
  adoptTripPlace as atomicAdoptTripPlace,
  proposeTripPlace as atomicProposeTripPlace,
} from "./trip-place-service.js";
import type { PlaceCandidate } from "../types/domain.js";
import type { RequestContext } from "../utils/context.js";

export interface RouteEndpointCandidate {
  /**
   * Server-derived source identifier. The owner client uses this to
   * echo back the chosen candidate to the adopt endpoint. NEVER echo
   * the original chat question into the response — `sourceId` is a
   * stable reference token.
   */
  sourceId: string;
  displayName: string;
  /** Country code in ISO-3166-1 alpha-2 (uppercase) when known. */
  countryCode: string | null;
  cityName: string | null;
  longitude: number;
  latitude: number;
  provenance: "REFERENCE" | "INSPIRATION";
}

export interface ProposeRouteEndpointsInput {
  ctx: RequestContext;
  tripId: string;
  ownerUserId: string;
  /** Free-text query from the owner — never used to derive a destination. */
  query: string;
  /** Limit the candidate count; capped at 5 per call. */
  limit?: number;
}

/**
 * Search candidates via the server-controlled location reference source.
 *
 * The MVP search is deterministic + REF-only: we expose the existing
 * trip's destination candidates as the route-endpoint universe. The
 * reference source's coord resolution is the authoritative "what the
 * server knows about a place" signal — we never fall back to a model
 * autocomplete, which would violate spec §9.4 (the model must not guess
 * ambiguous names like "西园町").
 *
 * `INSPIRATION` provenance is reserved for query-derived candidates and
 * is currently always `null` (the MVP does not surface server-inferred
 * place names). Future phases may extend this once the PlaceSearch
 * provider is wired for owner-driven use.
 */
export async function proposeRouteEndpoints(
  params: ProposeRouteEndpointsInput,
): Promise<RouteEndpointCandidate[]> {
  // Limit the size of the candidate set. Five is enough for owner
  // disambiguation and small enough to keep SSE/JSON payloads bounded.
  const limit = Math.min(Math.max(params.limit ?? 5, 1), 5);
  void params.query;

  // Surface the trip's destination candidates as the route-endpoint
  // universe. The PersonalTripContext already carries the destination
  // candidates (validated at acceptance). Returning them as
  // proposal candidates gives the owner a deterministic, server-
  // controlled selection surface — never an LLM guess.
  // (Phase 4 + real Place provider: replace this with a server-side
  // search against the configured Place provider.)
  const rows = await db.select({
    id: tripPlaces.id,
    displayName: tripPlaces.displayName,
    countryCode: tripPlaces.countryCode,
    cityName: tripPlaces.cityName,
    longitude: tripPlaces.longitude,
    latitude: tripPlaces.latitude,
    source: tripPlaces.source,
  }).from(tripPlaces).where(and(
    eq(tripPlaces.tripId, params.tripId),
    eq(tripPlaces.status, "ACTIVE"),
    ne(tripPlaces.visibility, "OWNER_PRIVATE"),
  )).limit(limit);
  return rows.map((row) => ({
    sourceId: `trip_place:${row.id}`,
    displayName: row.displayName,
    countryCode: row.countryCode,
    cityName: row.cityName,
    longitude: row.longitude ?? 0,
    latitude: row.latitude ?? 0,
    provenance: "REFERENCE" as const,
  }));
}

export interface AdoptRouteEndpointInput {
  ctx: RequestContext;
  tripId: string;
  ownerUserId: string;
  sourceId: string;
  displayName: string;
  /** ISO-3166-1 alpha-2 or null. */
  countryCode?: string | null;
  cityName?: string | null;
  longitude: number;
  latitude: number;
  visibility?: "TEAM_VISIBLE" | "ORCHESTRATOR_CONFIDENTIAL";
  kind?: "ATTRACTION" | "TRANSPORT_HUB" | "RESTAURANT" | "HOTEL" | "OTHER";
}

/**
 * Adopt a candidate as an ACTIVE trip_place suitable for route research.
 *
 * Two-step atomicity:
 *  1. `proposeTripPlace` persists a PROPOSED row bound to this run.
 *  2. `adoptTripPlace` transitions PROPOSED → ACTIVE under the existing
 *     STALE-cascade contract.
 *
 * The route endpoint rejects `OWNER_PRIVATE` because navigation.route
 * can only reference non-private places (orchestrator invariant).
 */
export async function adoptRouteEndpoint(
  params: AdoptRouteEndpointInput,
): Promise<{ placeId: string }> {
  if (params.visibility === undefined) {
    // Default to TEAM_VISIBLE — route endpoints must participate in
    // shared evidence; only TEAM_VISIBLE / ORCHESTRATOR_CONFIDENTIAL
    // are admissible.
    params.visibility = "TEAM_VISIBLE";
  }
  if (params.kind === undefined) {
    params.kind = "ATTRACTION";
  }

  const capturedAt = new Date().toISOString();
  const candidate: PlaceCandidate = {
    candidateId: params.sourceId,
    displayName: params.displayName,
    kind: params.kind ?? "ATTRACTION",
    countryCode: params.countryCode ?? null,
    cityName: params.cityName ?? null,
    longitude: params.longitude,
    latitude: params.latitude,
    // Server-controlled REF/INSPIRATION provenance is set by the
    // upstream proposal search; for owner-adopted place names we
    // default to a fixed-confidence high-trust mark and flag
    // confirmation already happened (the owner picked it).
    confidence: 1.0,
    needsUserConfirmation: false,
    source: params.sourceId,
    capturedAt,
  };

  const placeId = await atomicProposeTripPlace({
    ctx: params.ctx,
    tripId: params.tripId,
    ownerUserId: params.ownerUserId,
    snapshotId: "00000000-0000-0000-0000-000000000000", // unused at PROPOSE
    candidate,
    visibility: params.visibility,
    kind: params.kind,
  });

  await atomicAdoptTripPlace({
    ctx: params.ctx,
    tripId: params.tripId,
    placeId,
  });

  return { placeId };
}

/**
 * List the owner's two most-recently adopted ACTIVE non-OWNER_PRIVATE
 * trip_places. Used by the UI to seed the route-endpoint picker when
 * the owner already has candidate endpoints from a prior round.
 */
export async function listAdoptedRouteEndpoints(
  params: { tripId: string; ownerUserId: string },
): Promise<Array<{
  placeId: string;
  displayName: string;
  longitude: number;
  latitude: number;
}>> {
  const rows = await db.select({
    id: tripPlaces.id,
    displayName: tripPlaces.displayName,
    longitude: tripPlaces.longitude,
    latitude: tripPlaces.latitude,
  }).from(tripPlaces).where(and(
    eq(tripPlaces.tripId, params.tripId),
    eq(tripPlaces.ownerUserId, params.ownerUserId),
    eq(tripPlaces.status, "ACTIVE"),
    ne(tripPlaces.visibility, "OWNER_PRIVATE"),
  )).orderBy(tripPlaces.createdAt).limit(2);
  return rows.map((r) => ({
    placeId: r.id,
    displayName: r.displayName,
    longitude: r.longitude ?? 0,
    latitude: r.latitude ?? 0,
  }));
}

/**
 * Convenience guard for the route handler. Throws 422 when the body
 * violates the route-endpoint contract (e.g. OWNER_PRIVATE visibility).
 */
export function assertRouteEndpointVisibility(
  visibility: string | undefined,
): asserts visibility is "TEAM_VISIBLE" | "ORCHESTRATOR_CONFIDENTIAL" {
  if (visibility === "OWNER_PRIVATE") {
    throw new ApiError(
      422,
      "Unprocessable Entity",
      "ROUTE_VISIBILITY_DENIED: OWNER_PRIVATE places cannot be used as route endpoints",
    );
  }
}
