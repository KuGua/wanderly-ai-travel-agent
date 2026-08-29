import type { Skill, SkillContext } from "../../agents/contracts.js";
import { SkillError } from "../../agents/errors.js";
import { createTravelProviders } from "../../providers/live-provider-factory.js";
import type { NavigationProvider } from "../../providers/types.js";
import {
  NAVIGATION_REFRESH_AFTER_HOURS,
  executeAndPersistNavigationRoute,
  navigationRouteInputSchema,
  navigationRouteOutputSchema,
  type NavigationRouteInput,
  type NavigationRouteOutput,
  validateSnapshotBoundNavigationRoute,
} from "../../services/navigation-route-service.js";

/**
 * Spec §5.2 — Shared `navigation.route` skill.
 *
 * The model can only ever submit two authorized `placeId`s plus a mode.
 * Coordinates, provider names, and URLs are explicitly rejected by the
 * input Zod schema. The dispatcher injects `snapshotId` from the run-bound
 * task; the service enforces that both places belong to the trip, are
 * `ACTIVE`, and have a non-private visibility.
 */
export function createNavigationRouteSkill(provider: NavigationProvider): Skill<NavigationRouteInput, NavigationRouteOutput> {
  return {
    name: "navigation.route",
    agent: "shared",
    version: "1.0.0",
    allowedTools: ["snapshot:read", "navigation:route"],
    timeoutMs: 10_000,
    needsConfirm: false,
    input: navigationRouteInputSchema,
    output: navigationRouteOutputSchema,
    async handler(ctx, input, signal) {
      return executeNavigationRouteSkill(ctx, input, signal, provider);
    },
  };
}

async function executeNavigationRouteSkill(
  ctx: SkillContext,
  input: NavigationRouteInput,
  signal: AbortSignal,
  provider: NavigationProvider,
): Promise<NavigationRouteOutput> {
  if (!ctx.snapshot || !ctx.navigation) {
    throw new SkillError("POLICY_DENIED", "navigation.route requires an authorized Shared planning execution context");
  }
  if (input.snapshotId !== ctx.navigation.snapshotId) {
    throw new SkillError("POLICY_DENIED", "navigation.route snapshot is not authorized for this execution");
  }
  let validated: NavigationRouteInput;
  try {
    validated = await validateSnapshotBoundNavigationRoute({
      input,
      snapshotId: ctx.navigation.snapshotId,
      snapshot: ctx.snapshot,
    });
  } catch (error) {
    throw new SkillError("POLICY_DENIED", `navigation.route constraints rejected: ${(error as Error).message}`);
  }
  return executeAndPersistNavigationRoute({
    ctx: ctx.ctx,
    tripId: ctx.navigation.tripId,
    snapshotId: ctx.navigation.snapshotId,
    agentTaskRunId: ctx.navigation.agentTaskRunId,
    input: validated,
    provider,
    signal,
  });
}

export const navigationRouteSkill = createNavigationRouteSkill(createTravelProviders().navigationProvider);
export { NAVIGATION_REFRESH_AFTER_HOURS };
