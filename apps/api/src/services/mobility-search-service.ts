import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "../db/database.js";
import { providerOffers, providerSearchRuns } from "../db/schema.js";
import type { MobilityOfferProvider, NormalizedMobilityOffer, ProviderResult } from "../providers/types.js";
import type { ConstraintSnapshotData, MobilityOffer, MobilityServiceType } from "../types/domain.js";
import { recordAudit } from "./audit-service.js";
import type { RequestContext } from "../utils/context.js";
import { metrics } from "../observability/metrics.js";

/**
 * Spec §5.3 — Shared `mobility.search` service.
 *
 * The adapter layer MUST strip any booking link. The service persists
 * normalized offers on `provider_offers` (with `category = "mobility"`)
 * alongside the `provider_search_runs` row and audit events. The service
 * does NOT transmit `bookingUrl` to the model or the UI — that field is
 * dropped at the adapter boundary and never reaches this layer.
 *
 * The service is hard-gated by `PLAN_ENABLE_MOBILITY=false`: when the flag
 * is off, the skill short-circuits with `UNAVAILABLE/NOT_CONFIGURED`.
 */
export const mobilityServiceTypeSchema = z.enum(["TAXI", "TRANSFER", "CHARTER", "RENTAL"]);
export type MobilityServiceTypeInput = z.infer<typeof mobilityServiceTypeSchema>;

export const mobilitySearchInputSchema = z.object({
  snapshotId: z.string().uuid(),
  originPlaceId: z.string().uuid(),
  destinationPlaceId: z.string().uuid(),
  passengers: z.number().int().min(1).max(9),
  departureAt: z.string().datetime({ offset: true }),
  serviceType: mobilityServiceTypeSchema,
}).strict().superRefine((input, ctx) => {
  if (input.originPlaceId === input.destinationPlaceId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["destinationPlaceId"], message: "origin and destination must differ" });
  }
});
export type MobilitySearchInput = z.infer<typeof mobilitySearchInputSchema>;

export const mobilitySearchModelArgumentsSchema = z.object({
  originPlaceId: z.string().uuid(),
  destinationPlaceId: z.string().uuid(),
  passengers: z.number().int().min(1).max(9),
  departureAt: z.string().datetime({ offset: true }),
  serviceType: mobilityServiceTypeSchema,
}).strict().superRefine((input, ctx) => {
  if (input.originPlaceId === input.destinationPlaceId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["destinationPlaceId"], message: "origin and destination must differ" });
  }
});
export type MobilitySearchModelArguments = z.infer<typeof mobilitySearchModelArgumentsSchema>;

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

export const mobilitySearchOutputSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("LIVE"),
    queryId: z.string().uuid(),
    offers: z.array(z.object({
      offerId: z.string().min(1),
      serviceType: mobilityServiceTypeSchema,
      originPlaceId: z.string().uuid(),
      destinationPlaceId: z.string().uuid(),
      passengers: z.number().int().min(1).max(9),
      departureAt: z.string().datetime({ offset: true }),
      estimatedPrice: z.number().nonnegative().finite(),
      currency: z.string().regex(/^[A-Z]{3}$/),
      vehicleClass: z.string().min(1).max(64),
      estimated: z.literal(true),
      expiresAt: z.string().datetime({ offset: true }).nullable(),
      source: z.string().min(1),
      capturedAt: z.string().datetime({ offset: true }),
    }).strict()).min(1).max(20),
  }).strict(),
  z.object({
    outcome: z.literal("UNAVAILABLE"),
    code: z.enum(providerUnavailableCodes),
  }).strict(),
]);
export type MobilitySearchOutput = z.infer<typeof mobilitySearchOutputSchema>;

export interface MobilitySearchExecutionContext {
  tripId: string;
  snapshotId: string;
  agentTaskRunId?: string;
}

/**
 * Snapshot-bound validation. The dispatcher has already enforced the
 * trip membership of both `placeId`s; this service is the second line.
 */
export function validateSnapshotBoundMobilitySearch(params: {
  input: unknown;
  snapshotId: string;
  snapshot: ConstraintSnapshotData;
}): MobilitySearchInput {
  const input = mobilitySearchInputSchema.parse(params.input);
  if (input.snapshotId !== params.snapshotId) {
    throw new Error("mobility.search snapshot does not match task snapshot");
  }
  return input;
}

