import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "../db/database.js";
import { providerOffers, providerSearchRuns } from "../db/schema.js";
import { resolveAirportReference } from "../location-reference/airport-reference.js";
import type { FlightOffer } from "../types/domain.js";
import type { FlightProvider, ProviderResult } from "../providers/types.js";
import type { ConstraintSnapshotData } from "../types/domain.js";
import { recordAudit } from "./audit-service.js";
import type { RequestContext } from "../utils/context.js";
import { metrics } from "../observability/metrics.js";
import { logSafeRuntimeEvent, type SafeRuntimeEvent } from "../observability/telemetry.js";

export const flightSearchInputSchema = z.object({
  snapshotId: z.string().uuid(),
  originId: z.string().min(1).max(16),
  destinationId: z.string().min(1).max(16),
  tripType: z.enum(["ONE_WAY", "ROUND_TRIP"]),
  departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  adults: z.number().int().min(1).max(9),
  cabin: z.enum(["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"]),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict().superRefine((input, ctx) => {
  if (input.tripType === "ROUND_TRIP" && !input.returnDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["returnDate"], message: "returnDate is required for ROUND_TRIP" });
  }
  if (input.tripType === "ONE_WAY" && input.returnDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["returnDate"], message: "returnDate is not allowed for ONE_WAY" });
  }
  if (input.returnDate && input.returnDate < input.departureDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["returnDate"], message: "returnDate must not precede departureDate" });
  }
});

export type FlightSearchInput = z.infer<typeof flightSearchInputSchema>;
/**
 * This is the *model-facing* contract, not the registered Skill contract.
 * The model may select a controlled route, but it must never supply dates,
 * passenger counts, cabin, currency, or a snapshot id.  Those values are
 * bound from the immutable planning execution context immediately before the
 * full `flight.search` Skill is invoked.
 */
export const flightSearchModelArgumentsSchema = z.object({
  originId: z.string().min(1).max(16),
  destinationId: z.string().min(1).max(16),
}).strict();
export type FlightSearchModelArguments = z.infer<typeof flightSearchModelArgumentsSchema>;
export type ConfirmedFlightSearchPreferences = Pick<FlightSearchInput, "tripType" | "adults" | "cabin" | "currency">;

export function validateSnapshotBoundFlightSearch(params: {
  input: unknown;
  snapshotId: string;
  snapshot: ConstraintSnapshotData;
  preferences: ConfirmedFlightSearchPreferences;
}): FlightSearchInput {
  const input = flightSearchInputSchema.parse(params.input);
  if (input.snapshotId !== params.snapshotId) throw new Error("flight search snapshot does not match task snapshot");
  const origin = resolveAirportReference(input.originId);
  const destination = resolveAirportReference(input.destinationId);
  if (!origin || !destination) throw new Error("flight search airport is not controlled");
  if (!params.snapshot.destinationCandidates.includes(input.destinationId)) {
    throw new Error("flight search destination is not in snapshot candidates");
  }
  if (input.departureDate !== params.snapshot.travelDateStart
    || (input.tripType === "ROUND_TRIP" && input.returnDate !== params.snapshot.travelDateEnd)) {
    throw new Error("flight search dates do not match snapshot");
  }
  if (input.tripType !== params.preferences.tripType
    || input.adults !== params.preferences.adults
    || input.cabin !== params.preferences.cabin
    || input.currency !== params.preferences.currency) {
    throw new Error("flight search parameters do not match confirmed preferences");
  }
  return input;
}

