import type { Skill, SkillContext } from "../../agents/contracts.js";
import { SkillError } from "../../agents/errors.js";
import { createTravelProviders } from "../../providers/live-provider-factory.js";
import type { MobilityOfferProvider } from "../../providers/types.js";
import {
  executeAndPersistMobilitySearch,
  mobilitySearchInputSchema,
  mobilitySearchOutputSchema,
  type MobilitySearchInput,
  type MobilitySearchOutput,
  validateSnapshotBoundMobilitySearch,
} from "../../services/mobility-search-service.js";

/**
 * Spec §5.3 — Shared `mobility.search` skill.
 *
 * Returns pricing/fare estimates for taxi / private transfer / charter /
 * car rental between two authorized `placeId`s. The model never sees a
 * booking link — the adapter layer drops `bookingUrl` before persistence.
 *
 * Hard-gated by `PLAN_ENABLE_MOBILITY=false` (returned via
 * `UNAVAILABLE/NOT_CONFIGURED`). Selection and confirmation is a
 * downstream booking-sandbox action and is NOT triggered here.
 */
export function createMobilitySearchSkill(provider: MobilityOfferProvider): Skill<MobilitySearchInput, MobilitySearchOutput> {
  return {
    name: "mobility.search",
    agent: "shared",
    version: "1.0.0",
    allowedTools: ["snapshot:read", "mobility:search"],
    timeoutMs: 10_000,
    needsConfirm: false,
    input: mobilitySearchInputSchema,
    output: mobilitySearchOutputSchema,
    async handler(ctx, input, signal) {
      return executeMobilitySearchSkill(ctx, input, signal, provider);
    },
  };
}

async function executeMobilitySearchSkill(
  ctx: SkillContext,
  input: MobilitySearchInput,
  signal: AbortSignal,
  provider: MobilityOfferProvider,
): Promise<MobilitySearchOutput> {
  if (!ctx.snapshot || !ctx.mobility) {
    throw new SkillError("POLICY_DENIED", "mobility.search requires an authorized Shared planning execution context");
  }
  if (input.snapshotId !== ctx.mobility.snapshotId) {
    throw new SkillError("POLICY_DENIED", "mobility.search snapshot is not authorized for this execution");
  }
  let validated: MobilitySearchInput;
  try {
    validated = validateSnapshotBoundMobilitySearch({
      input,
      snapshotId: ctx.mobility.snapshotId,
      snapshot: ctx.snapshot,
    });
  } catch (error) {
    throw new SkillError("POLICY_DENIED", `mobility.search constraints rejected: ${(error as Error).message}`);
  }
  const result = await executeAndPersistMobilitySearch({
    ctx: ctx.ctx,
    tripId: ctx.mobility.tripId,
    snapshotId: ctx.mobility.snapshotId,
    agentTaskRunId: ctx.mobility.agentTaskRunId,
    input: validated,
    provider,
    signal,
  });
  if (result.outcome === "LIVE") {
    return {
      outcome: "LIVE",
      queryId: result.queryId!,
      offers: result.data.map((offer) => ({
        offerId: offer.offerId,
        serviceType: offer.serviceType,
        originPlaceId: offer.originPlaceId,
        destinationPlaceId: offer.destinationPlaceId,
        passengers: offer.passengers,
        departureAt: offer.departureAt,
        estimatedPrice: offer.estimatedPrice,
        currency: offer.currency,
        vehicleClass: offer.vehicleClass,
        estimated: true,
        expiresAt: offer.expiresAt,
        source: offer.source,
        capturedAt: offer.capturedAt,
      })),
    };
  }
  return { outcome: "UNAVAILABLE", code: result.reason };
}

export const mobilitySearchSkill = createMobilitySearchSkill(createTravelProviders().mobilityOfferProvider);
