import { z } from "zod";
import type { MobilityOfferProvider, ProviderResult } from "../providers/types.js";
import type { ConstraintSnapshotData, MobilityOffer, MobilityServiceType } from "../types/domain.js";
import type { RequestContext } from "../utils/context.js";

/**
 * Spec §5.3 — Shared `mobility.search` input/output schemas.
 *
 * The schema exposed to a planning model deliberately excludes `snapshotId`:
 * a snapshot is execution authority, not a model-selectable search parameter.
 * The dispatcher adds the task-bound id immediately before registry dispatch.
 *
 * Invariants enforced here:
 *   * `passengers`, `departureAt`, and `serviceType` are accepted but
 *     server-derived (or strong-bounded) values. They never come from
 *     arbitrary user text.
 *   * The adapter layer MUST drop any `bookingUrl` field before persistence;
 *     this service returns normalized offers that do not carry it.
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

// Model-facing schema mirrors the input minus the server-injected snapshotId.
// Defined as a standalone schema (not `.omit(...)`) because Zod 4 forbids
// `.omit()` on schemas that carry a `.superRefine`.
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
}): Promise<ProviderResult<MobilityOffer[]>> {
  void params.ctx;
  void params.tripId;
  void params.agentTaskRunId;
  return params.provider.searchOffers({
    originPlaceId: params.input.originPlaceId,
    destinationPlaceId: params.input.destinationPlaceId,
    passengers: params.input.passengers,
    departureAt: params.input.departureAt,
    serviceType: params.input.serviceType as MobilityServiceType,
    snapshotId: params.input.snapshotId,
    runId: params.agentTaskRunId,
    signal: params.signal,
  });
}