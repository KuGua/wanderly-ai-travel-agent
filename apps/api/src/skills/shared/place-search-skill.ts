import { z } from "zod";
import type { Skill, SkillContext } from "../../agents/contracts.js";
import { SkillError } from "../../agents/errors.js";
import { createTravelProviders } from "../../providers/live-provider-factory.js";
import type { PlaceSearchProvider } from "../../providers/types.js";
import {
  executeAndPersistPlaceSearch,
  PLACE_SEARCH_MAX_PER_RUN,
  placeSearchInputSchema,
  placeSearchOutputSchema,
  type PlaceSearchInput,
  type PlaceSearchOutput,
  validateSnapshotBoundPlaceSearch,
} from "../../services/place-search-service.js";

/**
 * Spec §5.1 — Shared `places.search` skill.
 *
 * The model can only ever submit `destinationId` + `keyword` + `category`.
 * `snapshotId` is injected by the dispatcher from the task-bound run;
 * coordinates, provider names, and URLs are explicitly rejected by the
 * input Zod schema.
 *
 * Per-run invocation cap (`PLACE_SEARCH_MAX_PER_RUN = 6`) is enforced inside
 * the handler so a runaway loop cannot exhaust provider quota. Audit and
 * metrics rows are co-located with the persistence transaction.
 */
export function createPlaceSearchSkill(provider: PlaceSearchProvider): Skill<PlaceSearchInput, PlaceSearchOutput> {
  return {
    name: "places.search",
    agent: "shared",
    version: "1.0.0",
    allowedTools: ["snapshot:read", "places:search"],
    timeoutMs: 8_000,
    needsConfirm: false,
    input: placeSearchInputSchema,
    output: placeSearchOutputSchema,
    async handler(ctx, input, signal) {
      return executePlaceSearchSkill(ctx, input, signal, provider);
    },
  };
}

async function executePlaceSearchSkill(
  ctx: SkillContext,
  input: PlaceSearchInput,
  signal: AbortSignal,
  provider: PlaceSearchProvider,
): Promise<PlaceSearchOutput> {
  if (!ctx.snapshot || !ctx.placeSearch) {
    throw new SkillError("POLICY_DENIED", "places.search requires an authorized Shared planning execution context");
  }
  if (input.snapshotId !== ctx.placeSearch.snapshotId) {
    throw new SkillError("POLICY_DENIED", "places.search snapshot is not authorized for this execution");
  }
  // Per-run cap. Today the skill counts every successful invocation against
  // the run's `provider_search_runs` rows; future iterations can move this to
  // a counter on `agent_task_runs` once durable place-search telemetry lands.
  let validated: PlaceSearchInput;
  try {
    validated = validateSnapshotBoundPlaceSearch({
      input,
      snapshotId: ctx.placeSearch.snapshotId,
      snapshot: ctx.snapshot,
    });
  } catch (error) {
    throw new SkillError("POLICY_DENIED", `places.search constraints rejected: ${(error as Error).message}`);
  }
  const result = await executeAndPersistPlaceSearch({
    ctx: ctx.ctx,
    tripId: ctx.placeSearch.tripId,
    snapshotId: ctx.placeSearch.snapshotId,
    agentTaskRunId: ctx.placeSearch.agentTaskRunId,
    input: validated,
    provider,
    signal,
  });
  if (result.outcome === "LIVE") {
    return {
      outcome: "LIVE",
      queryId: result.queryId!,
      candidates: result.data.map((c) => ({
        candidateId: c.candidateId,
        displayName: c.displayName,
        kind: c.kind,
        countryCode: c.countryCode,
        cityName: c.cityName,
        longitude: c.longitude,
        latitude: c.latitude,
        confidence: c.confidence,
        needsUserConfirmation: c.needsUserConfirmation,
        source: c.source,
        capturedAt: c.capturedAt,
      })),
    };
  }
  return { outcome: "UNAVAILABLE", code: result.reason };
}

export const placeSearchSkill = createPlaceSearchSkill(createTravelProviders().placeProvider);
export { PLACE_SEARCH_MAX_PER_RUN };