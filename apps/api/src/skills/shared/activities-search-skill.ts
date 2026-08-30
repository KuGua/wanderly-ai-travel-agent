import { z } from "zod";

import type { Skill, SkillContext } from "../../agents/contracts.js";
import { SkillError } from "../../agents/errors.js";
import { createTravelProviders } from "../../providers/live-provider-factory.js";
import type { ActivitiesProvider } from "../../providers/types.js";
import {
  ActivitiesSearchAlreadyAttemptedError,
  activityEvidenceSchema,
  activitiesSearchInputSchema,
  executeAndPersistActivitiesSearch,
  validateSnapshotBoundActivitiesSearch,
  type ActivitiesSearchInput,
} from "../../services/activities-search-service.js";

export const activitiesSearchOutputSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("LIVE"),
    queryId: z.string().uuid(),
    activities: z.array(activityEvidenceSchema).min(1).max(5),
  }).strict(),
  z.object({
    outcome: z.literal("UNAVAILABLE"),
    code: z.enum([
      "NOT_CONFIGURED", "SEARCH_CONSTRAINTS_INCOMPLETE", "NO_RESULTS", "RATE_LIMITED",
      "UPSTREAM_TIMEOUT", "UPSTREAM_FAILURE", "INVALID_PROVIDER_RESPONSE", "PROVIDER_NOT_APPROVED",
    ]),
  }).strict(),
]);

export type ActivitiesSearchOutput = z.infer<typeof activitiesSearchOutputSchema>;

export function createActivitiesSearchSkill(
  provider: ActivitiesProvider,
): Skill<ActivitiesSearchInput, ActivitiesSearchOutput> {
  return {
    name: "activities.search",
    agent: "shared",
    version: "1.0.0",
    allowedTools: ["snapshot:read", "activities:search"],
    timeoutMs: 12_000,
    needsConfirm: false,
    input: activitiesSearchInputSchema,
    output: activitiesSearchOutputSchema,
    async handler(ctx, input, signal) {
      return executeActivitiesSearchSkill(ctx, input, signal, provider);
    },
  };
}

async function executeActivitiesSearchSkill(
  ctx: SkillContext,
  input: ActivitiesSearchInput,
  signal: AbortSignal,
  provider: ActivitiesProvider,
): Promise<ActivitiesSearchOutput> {
  if (!ctx.snapshot || !ctx.activitiesSearch) {
    throw new SkillError("POLICY_DENIED", "activities.search requires an authorized Shared planning context");
  }
  if (input.snapshotId !== ctx.activitiesSearch.snapshotId) {
    throw new SkillError("POLICY_DENIED", "activities.search snapshot is not authorized for this execution");
  }
  let validated: ActivitiesSearchInput;
  try {
    validated = validateSnapshotBoundActivitiesSearch({
      input,
      snapshotId: ctx.activitiesSearch.snapshotId,
      snapshot: ctx.snapshot,
    });
  } catch (error) {
    throw new SkillError("POLICY_DENIED", `activities.search constraints rejected: ${(error as Error).message}`);
  }
  let result;
  try {
    result = await executeAndPersistActivitiesSearch({
      currency: ctx.activitiesSearch.currency,
      ctx: ctx.ctx,
      tripId: ctx.activitiesSearch.tripId,
      snapshotId: ctx.activitiesSearch.snapshotId,
      agentTaskRunId: ctx.activitiesSearch.agentTaskRunId,
      snapshot: ctx.snapshot,
      input: validated,
      provider,
      signal,
    });
  } catch (error) {
    if (error instanceof ActivitiesSearchAlreadyAttemptedError) throw new SkillError("POLICY_DENIED", error.message);
    throw error;
  }
  return result.outcome === "LIVE"
    ? { outcome: "LIVE", queryId: result.queryId!, activities: result.data }
    : { outcome: "UNAVAILABLE", code: result.reason };
}

export const activitiesSearchSkill = createActivitiesSearchSkill(
  createTravelProviders().activitiesProvider,
);
