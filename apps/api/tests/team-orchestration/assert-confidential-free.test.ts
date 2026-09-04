/**
 * Spec §10.2 deterministic check coverage — `assertConfidentialFree` must
 * refuse any plan that leaks a confidential value or field-key reference,
 * while still accepting plans that carry only allow-listed public tokens.
 *
 * Pure-function tests; does not require the test DB.
 */

import { describe, expect, it } from "vitest";
import {
  assertConfidentialFree,
  type ValidatedPlanOutput,
} from "../../src/policy/plan-output-validator.js";
import type { ConstraintSnapshotData } from "../../src/types/domain.js";

function buildPlan(overrides: Partial<ValidatedPlanOutput> = {}): ValidatedPlanOutput {
  return {
    destination: "Tokyo",
    destinationCandidatesEvaluated: ["Tokyo", "Bangkok"],
    flights: [{
      id: "f1",
      providerOfferId: "po1",
      providerName: "test",
      queryId: "00000000-0000-0000-0000-000000000000",
      origin: "San Francisco",
      destination: "Tokyo",
      segments: [{
        carrierCode: "UA",
        flightNumber: "1",
        origin: "San Francisco",
        destination: "Tokyo",
        departureAt: "2026-09-01T10:00:00Z",
        arrivalAt: "2026-09-02T14:00:00Z",
        duration: "28h",
      }],
      totalDuration: "28h",
      totalPrice: 1000,
      currency: "USD",
      cabin: "ECONOMY",
      adults: 1,
      baggageSummary: "1pc",
      changeSummary: null,
      source: "test",
      capturedAt: "2026-08-29T00:00:00Z",
      expiresAt: "2026-09-08T00:00:00Z",
    }],
    stays: [{
      id: "s1",
      destination: "Tokyo",
      checkIn: "2026-09-02",
      checkOut: "2026-09-05",
      pricePerNightUsd: 120,
      style: "city_center",
      location: "Shinjuku",
      source: "test",
      capturedAt: "2026-08-29T00:00:00Z",
    }],
    generatedAt: "2026-08-29T00:00:00Z",
    ...overrides,
  };
}

function buildSnapshot(authorizedData: unknown): ConstraintSnapshotData {
  return {
    authorizedData: authorizedData as Record<string, unknown>,
    departureCities: ["San Francisco"],
    destinationCandidates: ["Tokyo", "Bangkok"],
  };
}

describe("assertConfidentialFree", () => {
  it("rejects a plan whose publicExplanationTokens contains a non-allow-listed token", () => {
    const snapshot = buildSnapshot({
      _meta: {
        schemaVersion: 2,
        memberAliases: { "00000000-0000-0000-0000-000000000001": "m_abc" },
        teamVisible: { m_abc: [] },
        orchestratorConfidential: {
          m_abc: [{
            fieldKey: "budget_max",
            valueJson: { amountUsd: 2500 },
            strength: "HARD",
            visibility: "ORCHESTRATOR_CONFIDENTIAL",
            sourceType: "TRIP_FACT",
            sourceId: "f1",
          }],
        },
        projectionManifest: [],
      },
    });
    // Embedded confidential value triggers CONFIDENTIAL_VALUE_LEAK via the
    // byte-substring scan over the plan JSON.
    const plan = buildPlan({
      destinationCandidatesEvaluated: ["Tokyo", "Bangkok"],
      publicExplanationTokens: ["SATISFIES_ALL_PRIVATE_CONSTRAINTS", "amountUsd:2500"],
    });
    const violations: { code: string }[] = [];
    assertConfidentialFree({ plan, snapshot, violations });
    const codes = violations.map(v => v.code);
    expect(codes).toContain("EXPLANATION_TOKEN_NOT_ALLOWED");
  });

  it("rejects plan whose publicExplanationTokens contains an unlisted token", () => {
    const snapshot = buildSnapshot({
      _meta: {
        schemaVersion: 2,
        memberAliases: { "00000000-0000-0000-0000-000000000001": "m_abc" },
        teamVisible: { m_abc: [] },
        orchestratorConfidential: {
          m_abc: [{
            fieldKey: "budget_max",
            valueJson: { amountUsd: 2500 },
            strength: "HARD",
            visibility: "ORCHESTRATOR_CONFIDENTIAL",
            sourceType: "TRIP_FACT",
            sourceId: "f1",
          }],
        },
        projectionManifest: [],
      },
    });
    const plan = buildPlan({
      destinationCandidatesEvaluated: ["Tokyo", "Bangkok"],
      publicExplanationTokens: ["SOME_RANDOM_NARRATIVE"],
    });
    const violations: { code: string }[] = [];
    assertConfidentialFree({ plan, snapshot, violations });
    expect(violations.find(v => v.code === "EXPLANATION_TOKEN_NOT_ALLOWED")).toBeTruthy();
  });

  it("accepts a plan with allow-listed tokens and no leaked values", () => {
    const snapshot = buildSnapshot({
      _meta: {
        schemaVersion: 2,
        memberAliases: { "00000000-0000-0000-0000-000000000001": "m_abc" },
        teamVisible: { m_abc: [] },
        orchestratorConfidential: {
          m_abc: [{
            fieldKey: "budget_max",
            valueJson: { amountUsd: 2500 },
            strength: "HARD",
            visibility: "ORCHESTRATOR_CONFIDENTIAL",
            sourceType: "TRIP_FACT",
            sourceId: "f1",
          }],
        },
        projectionManifest: [],
      },
    });
    const plan = buildPlan({
      destinationCandidatesEvaluated: ["Tokyo", "Bangkok"],
      publicExplanationTokens: ["OPTIMIZED_FOR_BUDGET", "SATISFIES_ALL_PRIVATE_CONSTRAINTS"],
    });
    const violations: { code: string }[] = [];
    assertConfidentialFree({ plan, snapshot, violations });
    expect(violations).toEqual([]);
  });

  it("rejects a value held only in the long-term-memory confidential namespace", () => {
    const snapshot = buildSnapshot({
      _meta: {
        schemaVersion: 2, memberAliases: {}, teamVisible: {}, orchestratorConfidential: {}, projectionManifest: [],
        memory: {
          members: {
            "m-alice": {
              profileFacts: {}, tripOverrides: {}, confidentialOverrides: { budget_max_usd: 1200 },
            },
          },
          groupDecisions: {},
        },
      },
    });
    const violations: { code: string }[] = [];
    assertConfidentialFree({ plan: buildPlan({ destination: "Budget 1200 Tokyo" }), snapshot, violations });
    expect(violations.map((violation) => violation.code)).toContain("CONFIDENTIAL_VALUE_LEAK");
  });
});
