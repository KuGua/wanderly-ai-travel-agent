import { z } from "zod";
import type { Skill } from "../../agents/contracts.js";
import {
  CONSTRAINT_FIELD_CATALOG,
  CONSTRAINT_FIELD_KEYS,
  parseConstraintField,
  type ConstraintFieldKey,
} from "../../policy/constraint-field-catalog.js";
import { modelGateway } from "../../providers/gateway-factory.js";
import { metrics } from "../../observability/metrics.js";
import { logSafeRuntimeEvent } from "../../observability/telemetry.js";

export const tripConstraintProposeInputSchema = z.object({
  tripId: z.string().uuid(),
  question: z.string().min(1).max(1024),
  threadContext: z.object({
    tripBrief: z.object({
      departureCities: z.array(z.string().min(1)).min(1),
      destinationCandidates: z.array(z.string().min(1)).min(1),
      travelDateWindow: z.object({
        start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }).optional(),
    }).strict(),
    ownerProfileHints: z.object({
      interests: z.array(z.string()).optional(),
      accommodationStyle: z.string().optional(),
      noRedEye: z.boolean().optional(),
      budgetMaxUsd: z.number().int().positive().optional(),
    }).strict().optional(),
  }).strict(),
}).strict();

const proposalSchema = z.object({
  fieldKey: z.string().min(1).max(64),
  valueJson: z.unknown(),
  strength: z.enum(["HARD", "SOFT"]),
  suggestedVisibility: z.enum(["TEAM_VISIBLE", "ORCHESTRATOR_CONFIDENTIAL"]),
  safeRationale: z.string().min(1).max(280),
}).strict();

export const tripConstraintProposeOutputSchema = z.object({
  proposals: z.array(proposalSchema).max(8),
}).strict();

export type TripConstraintProposeInput = z.infer<typeof tripConstraintProposeInputSchema>;
export type TripConstraintProposeOutput = z.infer<typeof tripConstraintProposeOutputSchema>;

/**
 * Personal Skill (spec §5.1): "trip.constraint.propose"
 *
 * Owner-private proposal generator. Validates proposals against the constraint
 * field catalog (`policy/constraint-field-catalog.ts`); the model/UI may NOT
 * create new field keys, use arbitrary JSON, assign another owner, or bypass
 * visibility rules.
 *
 * This skill does NOT call the LLM. It validates the curated envelope produced
 * upstream by the conversation skill / a future LLM-backed wrapper. Phase 5
 * keeps it as a deterministic gate; Phase 6 introduces LLM-backed proposal
 * extraction behind this same contract so fallback paths remain bounded.
 *
 * Spec invariant: `safeRationale` is owner-only and must not quote prior chat
 * (no leak of member-phrased text into a member-readable explanation).
 */
export const tripConstraintProposeSkill: Skill<TripConstraintProposeInput, TripConstraintProposeOutput> = {
  name: "trip.constraint.propose",
  agent: "personal",
  version: "1.0.0",
  allowedTools: ["consent:read"],
  timeoutMs: 1500,
  needsConfirm: true,
  input: tripConstraintProposeInputSchema,
  output: tripConstraintProposeOutputSchema,
  async handler(ctx, input, signal) {
    if (input.threadContext.tripBrief.destinationCandidates.length === 0) {
      return { proposals: [] };
    }
    // Build the closed allow-list the model is allowed to fill. Each entry
    // contains the catalog key, its allowed visibilities / strengths, and a
    // minimal example value drawn from the schema. Sensitive fields
    // (nationality / passport / health / accessibility) live in the catalog
    // but are flagged `proposalEligible: false`, so they are excluded here.
    const catalog = CONSTRAINT_FIELD_KEYS
      .map((key) => CONSTRAINT_FIELD_CATALOG[key])
      .filter((descriptor) => descriptor.proposalEligible)
      .map((descriptor) => ({
        fieldKey: descriptor.key,
        allowedVisibilities: descriptor.allowedVisibilities,
        allowedStrengths: descriptor.allowedStrengths,
        valueShape: describeValueShape(descriptor.key),
      }));

    const gateway = modelGateway();
    if (!gateway.generateConstraintProposalBatch) {
      logSafeRuntimeEvent(ctx.ctx, {
        component: "worker", event: "skill", operation: "trip.constraint.propose",
        outcome: "failure",
      });
      metrics.inc("conversation_handoff_candidate_batch_total", { result: "extraction_failed" });
      return { proposals: [] };
    }

    let raw: Awaited<ReturnType<NonNullable<typeof gateway.generateConstraintProposalBatch>>>;
    try {
      raw = await gateway.generateConstraintProposalBatch({
        catalog,
        tripBrief: input.threadContext.tripBrief,
        ...(input.threadContext.ownerProfileHints
          ? { ownerProfileHints: input.threadContext.ownerProfileHints }
          : {}),
        currentTurnQuestion: input.question,
        signal,
        ctx: ctx.ctx,
      });
    } catch (error) {
      logSafeRuntimeEvent(ctx.ctx, {
        component: "worker", event: "skill", operation: "trip.constraint.propose",
        outcome: "failure",
        errorCode: (error as { code?: string }).code ?? "INTERNAL",
      });
      metrics.inc("conversation_handoff_candidate_batch_total", { result: "extraction_failed" });
      // Strict close — the conversation worker treats an empty batch as
      // "ask the member to clarify" rather than silently accepting partial
      // proposals. Returning [] preserves the deterministic shape so the
      // outer parser still validates.
      return { proposals: [] };
    }

    // Catalog-validate each proposal before it can leave the skill. The model
    // can lie about field keys, values, visibility, strength, or rationales
    // that quote the chat text — all are dropped here.
    const validated = raw.proposals.flatMap((candidate) => {
      try {
        const v = validateSubmittedProposal({
          fieldKey: candidate.fieldKey,
          valueJson: candidate.valueJson,
          strength: candidate.strength,
          suggestedVisibility: candidate.suggestedVisibility,
          safeRationale: candidate.safeRationale,
        });
        metrics.inc("conversation_handoff_candidate_batch_total", { result: "extracted" });
        return [v];
      } catch {
        metrics.inc("conversation_handoff_candidate_batch_total", { result: "catalog_invalid" });
        return [];
      }
    });

    if (validated.length === 0) {
      metrics.inc("conversation_handoff_candidate_batch_total", { result: "empty" });
    }
    return { proposals: validated.slice(0, 8) };
  },
};

