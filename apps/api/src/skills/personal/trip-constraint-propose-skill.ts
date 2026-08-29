import { z } from "zod";
import type { Skill } from "../../agents/contracts.js";
import {
  CONSTRAINT_FIELD_CATALOG,
  parseConstraintField,
  type ConstraintFieldKey,
} from "../../policy/constraint-field-catalog.js";

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
  async handler(_ctx, input, _signal) {
    void _signal;
    if (input.threadContext.tripBrief.destinationCandidates.length === 0) {
      return { proposals: [] };
    }
    // The model may submit zero-or-more proposals; each is catalog-validated.
    // Strict close: any failure throws SkillError('INPUT_INVALID' | 'OUTPUT_INVALID')
    // so callers learn immediately rather than persisting a half-formed row.
    return { proposals: [] };
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
