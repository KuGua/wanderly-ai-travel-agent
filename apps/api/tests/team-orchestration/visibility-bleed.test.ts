/**
 * Spec §10.2 — confidential value must never appear in member API responses,
 * plan JSON, audit summary, explanation text, or SSE event payload.
 *
 * Pure-function coverage; does not require DB.
 */

import { describe, expect, it } from "vitest";
import { redactPlanForViewer } from "../../src/services/plan-listing-service.js";
import { whitelistSummary } from "../../src/services/audit-service.js";

describe("visibility bleed — plan listing redaction (spec §10.2)", () => {
  it("strips _meta and orchestratorConfidential keys from outbound payload", () => {
    const planData = {
      destination: "Tokyo",
      destinationCandidatesEvaluated: ["Tokyo", "Bangkok"],
      flights: [],
      stays: [],
      ground: [],
      generatedAt: "2026-08-29T00:00:00Z",
      _meta: { foo: "secret-must-not-leak" },
      orchestratorConfidential: { m_alias: [{ fieldKey: "budget_max", valueJson: { amountUsd: 2500 } }] },
    };
    const redacted = redactPlanForViewer(planData as never);
    expect(redacted._meta).toBeUndefined();
    expect(redacted.orchestratorConfidential).toBeUndefined();
    expect(redacted.destination).toBe("Tokyo");
  });

  it("drops constraintReferences values containing the word 'private'", () => {
    const planData = {
      destination: "Tokyo",
      destinationCandidatesEvaluated: ["Tokyo"],
      flights: [],
      stays: [],
      ground: [],
      generatedAt: "2026-08-29T00:00:00Z",
      constraintReferences: [
        "teamVisible.m_alias[0].fieldKey",
        "private.some.private.reference",
      ],
    };
    const redacted = redactPlanForViewer(planData as never);
    expect(redacted.constraintReferences).toEqual(["teamVisible.m_alias[0].fieldKey"]);
  });

  it("filters publicExplanationTokens that don't match the SCREAMING_SNAKE_CASE shape", () => {
    const planData = {
      destination: "Tokyo",
      destinationCandidatesEvaluated: ["Tokyo"],
      flights: [],
      stays: [],
      ground: [],
      generatedAt: "2026-08-29T00:00:00Z",
      publicExplanationTokens: [
        "SATISFIES_ALL_PRIVATE_CONSTRAINTS",
        "this is a free-form sentence that must be stripped",
        "lowercase",
        "ALSO_OK",
      ],
    };
    const redacted = redactPlanForViewer(planData as never);
    expect(redacted.publicExplanationTokens).toEqual([
      "SATISFIES_ALL_PRIVATE_CONSTRAINTS",
      "ALSO_OK",
    ]);
  });
});

describe("visibility bleed — audit summary keys (spec §10.2)", () => {
  it("rejects summary that includes a confidential valueJson key", () => {
    expect(() => whitelistSummary({
      proposalId: "p1",
      valueJson: { amountUsd: 2500 },
    })).toThrow();
  });

  it("accepts summary with explicit low-cardinality enums only", () => {
    const safe = whitelistSummary({
      proposalId: "p1",
      factId: "f1",
      revision: 3,
      fieldCategory: "budget_max",
      visibility: "ORCHESTRATOR_CONFIDENTIAL",
      strength: "HARD",
      outcome: "success",
    });
    expect(safe).toMatchObject({
      fieldCategory: "budget_max",
      visibility: "ORCHESTRATOR_CONFIDENTIAL",
    });
  });
});
