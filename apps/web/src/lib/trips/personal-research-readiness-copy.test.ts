/**
 * Personal Research Readiness Copy — quick-orchestration BUDGET_HINT_MISSING.
 *
 * The BUDGET_HINT_MISSING code is the soft budget hint surfaced for Solo
 * trips when the owner has not declared a budget. It must be classified
 * as `warning` (never blocker), it must have a privacy-safe detail/ctaHint
 * pair, and the title must NEVER carry a price/currency token (the
 * conversation worker would otherwise fall into the safety-gate fallback
 * for live-fact / price triggers).
 */

import { describe, expect, it } from "vitest";

import {
  MISSING_COPY,
  partitionMissingCodes,
  type PersonalResearchMissingCode,
} from "@/lib/trips/personal-research-readiness-copy";

describe("MISSING_COPY.BUDGET_HINT_MISSING", () => {
  it("is registered as a warning (never a blocker)", () => {
    expect(MISSING_COPY.BUDGET_HINT_MISSING.severity).toBe("warning");
  });

  it("does not embed a price or currency token (safety-gate trigger)", () => {
    const { title, detail, ctaHint } = MISSING_COPY.BUDGET_HINT_MISSING;
    const text = `${title} ${detail} ${ctaHint}`;
    expect(text).not.toMatch(/[¥$€£]|USD|CNY|TWD|JPY|EUR|HKD|SGD/);
    // Never bake a hard number into the copy — owners supply their own.
    expect(text).not.toMatch(/\b\d{3,}\b/);
  });

  it("has a non-empty title, detail, and ctaHint", () => {
    expect(MISSING_COPY.BUDGET_HINT_MISSING.title.length).toBeGreaterThan(0);
    expect(MISSING_COPY.BUDGET_HINT_MISSING.detail.length).toBeGreaterThan(0);
    expect(MISSING_COPY.BUDGET_HINT_MISSING.ctaHint.length).toBeGreaterThan(0);
  });
});

describe("partitionMissingCodes with BUDGET_HINT_MISSING", () => {
  it("places BUDGET_HINT_MISSING in warnings, not blockers", () => {
    const codes: PersonalResearchMissingCode[] = [
      "DATES_MISSING",
      "BUDGET_HINT_MISSING",
    ];
    const { blockers, warnings } = partitionMissingCodes(codes);
    expect(blockers).toContain("DATES_MISSING");
    expect(blockers).not.toContain("BUDGET_HINT_MISSING");
    expect(warnings).toContain("BUDGET_HINT_MISSING");
  });

  it("handles budget-only arrays without throwing", () => {
    const { blockers, warnings } = partitionMissingCodes(["BUDGET_HINT_MISSING"]);
    expect(blockers).toEqual([]);
    expect(warnings).toContain("BUDGET_HINT_MISSING");
  });
});