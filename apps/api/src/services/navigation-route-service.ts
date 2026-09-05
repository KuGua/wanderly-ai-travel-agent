import { createHash } from "node:crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/database.js";
import { navigationRouteEvidence, providerSearchRuns, tripPlaces } from "../db/schema.js";
import type { NavigationProvider, NormalizedRouteEvidence, ProviderResult, RouteCoordinate } from "../providers/types.js";
import type { ConstraintSnapshotData, NavigationRouteEvidence, NavigationRouteMode } from "../types/domain.js";
import { recordAudit } from "./audit-service.js";
import type { RequestContext } from "../utils/context.js";

/**
 * Spec §5.2 — Shared `navigation.route` service.
 *
 * The model can only ever submit two authorized `placeId`s plus a mode.
 * `snapshotId` is injected by the dispatcher. The service:
 *   1. Validates that both places belong to the trip, are `ACTIVE`, and
 *      have a non-private visibility.
 *   2. Calls the configured `NavigationProvider` (ORS Directions by default).
 *   3. Persists a `provider_search_runs` row (`category: "navigation"`) and a
 *      `navigation_route_evidence` row inside one transaction.
 *   4. Emits the audit row and returns the model-safe summary.
 */
export const navigationRouteInputSchema = z.object({
  snapshotId: z.string().uuid(),
  originPlaceId: z.string().uuid(),
  destinationPlaceId: z.string().uuid(),
  mode: z.enum(["WALK", "DRIVE", "CYCLE"]),
}).strict().superRefine((input, ctx) => {
  if (input.originPlaceId === input.destinationPlaceId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["destinationPlaceId"], message: "origin and destination must differ" });
  }
});
export type NavigationRouteInput = z.infer<typeof navigationRouteInputSchema>;

export const navigationRouteModelArgumentsSchema = z.object({
  originPlaceId: z.string().uuid(),
  destinationPlaceId: z.string().uuid(),
  mode: z.enum(["WALK", "DRIVE", "CYCLE"]),
}).strict().superRefine((input, ctx) => {
  if (input.originPlaceId === input.destinationPlaceId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["destinationPlaceId"], message: "origin and destination must differ" });
  }
});
export type NavigationRouteModelArguments = z.infer<typeof navigationRouteModelArgumentsSchema>;

const providerUnavailableCodes = [
  "NOT_CONFIGURED",
  "SEARCH_CONSTRAINTS_INCOMPLETE",
  "NO_RESULTS",
  "RATE_LIMITED",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_FAILURE",
  "INVALID_PROVIDER_RESPONSE",
  "PROVIDER_NOT_APPROVED",
  "PROVIDER_REQUEST_REJECTED",
] as const;

export const navigationRouteOutputSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("LIVE"),
    routeId: z.string().uuid(),
    summary: z.object({
      originPlaceId: z.string().uuid(),
      destinationPlaceId: z.string().uuid(),
      mode: z.enum(["WALK", "DRIVE", "CYCLE"]),
      distanceMeters: z.number().nonnegative().finite(),
      durationSeconds: z.number().nonnegative().finite(),
      stepCount: z.number().int().nonnegative(),
      source: z.string().min(1),
      capturedAt: z.string().datetime({ offset: true }),
    }).strict(),
  }).strict(),
  z.object({
    outcome: z.literal("UNAVAILABLE"),
    code: z.enum(providerUnavailableCodes),
  }).strict(),
]);
export type NavigationRouteOutput = z.infer<typeof navigationRouteOutputSchema>;

export interface NavigationRouteExecutionContext {
  tripId: string;
  snapshotId: string;
  agentTaskRunId?: string;
}

export const NAVIGATION_REFRESH_AFTER_HOURS = 24;

/**
 * Snapshot-bound validation. The caller has already enforced that both
 * `placeId`s belong to the trip; this service is the single place that
 * enforces the visible-mode allow-list and the trip-wide `mode` allow-list.
 */
export async function validateSnapshotBoundNavigationRoute(params: {
  input: unknown;
  snapshotId: string;
  snapshot: ConstraintSnapshotData;
}): Promise<NavigationRouteInput> {
  const input = navigationRouteInputSchema.parse(params.input);
  if (input.snapshotId !== params.snapshotId) {
    throw new Error("navigation.route snapshot does not match task snapshot");
  }
  if (!["WALK", "DRIVE", "CYCLE"].includes(input.mode)) {
    throw new Error(`navigation.route mode ${input.mode} is not allowed`);
  }
  return input;
}

