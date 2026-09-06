import { describe, expect, it } from "vitest";
import {
  PlanValidationError,
  type PlanValidationViolation,
} from "../src/policy/plan-output-validator.js";
import {
  renderCritiqueMessage,
  toCritiques,
} from "../src/services/plan-critique.js";

describe("toCritiques — slot-mismatch plumbing", () => {
  it("maps a PlanValidationError with EVIDENCE_SLOT_MISMATCH into a single critique without leaking the id", () => {
    const SENTINEL = "sentinel-hotel-id-do-not-leak";
    const violations: PlanValidationViolation[] = [
      {
        code: "EVIDENCE_SLOT_MISMATCH",
        fieldPath: "stays.0",
        // Reason is a closed literal coming from the preflight; we deliberately
        // verify the critic does NOT echo it (or the id) into the rendered
        // message either.
        reason: `Offer id does not belong to this slot's provider evidence (id: ${SENTINEL})`,
      },
    ];
    const error = new PlanValidationError(violations);
    const critiques = toCritiques(error);
    expect(critiques).not.toBeNull();
    expect(critiques).toHaveLength(1);
    expect(critiques![0].code).toBe("EVIDENCE_SLOT_MISMATCH");
    expect(critiques![0].fieldPaths).toEqual(["stays.0"]);
    // The hint is a closed literal in HINTS — never echoes the violation's
    // reason or the id.
    expect(critiques![0].hint).not.toContain(SENTINEL);
    const rendered = renderCritiqueMessage(critiques!);
    expect(rendered).toContain("EVIDENCE_SLOT_MISMATCH");
    expect(rendered).toContain("stays.0");
    expect(rendered).not.toContain(SENTINEL);
  });

  it("returns null when the only violations cannot be mapped to a closed critique code", () => {
    const error = new PlanValidationError([
      // An unmapped code keeps toCritiques from emitting anything; the caller
      // should rethrow and skip the repair loop.
      { code: "STRUCTURE_INVALID", fieldPath: "planData", reason: "n/a" },
    ]);
    // STRUCTURE_INVALID does map (to SCHEMA_INVALID), so we use a synthetic
    // unmapped code shape via the public type to assert the default path
    // drops it.
    const syntheticUnknown = new PlanValidationError([
      { code: "UNKNOWN_CODE" as unknown as PlanValidationViolation["code"], fieldPath: "x", reason: "y" },
    ]);
    expect(toCritiques(syntheticUnknown)).toBeNull();
    expect(toCritiques(error)).not.toBeNull();
  });
});