/** Persist only normalized successful evidence or the stable unavailable code. */
export async function executeAndPersistFlightSearch(params: {
  ctx: RequestContext;
  tripId: string;
  snapshotId: string;
  agentTaskRunId?: string;
  input: FlightSearchInput;
  provider: FlightProvider;
  signal?: AbortSignal;
}): Promise<ProviderResult<FlightOffer[]> & { queryId?: string }> {
  // Test-only legacy doubles may predate the provider identity field. Runtime
  // adapters always declare it; the fallback remains fail-closed and never
  // guesses another live provider.
  const providerName = params.provider.providerName ?? "unconfigured";
  const fingerprint = createHash("sha256").update(JSON.stringify({
    originId: params.input.originId,
    destinationId: params.input.destinationId,
    tripType: params.input.tripType,
    departureDate: params.input.departureDate,
    returnDate: params.input.returnDate ?? null,
    adults: params.input.adults,
    cabin: params.input.cabin,
    currency: params.input.currency,
  })).digest("hex");
  await recordAudit({
    ctx: params.ctx, action: "FLIGHT_SEARCH_REQUESTED", tripId: params.tripId,
    summary: { provider: providerName, operation: "flight_search" },
  });
  const origin = resolveAirportReference(params.input.originId)!;
  const destination = resolveAirportReference(params.input.destinationId)!;
  // Local-debug lifecycle records. Bounded fields only: provider identity,
  // controlled route ids, normalized outcome, offer count and duration. The
  // supplier URL, key, raw payload and raw error never reach this layer.
  const providerLogFields = {
    component: "tool",
    event: "provider_search",
    operation: "flight.search",
    toolName: "flight.search",
    provider: providerName,
    originId: params.input.originId,
    destinationId: params.input.destinationId,
    relatedRunId: params.agentTaskRunId,
    relatedSnapshotId: params.snapshotId,
  } satisfies Partial<SafeRuntimeEvent>;
  logSafeRuntimeEvent(params.ctx, { ...providerLogFields, outcome: "started" });
  const startedAt = Date.now();
  const result = await params.provider.searchFlights({
    origin: origin.iataCode,
    destination: destination.iataCode,
    dateStart: params.input.departureDate,
    dateEnd: params.input.returnDate ?? params.input.departureDate,
    snapshotId: params.snapshotId,
    tripType: params.input.tripType,
    adults: params.input.adults,
    cabin: params.input.cabin,
    currency: params.input.currency,
    signal: params.signal,
  });
  const [searchRun] = await db.transaction(async (tx) => {
    const [run] = await tx.insert(providerSearchRuns).values({
      snapshotId: params.snapshotId,
      agentTaskRunId: params.agentTaskRunId ?? null,
      category: "flight",
      providerName,
      originId: params.input.originId,
      destinationId: params.input.destinationId,
      requestFingerprint: fingerprint,
      outcome: result.outcome,
      errorCode: result.outcome === "UNAVAILABLE" ? result.reason : null,
    }).returning();
    if (result.outcome === "LIVE") {
      await tx.insert(providerOffers).values(result.data.map((offer) => ({
        snapshotId: params.snapshotId,
        searchRunId: run.id,
        category: "flight",
        providerName: offer.providerName,
        providerOfferId: offer.providerOfferId,
        currency: offer.currency,
        expiresAt: new Date(offer.expiresAt),
        offerData: offer as unknown as Record<string, unknown>,
        capturedAt: new Date(offer.capturedAt),
      })));
    }
    await recordAudit({
      ctx: params.ctx,
      action: result.outcome === "LIVE" ? "FLIGHT_SEARCH_COMPLETED" : "FLIGHT_SEARCH_UNAVAILABLE",
      tripId: params.tripId,
      summary: { provider: providerName, outcome: result.outcome, ...(result.outcome === "UNAVAILABLE" ? { errorCode: result.reason } : {}) },
      tx,
    });
    return [run];
  });
  metrics.inc("flight_tool_invocations_total", {
    outcome: result.outcome === "LIVE" ? "live" : "unavailable",
    provider: providerName,
    error_category: result.outcome === "LIVE" ? "none" : result.reason.toLowerCase(),
  });
  logSafeRuntimeEvent(params.ctx, {
    ...providerLogFields,
    outcome: result.outcome === "LIVE" ? "success" : "failure",
    providerStatus: result.outcome,
    latencyMs: Date.now() - startedAt,
    ...(result.outcome === "LIVE"
      ? { itemCount: result.data.length }
      : { errorCode: result.reason }),
  });
  return result.outcome === "LIVE" ? { ...result, queryId: searchRun.id } : result;
}
