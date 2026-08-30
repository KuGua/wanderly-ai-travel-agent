/**
 * Spec §10.4 — HARD constraint conflict produces a structured blocking
 * result; SOFT conflict changes ranking only.
 *
 * Pure-function coverage of the catalog layer. Integration with the live
 * planning-service path is covered by Phase 3's `generatePlan` / `validatePlanOutput`.
 */

import { describe, expect, it } from "vitest";
import {
  CONSTRAINT_FIELD_CATALOG,
  parseConstraintField,
  ConstraintFieldCatalogError,
} from "../../src/policy/constraint-field-catalog.js";

describe("HARD vs SOFT constraint semantics (spec §10.4)", () => {
  it("rejects a combination where the descriptor forbids HARD for this field", () => {
    // accommodation_style is SOFT-only per spec §4.
    expect(() => parseConstraintField({
      fieldKey: "accommodation_style",
      value: { style: "boutique" },
      visibility: "TEAM_VISIBLE",
      strength: "HARD",
    })).toThrow(ConstraintFieldCatalogError);
  });

  it("accepts a SOFT accommodation_style fact as reorderable, not blocking", () => {
    const accepted = parseConstraintField({
      fieldKey: "accommodation_style",
      value: { style: "boutique" },
      visibility: "TEAM_VISIBLE",
      strength: "SOFT",
    });
    expect(accepted.strength).toBe("SOFT");
  });

  it("rejects HARD budget until allocation and FX evidence are defined", () => {
    expect(() => parseConstraintField({
      fieldKey: "budget_max",
      value: { amountUsd: 2500 },
      visibility: "ORCHESTRATOR_CONFIDENTIAL",
      strength: "HARD",
    })).toThrow(ConstraintFieldCatalogError);
    expect(CONSTRAINT_FIELD_CATALOG.budget_max.residualInferenceWarningToken).toBe("BUDGET_RESIDUAL_INFERENCE");
  });

  it("downgrades visibility to confidential requires explicit catalog support", () => {
    // departure_city is TEAM_VISIBLE-only.
    expect(() => parseConstraintField({
      fieldKey: "departure_city",
      value: { city: "Shanghai" },
      visibility: "ORCHESTRATOR_CONFIDENTIAL",
      strength: "HARD",
    })).toThrow(ConstraintFieldCatalogError);
  });
});
