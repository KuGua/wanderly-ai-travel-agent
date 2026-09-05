import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "../db/database.js";
import { providerSearchRuns } from "../db/schema.js";
import type { PlaceSearchProvider, ProviderResult } from "../providers/types.js";
import type { ConstraintSnapshotData, PlaceCandidate } from "../types/domain.js";
import { recordAudit } from "./audit-service.js";
import type { RequestContext } from "../utils/context.js";
import { metrics } from "../observability/metrics.js";
import { resolveTripDestinationReference } from "./destination-reference-service.js";

/**
 * Spec §5.1 — Shared `places.search` input/output schemas.
 *
 * The schema exposed to a planning model deliberately excludes `snapshotId`:
 * a snapshot is execution authority, not a model-selectable search parameter.
 * The dispatcher adds the task-bound id immediately before registry dispatch.
 */
export const placeSearchInputSchema = z.object({
  snapshotId: z.string().uuid(),
  destinationId: z.string().min(1).max(64),
  keyword: z.string().min(1).max(160),
  category: z.enum(["ATTRACTION", "HOTEL", "RESTAURANT", "TRANSPORT_HUB", "OTHER"]),
}).strict();

export type PlaceSearchInput = z.infer<typeof placeSearchInputSchema>;

export const placeSearchModelArgumentsSchema = z.object({
  destinationId: z.string().min(1).max(64),
  keyword: z.string().min(1).max(160),
  category: z.enum(["ATTRACTION", "HOTEL", "RESTAURANT", "TRANSPORT_HUB", "OTHER"]),
}).strict();
export type PlaceSearchModelArguments = z.infer<typeof placeSearchModelArgumentsSchema>;

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

export const placeSearchOutputSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("LIVE"),
    queryId: z.string().uuid(),
    candidates: z.array(z.object({
      candidateId: z.string().uuid(),
      displayName: z.string().min(1).max(256),
      kind: z.enum(["ATTRACTION", "HOTEL", "RESTAURANT", "TRANSPORT_HUB", "OTHER"]),
      countryCode: z.string().length(2).nullable(),
      cityName: z.string().min(1).max(128).nullable(),
      longitude: z.number().finite().min(-180).max(180),
      latitude: z.number().finite().min(-90).max(90),
      confidence: z.number().min(0).max(1),
      needsUserConfirmation: z.boolean(),
      source: z.string().min(1),
      capturedAt: z.string().datetime({ offset: true }),
    }).strict()).min(1).max(5),
  }).strict(),
  z.object({
    outcome: z.literal("UNAVAILABLE"),
    code: z.enum(providerUnavailableCodes),
  }).strict(),
]);
export type PlaceSearchOutput = z.infer<typeof placeSearchOutputSchema>;

export interface PlaceSearchExecutionContext {
  tripId: string;
  snapshotId: string;
  agentTaskRunId?: string;
}

/**
 * Server-side result cap, per `docs/ground-mobility-implementation.md` §7
 * ("限制每次最多 5 个结果") and the `places.search` skill contract
 * ("1..5 candidates"). It is enforced here rather than in a provider
 * because it is a contract of this service: both place providers in the
 * repo return up to 10, and the skill's output schema caps at 5, so an
 * untrimmed 6..10-candidate answer failed output validation *after* the
 * search had already succeeded and been persisted — surfacing to the
 * traveller as a provider outage. This constant existed for exactly this
 * job and was never referenced.
 */
export const PLACE_SEARCH_MAX_RESULTS = 5;
export const PLACE_SEARCH_MAX_PER_RUN = 6;

/**
 * Snapshot-bound validation:
 *   * the input `destinationId` MUST be in `snapshot.destinationCandidates`
 *   * the `keyword` MUST NOT contain `privateConversation` markers (the
 *     service caller is responsible for stripping private chat text before
 *     the model sees it; this is the defensive second-line check)
 */
