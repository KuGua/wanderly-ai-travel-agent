import { describe, expect, it } from "vitest";
import { PlanValidationError } from "../src/policy/plan-output-validator.js";
import {
  errorCodeForRepair,
  isRetryableUpstreamError,
  toLlmMetricErrorCategory,
} from "../src/providers/llm-gateway.js";

describe("llm-gateway error classification — plan validation", () => {
  it("classifies a PlanValidationError as PLAN_VALIDATION_FAILED", () => {
    const err = new PlanValidationError([
      { code: "EVIDENCE_SLOT_MISMATCH", fieldPath: "stays.0", reason: "test" },
    ]);
    expect(errorCodeForRepair(err)).toBe("PLAN_VALIDATION_FAILED");
  });

  it("maps PLAN_VALIDATION_FAILED to the plan_validation metric category, not unknown", () => {
    expect(toLlmMetricErrorCategory("PLAN_VALIDATION_FAILED")).toBe("plan_validation");
  });

  it("does NOT mark PLAN_VALIDATION_FAILED as retryable upstream", () => {
    // A plan-shape defect is fixed by the repair loop on a separate budget.
    // Retrying it as upstream would burn the upstream retry budget against a
    // provider that cannot change the model's next emission.
    expect(isRetryableUpstreamError("PLAN_VALIDATION_FAILED")).toBe(false);
  });
});
