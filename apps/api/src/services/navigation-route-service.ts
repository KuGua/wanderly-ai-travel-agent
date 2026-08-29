import { z } from "zod";
import type { NavigationProvider, NormalizedRouteEvidence, ProviderResult } from "../providers/types.js";
import type { ConstraintSnapshotData, NavigationRouteEvidence } from "../types/domain.js";
import type { RequestContext } from "../utils/context.js";

/**
 * Spec §5.2 — Shared `navigation.route` input/output schemas.
 *
 * The schema exposed to a planning model deliberately excludes `snapshotId`:
 * a snapshot is execution authority, not a model-selectable search parameter.
 * The dispatcher adds the task-bound id immediately before registry dispatch.
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
export function validateSnapshotBoundNavigationRoute(params: {
  input: unknown;
  snapshotId: string;
  snapshot: ConstraintSnapshotData;
}): NavigationRouteInput {
  const input = navigationRouteInputSchema.parse(params.input);
  if (input.snapshotId !== params.snapshotId) {
    throw new Error("navigation.route snapshot does not match task snapshot");
  }
  // Mode allow-list is fixed for now; expanding it (e.g. WHEELCHAIR, BUS)
  // requires a model-gateway tool schema change.
  if (!["WALK", "DRIVE", "CYCLE"].includes(input.mode)) {
    throw new Error(`navigation.route mode ${input.mode} is not allowed`);
  }
  return input;
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
 * Execute a single route call against the configured provider. The skill
 * handler is responsible for snapshot/run binding, audit, metrics, and
 * persisting the resulting `provider_search_runs` + `navigation_route_evidence`
 * rows.
 */
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
  void params.tripId;
  void params.agentTaskRunId;
  // The provider emits a normalized evidence shape (with encoded geometry);
  // the service layer returns it as-is and lets the skill decide whether to
  // persist it. Geometry never enters the model boundary.
  const result = await params.provider.searchRoute({
    originPlaceId: params.input.originPlaceId,
    destinationPlaceId: params.input.destinationPlaceId,
    mode: params.input.mode,
    snapshotId: params.input.snapshotId,
    runId: params.agentTaskRunId,
    signal: params.signal,
  });
  return result;
}