export function validateSnapshotBoundPlaceSearch(params: {
  input: unknown;
  snapshotId: string;
  snapshot: ConstraintSnapshotData;
}): PlaceSearchInput {
  const input = placeSearchInputSchema.parse(params.input);
  if (input.snapshotId !== params.snapshotId) {
    throw new Error("place search snapshot does not match task snapshot");
  }
  if (!params.snapshot.destinationCandidates.includes(input.destinationId)) {
    throw new Error("place search destination is not in snapshot candidates");
  }
  if (/\b(private|owner-only|do-not-share)\b/i.test(input.keyword)) {
    throw new Error("place search keyword carries private markers");
  }
  return input;
}

/**
 * Execute a single place search and persist a `provider_search_runs` row +
 * audit row in one transaction. Returns the stable normalized output shape.
 *
 * The caller (skill handler) is responsible for enforcing the per-run
 * invocation cap (`PLACE_SEARCH_MAX_PER_RUN`) BEFORE calling this function —
 * keeping the cap check at the boundary makes it easy for tests and for the
 * model-gateway tool dispatcher to short-circuit.
 */
export async function executeAndPersistPlaceSearch(params: {
  ctx: RequestContext;
  tripId: string;
  snapshotId: string;
  agentTaskRunId?: string;
  input: PlaceSearchInput;
  provider: PlaceSearchProvider;
  resolveDestinationReference?: typeof resolveTripDestinationReference;
  signal?: AbortSignal;
}): Promise<ProviderResult<PlaceCandidate[]> & { queryId?: string }> {
  const fingerprint = createHash("sha256").update(JSON.stringify({
    destinationId: params.input.destinationId,
    keyword: params.input.keyword,
    category: params.input.category,
  })).digest("hex");
  await recordAudit({
    ctx: params.ctx,
    action: "PLACE_SEARCH_REQUESTED",
    tripId: params.tripId,
    summary: { provider: "openrouteservice", operation: "place_search" },
  });
  const destination = await (params.resolveDestinationReference ?? resolveTripDestinationReference)({
    tripId: params.tripId,
    destinationId: params.input.destinationId,
  });
  const result = destination ? await params.provider.searchPlaces({
    destination,
    keyword: params.input.keyword,
    category: params.input.category,
    snapshotId: params.input.snapshotId,
    runId: params.agentTaskRunId,
    signal: params.signal,
  }) : { outcome: "UNAVAILABLE" as const, reason: "SEARCH_CONSTRAINTS_INCOMPLETE" as const };
  const [searchRun] = await db.transaction(async (tx) => {
    const [run] = await tx.insert(providerSearchRuns).values({
      snapshotId: params.snapshotId,
      agentTaskRunId: params.agentTaskRunId ?? null,
      category: "place",
      providerName: result.outcome === "LIVE" ? "openrouteservice" : "openrouteservice",
      originId: null,
      destinationId: params.input.destinationId.slice(0, 16),
      requestFingerprint: fingerprint,
      outcome: result.outcome,
      errorCode: result.outcome === "UNAVAILABLE" ? result.reason : null,
    }).returning();
    await recordAudit({
      ctx: params.ctx,
      action: result.outcome === "LIVE" ? "PLACE_SEARCH_COMPLETED" : "PLACE_SEARCH_UNAVAILABLE",
      tripId: params.tripId,
      summary: {
        provider: "openrouteservice",
        outcome: result.outcome,
        ...(result.outcome === "UNAVAILABLE" ? { errorCode: result.reason } : {}),
      },
      tx,
    });
    return [run];
  });
  metrics.inc("place_search_tool_invocations_total", {
    outcome: result.outcome === "LIVE" ? "live" : "unavailable",
    provider: "openrouteservice",
    error_category: result.outcome === "LIVE" ? "none" : result.reason.toLowerCase(),
  });
  // Trim after persistence, not before: `provider_search_runs` keeps what the
  // supplier actually answered, while every caller of this service (skill and
  // model-gateway tool dispatch alike) sees the contracted bound.
  return result.outcome === "LIVE"
    ? { ...result, data: result.data.slice(0, PLACE_SEARCH_MAX_RESULTS), queryId: searchRun.id }
    : result;
}
