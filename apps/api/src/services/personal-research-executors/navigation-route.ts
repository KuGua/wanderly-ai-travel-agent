/**
 * Personal navigation-route executor.
 *
 * Owner-only typed input from the DRAFT Personal Research confirm path.
 * Calls the ORS Navigation adapter directly (NEVER the Shared
 * `executeAndPersistNavigationRoute` persistence layer) and projects the
 * result to the bounded `personalResearchNavigationRouteEvidenceSummarySchema`.
 *
 * Privacy: the executor NEVER carries commercial fare, schedules, or
 * carrier-specific metadata. The summary exposes only geometry + distance
 * + duration + mode — same shape the Shared path uses for the audit log
 * strip. Source: docs/draft-personal-research-implementation.md §3.5
 * stage 3.
 */

import { and, eq, inArray } from "drizzle-orm";

import { db } from "../../db/database.js";
import { tripPlaces } from "../../db/schema.js";
import { createOrsNavigation } from "../../providers/live-provider-factory.js";
import type {
  NormalizedRouteEvidence,
  RouteCoordinate,
} from "../../providers/types.js";
import type { PersonalResearchEvidenceSummary } from "../../types/domain.js";
import type { AgentTaskRow } from "../../tasks/task-repository.js";

type RouteEndpoint = { latitude: number; longitude: number; label: string };

export type PersonalResearchNavigationRouteDraft = {
  kind: "NAVIGATION_ROUTE";
  /** Set together, for a route between two places already in the plan. */
  originPlaceId: string | null;
  destinationPlaceId: string | null;
  /** Set together, for a route between two points a conversation named. */
  origin: RouteEndpoint | null;
  destination: RouteEndpoint | null;
  mode: "driving" | "walking" | "cycling";
};

export async function executePersonalNavigationRoute(params: {
  run: AgentTaskRow;
  draft: PersonalResearchNavigationRouteDraft;
  signal: AbortSignal;
}): Promise<PersonalResearchEvidenceSummary> {
  const provider = createOrsNavigation();

  // Place ids identify rows in this system; the routing supplier takes
  // coordinates, so they are resolved here rather than handed to the
  // adapter, which has no database access and no notion of a trip place.
  // Nullish, not `!== null`: a draft written before this field existed omits
  // it entirely, and `undefined !== null` was true — so the point branch ran
  // for a place-id route and read a latitude off nothing.
  const coordinates = params.draft.origin != null && params.draft.destination != null
    ? {
      origin: { latitude: params.draft.origin.latitude, longitude: params.draft.origin.longitude },
      destination: { latitude: params.draft.destination.latitude, longitude: params.draft.destination.longitude },
    }
    : await resolveEndpointCoordinates(params);
  if (coordinates === null) return unavailableSummary("SEARCH_CONSTRAINTS_INCOMPLETE");

  const input = {
    // The routing supplier never sees these; they travel with the request so
    // a route between two plan places stays traceable to them. A route
    // between two named points has no row to point at, so it carries the
    // point itself.
    originPlaceId: params.draft.originPlaceId ?? pointReference(params.draft.origin ?? null),
    destinationPlaceId: params.draft.destinationPlaceId ?? pointReference(params.draft.destination ?? null),
    originCoordinate: coordinates.origin,
    destinationCoordinate: coordinates.destination,
    // Normalize Personal mode spelling (driving / walking / cycling) to the
    // Shared provider's WALK / DRIVE / CYCLE enum.
    mode: normalizeMode(params.draft.mode),
    snapshotId: "",
    runId: params.run.id,
    signal: params.signal,
  };

  let result: { outcome: "LIVE"; data: NormalizedRouteEvidence; source: string; capturedAt: string }
    | { outcome: "UNAVAILABLE"; reason: string };
  try {
    result = await provider.searchRoute(input);
  } catch (err) {
    return unavailableSummaryFromError(err);
  }

  if (result.outcome === "UNAVAILABLE") {
    return unavailableSummaryFromReason(result.reason);
  }

  const route = result.data;
  return {
    outcome: "AVAILABLE",
    capability: "navigation.route",
    navigation: {
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      mode: params.draft.mode,
      // The traveller's own names for the ends, when they gave them. A
      // distance and a duration say nothing without them.
      origin: params.draft.origin?.label ?? null,
      destination: params.draft.destination?.label ?? null,
    },
  };
}

