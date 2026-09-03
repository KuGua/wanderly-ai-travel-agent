import { describe, expect, it } from "vitest";
import { PlanValidationError } from "../../src/policy/plan-output-validator.js";
import { toCritiques, renderCritiqueMessage } from "../../src/services/plan-critique.js";

describe("plan-critique (P3)", () => {
  it("maps EVIDENCE_NOT_FOUND to EVIDENCE_UNBOUND with stable field paths", () => {
    const error = new PlanValidationError([
      { code: "EVIDENCE_NOT_FOUND", fieldPath: "flights.0", reason: "x" },
      { code: "EVIDENCE_NOT_FOUND", fieldPath: "flights.1", reason: "y" },
    ]);
    const critiques = toCritiques(error);
    expect(critiques).not.toBeNull();
    expect(critiques).toHaveLength(1);
    expect(critiques![0]).toMatchObject({
      code: "EVIDENCE_UNBOUND",
      fieldPaths: ["flights.0", "flights.1"],
    });
    // Hint is a literal — never concatenates the offending value.
    expect(critiques![0].hint).toContain("offer");
    expect(critiques![0].hint).not.toContain("flights.0");
  });

  it("maps FIELD_NOT_AUTHORIZED to SNAPSHOT_FIELD_UNAUTHORIZED", () => {
    const error = new PlanValidationError([
      { code: "FIELD_NOT_AUTHORIZED", fieldPath: "stays.0.price", reason: "x" },
    ]);
    const critiques = toCritiques(error);
    expect(critiques).toEqual([
      expect.objectContaining({
        code: "SNAPSHOT_FIELD_UNAUTHORIZED",
        fieldPaths: ["stays.0.price"],
      }),
    ]);
  });

  it("groups multiple violation codes into distinct critiques", () => {
    const error = new PlanValidationError([
      { code: "EVIDENCE_MISMATCH", fieldPath: "flights.0", reason: "x" },
      { code: "STRUCTURE_INVALID", fieldPath: "response", reason: "y" },
    ]);
    const critiques = toCritiques(error);
    expect(critiques).not.toBeNull();
    expect(critiques!.map((c) => c.code).sort()).toEqual([
      "EVIDENCE_UNBOUND",
      "SCHEMA_INVALID",
    ]);
  });

  it("returns null when the violation codes are all unknown", () => {
    const error = new PlanValidationError([
      { code: "EXOTIC_FUTURE_CODE" as never, fieldPath: "x", reason: "y" },
    ]);
    expect(toCritiques(error)).toBeNull();
  });

  it("returns null for non-PlanValidationError inputs", () => {
    expect(toCritiques(new Error("unrelated"))).toBeNull();
    expect(toCritiques(null)).toBeNull();
    expect(toCritiques(undefined)).toBeNull();
  });

  it("renderCritiqueMessage produces a stable string with codes and paths", () => {
    const error = new PlanValidationError([
      { code: "DESTINATION_CANDIDATES_INCOMPLETE", fieldPath: "response", reason: "x" },
    ]);
    const critiques = toCritiques(error)!;
    const rendered = renderCritiqueMessage(critiques);
    expect(rendered).toContain("[COVERAGE_INCOMPLETE]");
    expect(rendered).toContain("(paths: response)");
    // White-list test: must not echo snapshot or model content.
    expect(rendered).not.toContain("DESTINATION_CANDIDATES_INCOMPLETE");
  });

  it("white-list: critique hints never include UUID / price / provider payload tokens", () => {
    const error = new PlanValidationError([
      { code: "EVIDENCE_NOT_FOUND", fieldPath: "flights.0.id", reason: "uuid-12345678-1234-1234-1234-123456789012" },
      { code: "STRUCTURE_INVALID", fieldPath: "response", reason: "PRICE: 999.99 USD" },
    ]);
    const critiques = toCritiques(error)!;
    const rendered = renderCritiqueMessage(critiques);
    expect(rendered).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    expect(rendered).not.toContain("999.99");
    expect(rendered).not.toContain("USD");
    // Path tokens ARE allowed (stable schema paths), but no UUID-looking
    // patterns were inserted by the reason field.
  });
});
