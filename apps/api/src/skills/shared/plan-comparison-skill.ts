import { z } from "zod";
import type { Skill } from "../../agents/contracts.js";
import { SkillError } from "../../agents/errors.js";
import { validatePlanOutput } from "../../policy/plan-output-validator.js";
import type { FlightOffer } from "../../types/domain.js";

export const planComparisonInputSchema = z.object({
  destination: z.string().min(1),
  flights: z.array(z.unknown()),
  memberPreferences: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const planComparisonOutputSchema = z.object({
  destination: z.string(),
  flights: z.array(z.unknown()),
  generatedAt: z.string().optional(),
}).strict();

export type PlanComparisonInput = z.infer<typeof planComparisonInputSchema>;
export type PlanComparisonOutput = z.infer<typeof planComparisonOutputSchema>;

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
    const flights = input.flights as FlightOffer[];
    const candidatePlanData = await gateway.generateStructuredPlan({
      destination: input.destination,
      flights,
      memberPreferences: input.memberPreferences,
      signal,
      ctx: ctx.ctx,
    });

    return validatePlanOutput({
      planData: candidatePlanData,
      snapshot,
      evidence: { flights, stays: [] },
    });
  },
};