function normalizeMode(mode: "driving" | "walking" | "cycling"): "WALK" | "DRIVE" | "CYCLE" {
  switch (mode) {
    case "driving": return "DRIVE";
    case "walking": return "WALK";
    case "cycling": return "CYCLE";
  }
}

type UnavailableCode =
  | "NOT_CONFIGURED"
  | "SEARCH_CONSTRAINTS_INCOMPLETE"
  | "NO_RESULTS"
  | "RATE_LIMITED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_FAILURE"
  | "INVALID_PROVIDER_RESPONSE"
  | "PROVIDER_NOT_APPROVED"
  | "PROVIDER_REQUEST_REJECTED";

const ALLOWED_UNAVAILABLE_CODES: UnavailableCode[] = [
  "NOT_CONFIGURED",
  "SEARCH_CONSTRAINTS_INCOMPLETE",
  "NO_RESULTS",
  "RATE_LIMITED",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_FAILURE",
  "INVALID_PROVIDER_RESPONSE",
  "PROVIDER_NOT_APPROVED",
  "PROVIDER_REQUEST_REJECTED",
];

function unavailableSummary(errorCode: UnavailableCode): PersonalResearchEvidenceSummary {
  return { outcome: "UNAVAILABLE", summary: { errorCode } };
}

function unavailableSummaryFromReason(reason: string): PersonalResearchEvidenceSummary {
  if ((ALLOWED_UNAVAILABLE_CODES as string[]).includes(reason)) {
    return unavailableSummary(reason as UnavailableCode);
  }
  return unavailableSummary("UPSTREAM_FAILURE");
}

function unavailableSummaryFromError(err: unknown): PersonalResearchEvidenceSummary {
  if (err instanceof Error && err.name === "AbortError") return unavailableSummary("UPSTREAM_TIMEOUT");
  return unavailableSummary("UPSTREAM_FAILURE");
}

/**
 * Both endpoints must be ACTIVE places on this run's trip. Owner-private
 * places are routable here — this is the owner's own research and the result
 * never leaves them — but only when the owner is the one asking.
 *
 * Returns null when either endpoint is missing, not routable, or has no
 * coordinates, which the caller reports as an incomplete search rather than
 * a provider failure.
 */
async function resolveEndpointCoordinates(params: {
  run: AgentTaskRow;
  draft: PersonalResearchNavigationRouteDraft;
}): Promise<{ origin: RouteCoordinate; destination: RouteCoordinate } | null> {
  const { originPlaceId, destinationPlaceId } = params.draft;
  if (!params.run.tripId || originPlaceId == null || destinationPlaceId == null) return null;
  const rows = await db.select({
    id: tripPlaces.id,
    ownerUserId: tripPlaces.ownerUserId,
    visibility: tripPlaces.visibility,
    longitude: tripPlaces.longitude,
    latitude: tripPlaces.latitude,
  }).from(tripPlaces).where(and(
    eq(tripPlaces.tripId, params.run.tripId),
    eq(tripPlaces.status, "ACTIVE"),
    inArray(tripPlaces.id, [originPlaceId, destinationPlaceId]),
  ));

  const byId = new Map(rows.map((row) => [row.id, row]));
  const origin = toCoordinate(byId.get(originPlaceId), params.run.createdByUserId);
  const destination = toCoordinate(byId.get(destinationPlaceId), params.run.createdByUserId);
  if (origin === null || destination === null) return null;
  return { origin, destination };
}

/** A stand-in identifier for an endpoint that is a point rather than a row. */
function pointReference(endpoint: RouteEndpoint | null): string {
  return endpoint === null
    ? "unknown"
    : `point:${endpoint.latitude.toFixed(5)},${endpoint.longitude.toFixed(5)}`;
}

function toCoordinate(
  row: {
    ownerUserId: string;
    visibility: string;
    longitude: number | null;
    latitude: number | null;
  } | undefined,
  callerUserId: string,
): RouteCoordinate | null {
  if (!row) return null;
  if (row.visibility === "OWNER_PRIVATE" && row.ownerUserId !== callerUserId) return null;
  if (row.longitude === null || row.latitude === null) return null;
  return { longitude: row.longitude, latitude: row.latitude };
}