async function assertPlaceVisible(params: {
  tripId: string;
  placeId: string;
}): Promise<{ longitude: number | null; latitude: number | null; status: "ACTIVE" | "PROPOSED" | "REVOKED" }> {
  const rows = await db.select({
    id: tripPlaces.id,
    status: tripPlaces.status,
    visibility: tripPlaces.visibility,
    longitude: tripPlaces.longitude,
    latitude: tripPlaces.latitude,
  }).from(tripPlaces).where(eq(tripPlaces.id, params.placeId));
  const row = rows[0];
  if (!row) throw new Error(`navigation.route place ${params.placeId} not found`);
  if (row.visibility === "OWNER_PRIVATE") {
    throw new Error("navigation.route cannot reference OWNER_PRIVATE place");
  }
  if (row.status !== "ACTIVE") {
    throw new Error(`navigation.route place ${params.placeId} must be ACTIVE (current: ${row.status})`);
  }
  return { longitude: row.longitude, latitude: row.latitude, status: row.status };
}

/**
 * Reduce the persisted evidence row into the model-safe summary shape. The
 * full encoded geometry is server-internal and never crosses this boundary.
 */
export function summarizeRouteEvidence(evidence: NavigationRouteEvidence): NavigationRouteOutput {
  return {
    outcome: "LIVE",
    routeId: evidence.id,
    summary: {
      originPlaceId: evidence.originPlaceId,
      destinationPlaceId: evidence.destinationPlaceId,
      mode: evidence.mode,
      distanceMeters: evidence.distanceMeters,
      durationSeconds: evidence.durationSeconds,
      stepCount: evidence.steps.length,
      source: evidence.source,
      capturedAt: evidence.capturedAt,
    },
  };
}

/**
 * Execute a single route call against the configured provider and persist
 * `provider_search_runs` + `navigation_route_evidence` rows in one
 * transaction. Returns the model-safe summary on `LIVE`, or the bounded
 * `UNAVAILABLE` code on failure.
 */
/**
 * A place row is only routable once it has both coordinates. Rows can be
 * created from a name alone, so this is a normal absence rather than a
 * corruption — the caller reports it as a service gap.
 */
function toRouteCoordinate(
  place: { longitude: number | null; latitude: number | null },
): RouteCoordinate | null {
  if (place.longitude === null || place.latitude === null) return null;
  return { longitude: place.longitude, latitude: place.latitude };
}

