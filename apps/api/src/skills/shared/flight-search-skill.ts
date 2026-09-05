import { z } from "zod";
import type { Skill, SkillContext } from "../../agents/contracts.js";
import { SkillError } from "../../agents/errors.js";
import { createTravelProviders } from "../../providers/live-provider-factory.js";
import type { FlightProvider } from "../../providers/types.js";
import {
  executeAndPersistFlightSearch,
  flightSearchInputSchema,
  validateSnapshotBoundFlightSearch,
  type FlightSearchInput,
} from "../../services/flight-search-service.js";
import {
  loadCurrentConfirmedSearchPreferences,
  SearchPreferencesStaleError,
} from "../../services/flight-search-preferences-service.js";

// FlightAPI documents departure/arrival values in airport-local time without
// an offset. The value remains explicit local wall-clock time; we must not
// invent a UTC offset. Amadeus offset date-times remain valid as well.
const normalizedFlightDateTimeSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/,
  "Expected an ISO-8601 local or offset date-time",
);

const normalizedFlightOfferSchema = z.object({
  id: z.string().min(1),
  providerOfferId: z.string().min(1),
  providerName: z.string().min(1),
  queryId: z.string().uuid(),
  origin: z.string().length(3),
  destination: z.string().length(3),
  segments: z.array(z.object({
    carrierCode: z.string().min(1),
    flightNumber: z.string().min(1),
    origin: z.string().length(3),
    destination: z.string().length(3),
    departureAt: normalizedFlightDateTimeSchema,
    arrivalAt: normalizedFlightDateTimeSchema,
    duration: z.string().min(1),
  }).strict()).min(1),
  totalDuration: z.string().min(1),
  totalPrice: z.number().nonnegative().finite(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  cabin: z.enum(["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"]),
  adults: z.number().int().min(1).max(9),
  baggageSummary: z.string().nullable(),
  changeSummary: z.string().nullable(),
  source: z.string().min(1),
  capturedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  expiryProvenance: z.enum(["PROVIDER_VERIFIED", "SYNTHETIC"]),
}).strict();

export const flightSearchOutputSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("LIVE"), queryId: z.string().uuid(), offers: z.array(normalizedFlightOfferSchema) }).strict(),
  z.object({
    outcome: z.literal("UNAVAILABLE"),
    code: z.enum([
      "NOT_CONFIGURED", "SEARCH_CONSTRAINTS_INCOMPLETE", "NO_RESULTS", "RATE_LIMITED", "UPSTREAM_TIMEOUT",
      "UPSTREAM_FAILURE", "INVALID_PROVIDER_RESPONSE", "PROVIDER_NOT_APPROVED",
      "PROVIDER_REQUEST_REJECTED",
    ]),
  }).strict(),
]);

export type FlightSearchOutput = z.infer<typeof flightSearchOutputSchema>;

export function createFlightSearchSkill(provider: FlightProvider): Skill<FlightSearchInput, FlightSearchOutput> {
  return {
    name: "flight.search",
    agent: "shared",
    version: "1.0.0",
    allowedTools: ["snapshot:read", "flight:search"],
    timeoutMs: 12_000,
    needsConfirm: false,
    input: flightSearchInputSchema,
    output: flightSearchOutputSchema,
    async handler(ctx, input, signal) {
      return executeFlightSearchSkill(ctx, input, signal, provider);
    },
  };
}

async function executeFlightSearchSkill(
  ctx: SkillContext,
  input: FlightSearchInput,
  signal: AbortSignal,
  provider: FlightProvider,
): Promise<FlightSearchOutput> {
  if (!ctx.snapshot || !ctx.flightSearch) {
    throw new SkillError("POLICY_DENIED", "flight.search requires an authorized Shared planning execution context");
  }
  if (input.snapshotId !== ctx.flightSearch.snapshotId) {
    throw new SkillError("POLICY_DENIED", "flight.search snapshot is not authorized for this execution");
  }
  let currentPreferences;
  try {
    currentPreferences = await loadCurrentConfirmedSearchPreferences({
      tripId: ctx.flightSearch.tripId,
      version: ctx.flightSearch.searchPreferencesVersion,
    });
  } catch (error) {
    if (error instanceof SearchPreferencesStaleError) {
      throw new SkillError("SEARCH_PREFERENCES_STALE", error.message);
    }
    throw error;
  }
  const executionPreferences = ctx.flightSearch.searchPreferences;
  if (currentPreferences.tripType !== executionPreferences.tripType
    || currentPreferences.adults !== executionPreferences.adults
    || currentPreferences.cabin !== executionPreferences.cabin
    || currentPreferences.currency !== executionPreferences.currency) {
    throw new SkillError("SEARCH_PREFERENCES_STALE", "Confirmed flight search preferences changed after planning execution started");
  }
  let validated: FlightSearchInput;
  try {
    validated = validateSnapshotBoundFlightSearch({
      input,
      snapshotId: ctx.flightSearch.snapshotId,
      snapshot: ctx.snapshot,
      preferences: executionPreferences,
    });
  } catch (error) {
    throw new SkillError("POLICY_DENIED", `flight.search constraints rejected: ${(error as Error).message}`);
  }
  const result = await executeAndPersistFlightSearch({
    ctx: ctx.ctx,
    tripId: ctx.flightSearch.tripId,
    snapshotId: ctx.flightSearch.snapshotId,
    agentTaskRunId: ctx.flightSearch.agentTaskRunId,
    input: validated,
    provider,
    signal,
  });
  return result.outcome === "LIVE"
    ? { outcome: "LIVE", queryId: result.queryId!, offers: result.data }
    : { outcome: "UNAVAILABLE", code: result.reason };
}

export const flightSearchSkill = createFlightSearchSkill(createTravelProviders().flightProvider);
