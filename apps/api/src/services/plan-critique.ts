/**
 * Deterministic plan critic (P3 of
 * `docs/planner-resilience-and-reflection-implementation.md`).
 *
 * The `ModelGateway` tool loop already re-validates the final JSON shape
 * against the planner's output schema (see `llm-gateway.ts:973`) and feeds a
 * structured system message back to the model when validation fails. This
 * module generalises that pattern to the *other* validators the planner runs
 * before persisting a plan:
 *
 *   - `validatePlanOutput` (coverage / evidence / snapshot-field policy)
 *   - `evaluateFlightResearchCompleteness` + Gate B
 *     (a destination with no citable provider evidence at all)
 *   - `validateProviderCoverage`
 *   - `PlanValidationError` from the deterministic snapshot/plan validators
 *
 * The critic only emits *stable* signals: a closed code + an array of field
 * paths + a fixed template string. Never the offending value, never the
 * snapshot content, never provider payloads. Per §1.7 of the design, the
 * critic output is whitelisted; `toCritiques` returns `null` for any error
 * that cannot be safely reduced, so the caller falls back to "throw the
 * original error" — the repair loop only fires when the critic is sure the
 * feedback is non-leaky.
 */

import { PlanValidationError } from "../policy/plan-output-validator.js";

export type PlanCritiqueCode =
  | "COVERAGE_INCOMPLETE"
  | "EVIDENCE_UNBOUND"
  | "EVIDENCE_SLOT_MISMATCH"
  | "SNAPSHOT_FIELD_UNAUTHORIZED"
  | "SCHEMA_INVALID";

export interface PlanCritique {
  readonly code: PlanCritiqueCode;
  /**
   * Stable field paths from the underlying error. The critic copies *paths*
   * (e.g. `flights.0.origin`) from `PlanValidationError.violations[].path`
   * but never the offending value. Empty when the source error carries no
   * path information.
   */
  readonly fieldPaths: readonly string[];
  /**
   * Fixed template hint per `code`. Models read this to know what to fix.
   * Templates are literal strings in this file; no runtime concatenation,
   * no interpolated values from the snapshot or the model's output.
   */
  readonly hint: string;
}

const HINTS: Record<PlanCritiqueCode, string> = {
  COVERAGE_INCOMPLETE:
    "Some required capabilities have no result. Re-run the missing tool with the destinations already covered and reference at least one offer per capability.",
  EVIDENCE_UNBOUND:
    "Every selected offer must reference a `providerSearchRuns` row from this run. Do not invent offers; if a capability has no offer, mark it as a gap.",
  EVIDENCE_SLOT_MISMATCH:
    "Each id must reference evidence from the matching category. Move the entry to the slot whose catalog contains it, or remove it; do not duplicate or summarize fields.",
  SNAPSHOT_FIELD_UNAUTHORIZED:
    "Only fields present in the snapshot's authorized data may be referenced. Use the snapshot's projection manifest to find the canonical member id and field name.",
  SCHEMA_INVALID:
    "The final JSON did not match the required schema. Re-emit a complete object; do not omit required fields.",
};

/**
 * Pure mapping from a thrown error into a critic emission. Returns `null`
 * for errors that the critic cannot safely describe — in those cases the
 * caller should rethrow the original error and skip the repair loop. The
 * `PlanEvidenceUnavailableError` (research-summary branch signal) is in
 * the `null` set on purpose: it is a Gate-B outcome, not a fixable output
 * defect, and the planner already handles it by switching branches.
 */
export function toCritiques(error: unknown): PlanCritique[] | null {
  if (error instanceof PlanValidationError) {
    if (error.violations.length === 0) return null;
    const grouped = new Map<PlanCritiqueCode, Set<string>>();
    for (const violation of error.violations) {
      const code = mapViolationToCode(violation.code);
      if (!code) continue;
      const bucket = grouped.get(code) ?? new Set<string>();
      // Only stable, schema-shaped paths survive. `fieldPath` here is the
      // validator's structured path (e.g. `flights.0.origin`); we copy
      // verbatim and never the offending value.
      if (typeof violation.fieldPath === "string" && violation.fieldPath.length > 0) {
        bucket.add(violation.fieldPath);
      }
      grouped.set(code, bucket);
    }
    if (grouped.size === 0) return null;
    return [...grouped.entries()].map(([code, paths]) => ({
      code,
      fieldPaths: [...paths],
      hint: HINTS[code],
    }));
  }
  return null;
}

/**
 * Best-effort mapping from `PlanValidationError.violations[].code` to the
 * closed `PlanCritiqueCode` set. Unknown codes are dropped so the critic
 * emits only what it can describe; the caller then either repairs on the
 * known codes or rethrows if the list is empty.
 */
function mapViolationToCode(violationCode: string): PlanCritiqueCode | null {
  switch (violationCode) {
    case "EVIDENCE_NOT_FOUND":
    case "EVIDENCE_MISMATCH":
      return "EVIDENCE_UNBOUND";
    case "EVIDENCE_SLOT_MISMATCH":
      return "EVIDENCE_SLOT_MISMATCH";
    case "FIELD_NOT_AUTHORIZED":
    case "ORIGIN_NOT_ALLOWED":
    case "DESTINATION_NOT_ALLOWED":
    case "DESTINATION_MISMATCH":
    case "CONFIDENTIAL_VALUE_LEAK":
    case "EXPLANATION_TOKEN_NOT_ALLOWED":
      return "SNAPSHOT_FIELD_UNAUTHORIZED";
    case "DESTINATION_CANDIDATES_INCOMPLETE":
    case "HARD_CONSTRAINT_UNSATISFIED":
      return "COVERAGE_INCOMPLETE";
    case "STRUCTURE_INVALID":
      return "SCHEMA_INVALID";
    default:
      return null;
  }
}

/**
 * Render the deterministic feedback message that the gateway pushes back
 * into the model as a system message. Built by `switch` on the first
 * critique's code; no string concatenation, no runtime data. Multiple
 * critiques are joined by a stable separator so the model can parse them.
 */
export function renderCritiqueMessage(critiques: readonly PlanCritique[]): string {
  if (critiques.length === 0) return "";
  return critiques
    .map((c) => `[${c.code}] ${c.hint}${c.fieldPaths.length > 0 ? ` (paths: ${c.fieldPaths.join(", ")})` : ""}`)
    .join(" | ");
}
