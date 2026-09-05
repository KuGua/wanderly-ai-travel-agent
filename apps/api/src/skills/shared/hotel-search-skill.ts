import { z } from "zod";

import type { Skill } from "../../agents/contracts.js";
import { SkillError } from "../../agents/errors.js";
import type { HotelOffer } from "../../types/domain.js";
import {
  executeAndPersistHotelSearch,
  HotelSearchAlreadyAttemptedError,
  hotelOfferSchema,
  hotelSearchInputSchema,
  validateSnapshotBoundHotelSearch,
  type HotelSearchInput,
} from "../../services/hotel-search-service.js";
import { loadActiveQuoteNationality } from "../../services/stay-search-provider-authorization.js";

export const hotelSearchOutputSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("LIVE"), queryId: z.string().uuid(), hotels: z.array(hotelOfferSchema).min(1).max(10) }).strict(),
  z.object({ outcome: z.literal("UNAVAILABLE"), code: z.enum([
    "NOT_CONFIGURED", "SEARCH_CONSTRAINTS_INCOMPLETE", "NO_RESULTS", "RATE_LIMITED",
    "UPSTREAM_TIMEOUT", "UPSTREAM_FAILURE", "INVALID_PROVIDER_RESPONSE", "PROVIDER_NOT_APPROVED",
    "PROVIDER_REQUEST_REJECTED",
  ]) }).strict(),
]);
export type HotelSearchOutput = z.infer<typeof hotelSearchOutputSchema>;

export interface HotelSearchHandlerDeps {
  /** Adapter instance resolved at task acceptance. Spec §3.1. */
  provider: import("../../providers/types.js").HotelProvider;
  /** Injected for tests; defaults to the live service. */
  loadQuoteNationality?: typeof loadActiveQuoteNationality;
  now?: () => Date;
}

/**
 * Shared hotel search handler. The planner service invokes this with the
 * per-task `provider` carried in `HotelSearchExecutionContext.providerAdapter`.
 * The legacy module-level singleton is gone: switching `HOTEL_PROVIDER`
 * after acceptance cannot reroute an in-flight task.
 *
 * Spec §3.1, §3.4, §4.1.
 */
export async function handleHotelSearch(
  ctx: import("../../agents/contracts.js").SkillContext,
  input: HotelSearchInput,
  deps: HotelSearchHandlerDeps,
  signal: AbortSignal,
): Promise<HotelSearchOutput> {
  if (!ctx.snapshot || !ctx.hotelSearch) {
    throw new SkillError("POLICY_DENIED", "hotel.search requires an authorized Shared planning context");
  }
  const exec = ctx.hotelSearch;
  if (exec.providerAdapter.providerName !== exec.provider) {
    throw new SkillError("POLICY_DENIED", "hotel.search provider binding does not match the task-bound adapter");
  }
  let validated: HotelSearchInput;
  try {
    validated = validateSnapshotBoundHotelSearch({ input, snapshotId: exec.snapshotId, snapshot: ctx.snapshot });
  } catch (error) {
    throw new SkillError("POLICY_DENIED", `hotel.search constraints rejected: ${(error as Error).message}`);
  }

  let quoteNationality: string | undefined;
  if (exec.provider === "nuitee_connect") {
    if (!exec.quoteNationalityAuthorization) {
      throw new SkillError("POLICY_DENIED", "hotel.search requires a confirmed quote nationality authorization for nuitee_connect");
    }
    const memberId = ctx.ctx.actorUserId;
    if (!memberId) {
      throw new SkillError("POLICY_DENIED", "hotel.search requires an authenticated actor");
    }
    const loaded = await (deps.loadQuoteNationality ?? loadActiveQuoteNationality)({
      tripId: exec.tripId,
      memberId,
      ...(deps.now ? { now: deps.now() } : {}),
    });
    if (!loaded
      || loaded.id !== exec.quoteNationalityAuthorization.id
      || loaded.version !== exec.quoteNationalityAuthorization.version) {
      throw new SkillError("POLICY_DENIED", "hotel.search quote nationality authorization is missing, expired, or superseded");
    }
    quoteNationality = loaded.nationality;
  }

  let result: import("../../providers/types.js").ProviderResult<HotelOffer[]> & { queryId?: string };
  try {
    result = await executeAndPersistHotelSearch({
      ctx: ctx.ctx,
      tripId: exec.tripId,
      snapshotId: exec.snapshotId,
      agentTaskRunId: exec.agentTaskRunId,
      snapshot: ctx.snapshot,
      preferences: exec.searchPreferences,
      locale: exec.locale,
      input: validated,
      provider: deps.provider,
      ...(quoteNationality ? { quoteNationality } : {}),
      ...(exec.quoteNationalityAuthorization ? { quoteAuthorization: exec.quoteNationalityAuthorization } : {}),
      signal,
    });
  } catch (error) {
    if (error instanceof HotelSearchAlreadyAttemptedError) throw new SkillError("POLICY_DENIED", error.message);
    throw error;
  }
  return result.outcome === "LIVE"
    ? { outcome: "LIVE", queryId: result.queryId!, hotels: result.data }
    : { outcome: "UNAVAILABLE", code: result.reason };
}

// ─── Legacy compatibility ──────────────────────────────────────────────────
//
// The registered handler intentionally consumes the task-bound adapter from
// SkillContext. It must never read HOTEL_PROVIDER itself: that would allow a
// deployment config change to reroute an in-flight durable task.
export const hotelSearchSkill: Skill<HotelSearchInput, HotelSearchOutput> = {
  name: "hotel.search",
  agent: "shared",
  version: "1.0.0",
  allowedTools: ["snapshot:read", "hotel:search"],
  timeoutMs: 15_000,
  needsConfirm: false,
  input: hotelSearchInputSchema,
  output: hotelSearchOutputSchema,
  async handler(ctx, input, signal) {
    if (!ctx.hotelSearch) throw new SkillError("POLICY_DENIED", "hotel.search requires a task-bound hotel context");
    return handleHotelSearch(ctx, input, {
      provider: ctx.hotelSearch.providerAdapter,
      loadQuoteNationality: loadActiveQuoteNationality,
    }, signal);
  },
};
