import { z } from "zod";
import type { Skill } from "../../agents/contracts.js";
import { SkillError } from "../../agents/errors.js";
import type { ConstraintSnapshotData, FlightOffer, GroundOffer, StayOffer } from "../../types/domain.js";

export const planComparisonInputSchema = z.object({
  destination: z.string().min(1),
  flights: z.array(z.unknown()),
  stays: z.array(z.unknown()),
  ground: z.array(z.unknown()),
  memberPreferences: z.record(z.unknown()).default({}),
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

interface InlineValidator {
  validate(planData: Record<string, unknown>, snapshot: ConstraintSnapshotData): {
    ok: boolean;
    violations: Array<{ path: string; reason: string }>;
  };
}

/**
 * Minimum validator kept inside the skill until Stage A's
 * `policy/plan-output-validator.ts` lands. Enforces that every offer referenced
 * by the model is grounded in the constraint snapshot.
 */
const inlineValidator: InlineValidator = {
  validate(planData, snapshot) {
    const violations: Array<{ path: string; reason: string }> = [];
    const flights = (planData.flights ?? []) as FlightOffer[];
    const stays = (planData.stays ?? []) as StayOffer[];
    const ground = (planData.ground ?? []) as GroundOffer[];

    for (const [i, flight] of flights.entries()) {
      if (!snapshot.departureCities.includes(flight.origin)) {
        violations.push({
          path: `flights[${i}].origin`,
          reason: `Origin ${flight.origin} not in snapshot.departureCities`,
        });
      }
      if (flight.destination !== snapshot.destinationCandidates.find(d => d === flight.destination)) {
        if (!snapshot.destinationCandidates.includes(flight.destination)) {
          violations.push({
            path: `flights[${i}].destination`,
            reason: `Destination ${flight.destination} not in snapshot.destinationCandidates`,
          });
        }
      }
    }

    for (const [i, stay] of stays.entries()) {
      if (!snapshot.destinationCandidates.includes(stay.destination)) {
        violations.push({
          path: `stays[${i}].destination`,
          reason: `Stay destination ${stay.destination} not in snapshot.destinationCandidates`,
        });
      }
    }

    for (const [i, transfer] of ground.entries()) {
      if (!snapshot.destinationCandidates.includes(transfer.destination)) {
        violations.push({
          path: `ground[${i}].destination`,
          reason: `Ground destination ${transfer.destination} not in snapshot.destinationCandidates`,
        });
      }
    }

    return { ok: violations.length === 0, violations };
  },
};

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
    }, { signal });

    const verdict = inlineValidator.validate(planData as Record<string, unknown>, snapshot);
    if (!verdict.ok) {
      throw new SkillError(
        "PLAN_VALIDATION_FAILED",
        `Plan output failed inline validator (${verdict.violations.length} violations)`,
        verdict.violations,
      );
    }

    return planData as PlanComparisonOutput;
  },
};