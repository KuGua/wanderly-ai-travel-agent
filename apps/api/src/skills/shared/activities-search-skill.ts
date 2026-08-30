import { z } from "zod";

import type { Skill, SkillContext } from "../../agents/contracts.js";
import { SkillError } from "../../agents/errors.js";
import { createTravelProviders } from "../../providers/live-provider-factory.js";
import type { ActivitiesProvider } from "../../providers/types.js";
import {
  activitiesSearchInputSchema,
  executeAndPersistActivitiesSearch,
  validateSnapshotBoundActivitiesSearch,
  type ActivitiesSearchInput,
} from "../../services/activities-search-service.js";

const activityEvidenceSchema = z.object({
  id: z.string().uuid(),
  providerOfferId: z.string().min(1),
  providerName: z.literal("viator"),
  queryId: z.string().uuid(),
  destination: z.string().min(1).max(128),
  title: z.string().min(1).max(512),
  thumbnailUrl: z.string().url(),
  rating: z.number().min(0).max(5).nullable(),
  reviewCount: z.number().int().nonnegative(),
  freeCancellation: z.boolean(),
  durationMinutes: z.object({
    fixed: z.number().int().nonnegative().nullable(),
    from: z.number().int().nonnegative().nullable(),
    to: z.number().int().nonnegative().nullable(),
  }).strict(),
  category: z.string().min(1).nullable(),
  // Price and currency travel together or not at all: an amount without a
  // stated denomination is what made this field unusable before.
  fromPrice: z.number().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  source: z.literal("Viator Experiences MCP"),
  capturedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

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
  const result = await executeAndPersistActivitiesSearch({
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
  return result.outcome === "LIVE"
    ? { outcome: "LIVE", queryId: result.queryId!, activities: result.data }
    : { outcome: "UNAVAILABLE", code: result.reason };
}

export const activitiesSearchSkill = createActivitiesSearchSkill(
  createTravelProviders().activitiesProvider,
);
