import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/database.js";
import { providerOffers, providerSearchRuns } from "../db/schema.js";
import { airportServesCity, resolveAirportReference } from "../location-reference/airport-reference.js";
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
  // Matched against the airport's id or its city, because the two callers
  // disagree about what a candidate is: real snapshots hold city names
  // ("Tokyo"), written by the traveller's confirmed brief, while this
  // function's own tests hold airport codes ("NRT"). Comparing `destinationId`
  // against city names alone made this check and the controlled-airport check
  // above mutually exclusive — any value passing one failed the other, so no
  // flight search could ever be valid, and every planning run died here.
  // A candidate matches either as the airport id itself or as any spelling of
  // the city that airport serves — the confirmed brief keeps whatever the
  // traveller wrote, so "东京" and "Tokyo" both have to reach NRT.
  const inSnapshot = params.snapshot.destinationCandidates.some(
    (candidate) => candidate.trim().toLowerCase() === destination.id.toLowerCase()
      || airportServesCity(destination, candidate),
  );
  if (!inSnapshot) {
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
/**
 * One exact flight request may run once per planning run. Mirrors the guard
 * every sibling search service already had; flight was the one that did not,
 * and paid for the duplicate before failing on the unique index.
 */
export class FlightSearchAlreadyAttemptedError extends Error {
  constructor() {
    super("flight.search may run only once per exact request in a planning run");
    this.name = "FlightSearchAlreadyAttemptedError";
  }
}

/** A LIVE provider result must carry at least one citable normalized offer. */
export function normalizeFlightProviderResult(
  result: ProviderResult<FlightOffer[]>,
): ProviderResult<FlightOffer[]> {
  return result.outcome === "LIVE" && result.data.length === 0
    ? { outcome: "UNAVAILABLE", reason: "NO_RESULTS" }
    : result;
}

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
  // Reserve the cell before spending anything, the way every sibling search
  // service does. This service inserted its row *after* the supplier answered,
  // so an identical request inside one run paid for a second search and then
  // died on the unique index — as a raw Postgres error, which classified as
  // UNCLASSIFIED and reached the model as UPSTREAM_FAILURE. A flight cell that
  // had just come back LIVE looked broken, and the model retried it. Reserving
  // first turns that into a typed refusal before a supplier is touched.
  const [reservedRun] = await db.insert(providerSearchRuns).values({
    snapshotId: params.snapshotId,
    agentTaskRunId: params.agentTaskRunId ?? null,
    category: "flight",
    providerName,
    originId: params.input.originId,
    destinationId: params.input.destinationId,
    requestFingerprint: fingerprint,
    outcome: "PENDING",
  }).onConflictDoNothing().returning();
  if (!reservedRun) throw new FlightSearchAlreadyAttemptedError();

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
  const providerResult = await params.provider.searchFlights({
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
  // `LIVE` means there is at least one citable supplier fact. Recording an
  // empty array as LIVE made the research matrix claim success while the plan
  // had no flight evidence to select. Normalize that contradictory provider
  // shape at the service boundary and fail closed as NO_RESULTS.
  const result = normalizeFlightProviderResult(providerResult);
  const [searchRun] = await db.transaction(async (tx) => {
    const [run] = await tx.update(providerSearchRuns).set({
      outcome: result.outcome,
      errorCode: result.outcome === "UNAVAILABLE" ? result.reason : null,
    }).where(eq(providerSearchRuns.id, reservedRun.id)).returning();
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
