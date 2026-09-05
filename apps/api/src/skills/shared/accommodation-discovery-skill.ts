import { z } from "zod";

import type { Skill } from "../../agents/contracts.js";
import { SkillError } from "../../agents/errors.js";
import { createTravelProviders } from "../../providers/live-provider-factory.js";
import type { AccommodationDiscoveryProvider } from "../../providers/types.js";
import {
  AccommodationDiscoveryAlreadyAttemptedError,
  accommodationDiscoveryInputSchema,
  accommodationEvidenceSchema,
  executeAndPersistAccommodationDiscovery,
  validateSnapshotBoundAccommodationDiscovery,
  type AccommodationDiscoveryInput,
} from "../../services/accommodation-discovery-service.js";

export const accommodationDiscoveryOutputSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("LIVE"),
    queryId: z.string().uuid(),
    accommodations: z.array(accommodationEvidenceSchema).min(1).max(20),
  }).strict(),
  z.object({
    outcome: z.literal("UNAVAILABLE"),
    code: z.enum([
      "NOT_CONFIGURED", "SEARCH_CONSTRAINTS_INCOMPLETE", "NO_RESULTS", "RATE_LIMITED",
      "UPSTREAM_TIMEOUT", "UPSTREAM_FAILURE", "INVALID_PROVIDER_RESPONSE", "PROVIDER_NOT_APPROVED",
      "PROVIDER_REQUEST_REJECTED",
    ]),
  }).strict(),
]);

export type AccommodationDiscoveryOutput = z.infer<typeof accommodationDiscoveryOutputSchema>;

export function createAccommodationDiscoverySkill(
  provider: AccommodationDiscoveryProvider,
): Skill<AccommodationDiscoveryInput, AccommodationDiscoveryOutput> {
  return {
    name: "accommodation.discover",
    agent: "shared",
    version: "1.0.0",
    allowedTools: ["snapshot:read", "accommodation:discover"],
    timeoutMs: 12_000,
    needsConfirm: false,
    input: accommodationDiscoveryInputSchema,
    output: accommodationDiscoveryOutputSchema,
    async handler(ctx, input, signal) {
      if (!ctx.snapshot || !ctx.accommodationDiscovery) {
        throw new SkillError("POLICY_DENIED", "accommodation.discover requires an authorized Shared planning context");
      }
      let validated: AccommodationDiscoveryInput;
      try {
        validated = validateSnapshotBoundAccommodationDiscovery({
          input,
          snapshotId: ctx.accommodationDiscovery.snapshotId,
          snapshot: ctx.snapshot,
        });
      } catch (error) {
        throw new SkillError("POLICY_DENIED", `accommodation.discover constraints rejected: ${(error as Error).message}`);
      }
      try {
        const result = await executeAndPersistAccommodationDiscovery({
          ctx: ctx.ctx,
          tripId: ctx.accommodationDiscovery.tripId,
          snapshotId: ctx.accommodationDiscovery.snapshotId,
          agentTaskRunId: ctx.accommodationDiscovery.agentTaskRunId,
          input: validated,
          provider,
          signal,
        });
        return result.outcome === "LIVE"
          ? { outcome: "LIVE", queryId: result.queryId!, accommodations: result.data }
          : { outcome: "UNAVAILABLE", code: result.reason };
      } catch (error) {
        if (error instanceof AccommodationDiscoveryAlreadyAttemptedError) throw new SkillError("POLICY_DENIED", error.message);
        throw error;
      }
    },
  };
}

export const accommodationDiscoverySkill = createAccommodationDiscoverySkill(
  createTravelProviders().accommodationDiscoveryProvider,
);
