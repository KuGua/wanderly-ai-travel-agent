import { z } from "zod";
import type { Skill } from "../../agents/contracts.js";
import { SkillError } from "../../agents/errors.js";
import { metrics } from "../../observability/metrics.js";
import type { FlightOffer, GroundOffer, StayOffer } from "../../types/domain.js";
import { validatePlanOutput, type AuthorizedMemberData } from "../../policy/plan-output-validator.js";

export const planComparisonInputSchema = z.object({
  destination: z.string().min(1),
  flights: z.array(z.unknown()),
  stays: z.array(z.unknown()),
  ground: z.array(z.unknown()),
  memberPreferences: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const planComparisonOutputSchema = z.object({
  destination: z.string(),
  flights: z.array(z.unknown()),
  stays: z.array(z.unknown()),
  ground: z.array(z.unknown()),
  generatedAt: z.string().optional(),
}).strict();

export type PlanComparisonInput = z.infer<typeof planComparisonInputSchema>;
export type PlanComparisonOutput = z.infer<typeof planComparisonOutputSchema>;

function authorizedByUser(memberPreferences: Record<string, unknown>): Record<string, AuthorizedMemberData> {
  // The Personal Agent's snapshot projection is keyed by user id; for the MVP
  // we collapse all members into a single authorized view (multiple-member
  // shapes will be wired once per-member projection lands).
  const noRedEye = Object.values(memberPreferences).some(v => (v as { noRedEye?: boolean } | undefined)?.noRedEye === true);
  const accommodationStyles = new Set<string>();
  for (const v of Object.values(memberPreferences)) {
    const style = (v as { accommodationStyle?: string } | undefined)?.accommodationStyle;
    if (typeof style === "string") accommodationStyles.add(style);
  }
  return {
    __aggregated__: {
      noRedEye,
      accommodationStyle: [...accommodationStyles][0],
    },
  };
}

export const planComparisonSkill: Skill<PlanComparisonInput, PlanComparisonOutput> = {
  name: "plan.comparison",
  agent: "shared",
  version: "1.0.0",
  allowedTools: ["plan:write:propose", "snapshot:read"],
  timeoutMs: 10_000,
  needsConfirm: false,
  input: planComparisonInputSchema,
  output: planComparisonOutputSchema,
  async handler(ctx, input, signal) {
    const snapshot = ctx.snapshot;
    if (!snapshot) {
      throw new SkillError("SNAPSHOT_REQUIRED", "plan.comparison requires a snapshot in SkillContext");
    }

    const { modelGateway } = await import("../../providers/gateway-factory.js");
    const gateway = modelGateway();
    const planData = await gateway.generateStructuredPlan({
      destination: input.destination,
      flights: input.flights as FlightOffer[],
      stays: input.stays as StayOffer[],
      ground: input.ground as GroundOffer[],
      memberPreferences: input.memberPreferences,
      signal,
      ctx: ctx.ctx,
    });

    const verdict = validatePlanOutput(
      planData as Record<string, unknown>,
      snapshot,
      authorizedByUser(input.memberPreferences),
    );
    if (!verdict.ok) {
      metrics.inc("plan_validation_failures_total", { reason: verdict.violations[0]?.reason ?? "unknown" });
      throw new SkillError(
        "PLAN_VALIDATION_FAILED",
        `Plan output failed validator (${verdict.violations.length} violations)`,
        verdict.violations,
      );
    }

    return planData as PlanComparisonOutput;
  },
};
