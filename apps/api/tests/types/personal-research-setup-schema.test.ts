import { describe, expect, it } from "vitest";

import {
  personalResearchSetupAnswerSchema,
  personalResearchSetupSessionResponseSchema,
} from "../../src/types/schemas.js";

describe("personalResearchSetupAnswerSchema", () => {
  it("accepts a complete ordered date range as one patch", () => {
    const result = personalResearchSetupAnswerSchema.safeParse({
      field: "travelDates",
      value: { start: "2026-10-12", end: "2026-10-15" },
    });

    expect(result.success).toBe(true);
  });

  it("rejects an unordered date range", () => {
    const result = personalResearchSetupAnswerSchema.safeParse({
      field: "travelDates",
      value: { start: "2026-10-15", end: "2026-10-12" },
    });

    expect(result.success).toBe(false);
  });

  it("rejects legacy single-date patches that violate the date-pair invariant", () => {
    const result = personalResearchSetupAnswerSchema.safeParse({
      field: "travelDateStart",
      value: "2026-10-12",
    });

    expect(result.success).toBe(false);
  });

  // ─── Quick orchestration — budget hint patch ──────────────────────────────
  it("accepts a budget hint patch with valid amount + currency + cadence", () => {
    const result = personalResearchSetupAnswerSchema.safeParse({
      field: "budget",
      value: { amount: 5000, currency: "USD", cadence: "TOTAL" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a budget hint with PER_NIGHT cadence", () => {
    const result = personalResearchSetupAnswerSchema.safeParse({
      field: "budget",
      value: { amount: 250, currency: "EUR", cadence: "PER_NIGHT" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a budget hint with PER_PERSON cadence", () => {
    const result = personalResearchSetupAnswerSchema.safeParse({
      field: "budget",
      value: { amount: 1500, currency: "JPY", cadence: "PER_PERSON" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a budget hint with non-positive amount", () => {
    const result = personalResearchSetupAnswerSchema.safeParse({
      field: "budget",
      value: { amount: 0, currency: "USD", cadence: "TOTAL" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a budget hint with negative amount", () => {
    const result = personalResearchSetupAnswerSchema.safeParse({
      field: "budget",
      value: { amount: -100, currency: "USD", cadence: "TOTAL" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a budget hint with amount > 1_000_000", () => {
    const result = personalResearchSetupAnswerSchema.safeParse({
      field: "budget",
      value: { amount: 1_000_001, currency: "USD", cadence: "TOTAL" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a budget hint with non-3-letter currency", () => {
    const result = personalResearchSetupAnswerSchema.safeParse({
      field: "budget",
      value: { amount: 5000, currency: "DOLLARS", cadence: "TOTAL" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a budget hint with lowercase currency code", () => {
    const result = personalResearchSetupAnswerSchema.safeParse({
      field: "budget",
      value: { amount: 5000, currency: "usd", cadence: "TOTAL" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a budget hint with unknown cadence", () => {
    const result = personalResearchSetupAnswerSchema.safeParse({
      field: "budget",
      value: { amount: 5000, currency: "USD", cadence: "PER_WEEK" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a budget hint with missing cadence", () => {
    const result = personalResearchSetupAnswerSchema.safeParse({
      field: "budget",
      value: { amount: 5000, currency: "USD" },
    });
    expect(result.success).toBe(false);
  });
});

describe("personalResearchSetupSessionResponseSchema — budgetHint projection", () => {
  const baseSession = {
    intentRunId: "00000000-0000-4000-8000-000000000001",
    tripId: "00000000-0000-4000-8000-000000000002",
    ownerUserId: "00000000-0000-4000-8000-000000000003",
    departureCity: null,
    travelDateStart: null,
    travelDateEnd: null,
    stayPreferences: null,
    flightPreferences: null,
    budgetHint: null,
    missing: ["DATES_MISSING"],
    version: 1,
    status: "OPEN" as const,
    expiresAt: "2026-10-12T00:00:00.000Z",
  };

  it("accepts budgetHint: null (no hint on this session)", () => {
    const result = personalResearchSetupSessionResponseSchema.safeParse({
      ...baseSession,
      budgetHint: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a populated budgetHint", () => {
    const result = personalResearchSetupSessionResponseSchema.safeParse({
      ...baseSession,
      budgetHint: { amount: 5000, currency: "USD", cadence: "TOTAL" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts BUDGET_HINT_MISSING in the missing[] (warning, surfaced for UI)", () => {
    const result = personalResearchSetupSessionResponseSchema.safeParse({
      ...baseSession,
      missing: ["DATES_MISSING", "BUDGET_HINT_MISSING"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects malformed budgetHint (negative amount)", () => {
    const result = personalResearchSetupSessionResponseSchema.safeParse({
      ...baseSession,
      budgetHint: { amount: -1, currency: "USD", cadence: "TOTAL" },
    });
    expect(result.success).toBe(false);
  });
});