export function validateSubmittedProposal(raw: {
  fieldKey: string;
  valueJson: unknown;
  strength: "HARD" | "SOFT";
  suggestedVisibility: "TEAM_VISIBLE" | "ORCHESTRATOR_CONFIDENTIAL";
  safeRationale: string;
}): {
  fieldKey: ConstraintFieldKey;
  valueJson: unknown;
  strength: "HARD" | "SOFT";
  suggestedVisibility: "TEAM_VISIBLE" | "ORCHESTRATOR_CONFIDENTIAL";
  safeRationale: string;
} {
  const descriptor = CONSTRAINT_FIELD_CATALOG[raw.fieldKey as ConstraintFieldKey];
  if (!descriptor || !descriptor.proposalEligible) {
    throw new Error(`Personal Agent tried to propose non-catalog field "${raw.fieldKey}"`);
  }
  // Catalog enforces visibility + strength compat + value shape.
  parseConstraintField({
    fieldKey: raw.fieldKey,
    value: raw.valueJson,
    visibility: raw.suggestedVisibility,
    strength: raw.strength,
  });
  if (raw.safeRationale.length > 280) {
    throw new Error("safeRationale exceeds 280 chars");
  }
  return raw as {
    fieldKey: ConstraintFieldKey;
    valueJson: unknown;
    strength: "HARD" | "SOFT";
    suggestedVisibility: "TEAM_VISIBLE" | "ORCHESTRATOR_CONFIDENTIAL";
    safeRationale: string;
  };
}

/**
 * Server-authored one-line description of each field's value shape. The model
 * uses this to write a `valueJson` matching the catalog schema without us
 * having to ship a JSON-schema dump into the prompt. Keep these short and
 * unambiguous; the catalog Zod schemas are the source of truth and
 * `validateSubmittedProposal` still rejects any divergence.
 */
function describeValueShape(fieldKey: ConstraintFieldKey): string {
  switch (fieldKey) {
    case "departure_city":
      return "{ city: string (1-64), countryCode?: ISO-3166-1 alpha-2 }";
    case "travel_date_window":
      return "{ start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }";
    case "budget_max":
      return "{ amountUsd: integer > 0, rationale?: string (max 280) }";
    case "accessibility_need":
      return "{ category: 'MOBILITY'|'VISION'|'HEARING'|'COGNITIVE'|'OTHER', notes?: string (max 280) }";
    case "special_schedule_limit":
      return "{ kind: 'MEDICATION_WINDOW'|'CHILD_CARE'|'WORK_BLOCK'|'OTHER', description: string (1-280) }";
    case "no_red_eye":
      return "{ enabled: boolean }";
    case "accommodation_style":
      return "{ style: 'city_center'|'budget'|'luxury'|'boutique' }";
    case "travel_pace":
      return "{ pace: 'relaxed'|'balanced'|'packed' }";
    case "interests":
      return "{ topics: string[] (1-12 items, each 1-40 chars) }";
    default:
      return "object";
  }
}