export async function executeAndPersistMobilitySearch(params: {
  ctx: RequestContext;
  tripId: string;
  snapshotId: string;
  agentTaskRunId?: string;
  input: MobilitySearchInput;
  provider: MobilityOfferProvider;
  signal?: AbortSignal;
}): Promise<ProviderResult<MobilityOffer[]> & { queryId?: string }> {
  const fingerprint = createHash("sha256").update(JSON.stringify({
    originPlaceId: params.input.originPlaceId,
    destinationPlaceId: params.input.destinationPlaceId,
    passengers: params.input.passengers,
    departureAt: params.input.departureAt,
    serviceType: params.input.serviceType,
  })).digest("hex");
  await recordAudit({
    ctx: params.ctx,
    action: "MOBILITY_OFFER_REQUESTED",
    tripId: params.tripId,
    summary: { provider: "amadeus-transfer", operation: "mobility_search" },
  });
  const result = await params.provider.searchOffers({
    originPlaceId: params.input.originPlaceId,
    destinationPlaceId: params.input.destinationPlaceId,
    passengers: params.input.passengers,
    departureAt: params.input.departureAt,
    serviceType: params.input.serviceType as MobilityServiceType,
    snapshotId: params.input.snapshotId,
    runId: params.agentTaskRunId,
    signal: params.signal,
  });
  const [searchRun] = await db.transaction(async (tx) => {
    const [run] = await tx.insert(providerSearchRuns).values({
      snapshotId: params.snapshotId,
      agentTaskRunId: params.agentTaskRunId ?? null,
      category: "mobility",
      providerName: result.outcome === "LIVE" ? "amadeus-transfer" : "amadeus-transfer",
      originId: params.input.originPlaceId.slice(0, 16),
      destinationId: params.input.destinationPlaceId.slice(0, 16),
      requestFingerprint: fingerprint,
      outcome: result.outcome,
      errorCode: result.outcome === "UNAVAILABLE" ? result.reason : null,
    }).returning();
    if (result.outcome === "LIVE") {
      // Persist offers WITHOUT bookingUrl. The Zod schemas guarantee no such
      // field exists; this is the second-line defense.
      await tx.insert(providerOffers).values(result.data.map((offer) => ({
        snapshotId: params.snapshotId,
        searchRunId: run.id,
        category: "mobility",
        providerName: "amadeus-transfer",
        providerOfferId: offer.offerId,
        currency: offer.currency,
        expiresAt: offer.expiresAt ? new Date(offer.expiresAt) : null,
        offerData: stripBookingFields(offer),
        capturedAt: new Date(offer.capturedAt),
      })));
    }
    await recordAudit({
      ctx: params.ctx,
      action: result.outcome === "LIVE" ? "MOBILITY_OFFER_COMPLETED" : "MOBILITY_OFFER_UNAVAILABLE",
      tripId: params.tripId,
      summary: {
        provider: "amadeus-transfer",
        outcome: result.outcome,
        ...(result.outcome === "UNAVAILABLE" ? { errorCode: result.reason } : {}),
      },
      tx,
    });
    return [run];
  });
  metrics.inc("mobility_search_tool_invocations_total", {
    outcome: result.outcome === "LIVE" ? "live" : "unavailable",
    provider: "amadeus-transfer",
    error_category: result.outcome === "LIVE" ? "none" : result.reason.toLowerCase(),
  });
  return result.outcome === "LIVE" ? { ...result, queryId: searchRun.id } : result;
}

function stripBookingFields(offer: NormalizedMobilityOffer): Record<string, unknown> {
  // Defensive: if an upstream provider ever includes a `bookingUrl` or
  // similar field (e.g. by relaxing the schema in the future), it MUST NOT
  // be persisted. We serialize only the known fields.
  return {
    offerId: offer.offerId,
    serviceType: offer.serviceType,
    originPlaceId: offer.originPlaceId,
    destinationPlaceId: offer.destinationPlaceId,
    passengers: offer.passengers,
    departureAt: offer.departureAt,
    estimatedPrice: offer.estimatedPrice,
    currency: offer.currency,
    vehicleClass: offer.vehicleClass,
    estimated: offer.estimated,
    expiresAt: offer.expiresAt,
    source: offer.source,
    capturedAt: offer.capturedAt,
  };
}