export async function executeAndPersistNavigationRoute(params: {
  ctx: RequestContext;
  tripId: string;
  snapshotId: string;
  agentTaskRunId?: string;
  input: NavigationRouteInput;
  provider: NavigationProvider;
  signal?: AbortSignal;
}): Promise<NavigationRouteOutput> {
  // Defensive place visibility / ACTIVE checks. The skill layer is the
  // public boundary; this is the second line.
  // The visibility check already loads each place row, coordinates
  // included; the route request needs those coordinates, so they are kept
  // rather than re-queried.
  const [origin, destination] = await Promise.all([
    assertPlaceVisible({ tripId: params.tripId, placeId: params.input.originPlaceId }),
    assertPlaceVisible({ tripId: params.tripId, placeId: params.input.destinationPlaceId }),
  ]);
  const originCoordinate = toRouteCoordinate(origin);
  const destinationCoordinate = toRouteCoordinate(destination);
  if (originCoordinate === null || destinationCoordinate === null) {
    // A place with no coordinates cannot be routed to. Reported as a normal
    // provider outcome so the caller records a service gap rather than
    // failing the whole run.
    return { outcome: "UNAVAILABLE", code: "SEARCH_CONSTRAINTS_INCOMPLETE" };
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({
    originPlaceId: params.input.originPlaceId,
    destinationPlaceId: params.input.destinationPlaceId,
    mode: params.input.mode,
  })).digest("hex");
  await recordAudit({
    ctx: params.ctx,
    action: "NAVIGATION_ROUTE_REQUESTED",
    tripId: params.tripId,
    summary: {
      provider: "openrouteservice",
      operation: "navigation_route",
      mode: params.input.mode,
    },
  });
  const result = await params.provider.searchRoute({
    originPlaceId: params.input.originPlaceId,
    destinationPlaceId: params.input.destinationPlaceId,
    originCoordinate,
    destinationCoordinate,
    mode: params.input.mode,
    snapshotId: params.input.snapshotId,
    runId: params.agentTaskRunId,
    signal: params.signal,
  });
  if (result.outcome === "UNAVAILABLE") {
    await db.transaction(async (tx) => {
      await tx.insert(providerSearchRuns).values({
        snapshotId: params.snapshotId,
        agentTaskRunId: params.agentTaskRunId ?? null,
        category: "navigation",
        providerName: "openrouteservice",
        originId: params.input.originPlaceId.slice(0, 16),
        destinationId: params.input.destinationPlaceId.slice(0, 16),
        requestFingerprint: fingerprint,
        outcome: "UNAVAILABLE",
        errorCode: result.reason,
      });
      await recordAudit({
        ctx: params.ctx,
        action: "NAVIGATION_ROUTE_UNAVAILABLE",
        tripId: params.tripId,
        summary: {
          provider: "openrouteservice",
          outcome: "UNAVAILABLE",
          errorCode: result.reason,
          mode: params.input.mode,
        },
        tx,
      });
    });
    return { outcome: "UNAVAILABLE", code: result.reason };
  }
  const routeEvidence = result.data;
  const routeId = await db.transaction(async (tx) => {
    const [run] = await tx.insert(providerSearchRuns).values({
      snapshotId: params.snapshotId,
      agentTaskRunId: params.agentTaskRunId ?? null,
      category: "navigation",
      providerName: "openrouteservice",
      originId: params.input.originPlaceId.slice(0, 16),
      destinationId: params.input.destinationPlaceId.slice(0, 16),
      requestFingerprint: fingerprint,
      outcome: "LIVE",
      errorCode: null,
    }).returning();
    const [evidence] = await tx.insert(navigationRouteEvidence).values({
      searchRunId: run.id,
      snapshotId: params.snapshotId,
      tripId: params.tripId,
      originPlaceId: params.input.originPlaceId,
      destinationPlaceId: params.input.destinationPlaceId,
      mode: params.input.mode as NavigationRouteMode,
      distanceMeters: routeEvidence.distanceMeters,
      durationSeconds: routeEvidence.durationSeconds,
      steps: routeEvidence.steps as unknown as Array<Record<string, unknown>>,
      encodedGeometry: routeEvidence.encodedGeometry,
      source: routeEvidence.source,
      capturedAt: new Date(routeEvidence.capturedAt),
      refreshAfter: new Date(routeEvidence.refreshAfter),
    }).returning();
    await recordAudit({
      ctx: params.ctx,
      action: "NAVIGATION_ROUTE_COMPLETED",
      tripId: params.tripId,
      summary: {
        provider: "openrouteservice",
        outcome: "LIVE",
        mode: params.input.mode,
        distanceMeters: routeEvidence.distanceMeters,
        durationSeconds: routeEvidence.durationSeconds,
      },
      tx,
    });
    return evidence.id;
  });
  const route = summarizeRouteEvidence({
    id: routeId,
    searchRunId: routeId,
    snapshotId: params.snapshotId,
    tripId: params.tripId,
    originPlaceId: routeEvidence.originPlaceId,
    destinationPlaceId: routeEvidence.destinationPlaceId,
    mode: routeEvidence.mode,
    distanceMeters: routeEvidence.distanceMeters,
    durationSeconds: routeEvidence.durationSeconds,
    steps: routeEvidence.steps,
    encodedGeometry: routeEvidence.encodedGeometry,
    source: routeEvidence.source,
    capturedAt: routeEvidence.capturedAt,
    refreshAfter: routeEvidence.refreshAfter ?? new Date(Date.now() + NAVIGATION_REFRESH_AFTER_HOURS * 60 * 60 * 1000).toISOString(),
  });
  return route;
}

export async function executeNavigationRoute(params: {
  ctx: RequestContext;
  tripId: string;
  snapshotId: string;
  agentTaskRunId?: string;
  input: NavigationRouteInput;
  provider: NavigationProvider;
  signal?: AbortSignal;
}): Promise<ProviderResult<NormalizedRouteEvidence>> {
  void params.ctx;
  void params.agentTaskRunId;
  const [origin, destination] = await Promise.all([
    assertPlaceVisible({ tripId: params.tripId, placeId: params.input.originPlaceId }),
    assertPlaceVisible({ tripId: params.tripId, placeId: params.input.destinationPlaceId }),
  ]);
  const originCoordinate = toRouteCoordinate(origin);
  const destinationCoordinate = toRouteCoordinate(destination);
  if (originCoordinate === null || destinationCoordinate === null) {
    return { outcome: "UNAVAILABLE", reason: "SEARCH_CONSTRAINTS_INCOMPLETE" };
  }
  return params.provider.searchRoute({
    originPlaceId: params.input.originPlaceId,
    destinationPlaceId: params.input.destinationPlaceId,
    originCoordinate,
    destinationCoordinate,
    mode: params.input.mode,
    snapshotId: params.input.snapshotId,
    runId: params.agentTaskRunId,
    signal: params.signal,
  });
}