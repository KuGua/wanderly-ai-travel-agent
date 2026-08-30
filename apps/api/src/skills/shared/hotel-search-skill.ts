import { z } from "zod";

import type { Skill } from "../../agents/contracts.js";
import { SkillError } from "../../agents/errors.js";
import { createTravelProviders } from "../../providers/live-provider-factory.js";
import type { HotelProvider } from "../../providers/types.js";
import { executeAndPersistHotelSearch, HotelSearchAlreadyAttemptedError, hotelOfferSchema, hotelSearchInputSchema, validateSnapshotBoundHotelSearch, type HotelSearchInput } from "../../services/hotel-search-service.js";

export const hotelSearchOutputSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("LIVE"), queryId: z.string().uuid(), hotels: z.array(hotelOfferSchema).min(1).max(10) }).strict(),
  z.object({ outcome: z.literal("UNAVAILABLE"), code: z.enum([
    "NOT_CONFIGURED", "SEARCH_CONSTRAINTS_INCOMPLETE", "NO_RESULTS", "RATE_LIMITED",
    "UPSTREAM_TIMEOUT", "UPSTREAM_FAILURE", "INVALID_PROVIDER_RESPONSE", "PROVIDER_NOT_APPROVED",
  ]) }).strict(),
]);
export type HotelSearchOutput = z.infer<typeof hotelSearchOutputSchema>;

export function createHotelSearchSkill(provider: HotelProvider): Skill<HotelSearchInput, HotelSearchOutput> {
  return {
    name: "hotel.search", agent: "shared", version: "1.0.0",
    allowedTools: ["snapshot:read", "hotel:search"], timeoutMs: 15_000, needsConfirm: false,
    input: hotelSearchInputSchema, output: hotelSearchOutputSchema,
    async handler(ctx, input, signal) {
      if (!ctx.snapshot || !ctx.hotelSearch) throw new SkillError("POLICY_DENIED", "hotel.search requires an authorized Shared planning context");
      let validated: HotelSearchInput;
      try {
        validated = validateSnapshotBoundHotelSearch({ input, snapshotId: ctx.hotelSearch.snapshotId, snapshot: ctx.snapshot });
      } catch (error) {
        throw new SkillError("POLICY_DENIED", `hotel.search constraints rejected: ${(error as Error).message}`);
      }
      let result;
      try {
        result = await executeAndPersistHotelSearch({
          ctx: ctx.ctx, tripId: ctx.hotelSearch.tripId, snapshotId: ctx.hotelSearch.snapshotId,
          agentTaskRunId: ctx.hotelSearch.agentTaskRunId, snapshot: ctx.snapshot,
          preferences: ctx.hotelSearch.searchPreferences, locale: ctx.hotelSearch.locale,
          input: validated, provider, signal,
        });
      } catch (error) {
        if (error instanceof HotelSearchAlreadyAttemptedError) throw new SkillError("POLICY_DENIED", error.message);
        throw error;
      }
      return result.outcome === "LIVE"
        ? { outcome: "LIVE", queryId: result.queryId!, hotels: result.data }
        : { outcome: "UNAVAILABLE", code: result.reason };
    },
  };
}

export const hotelSearchSkill = createHotelSearchSkill(createTravelProviders().hotelProvider);
