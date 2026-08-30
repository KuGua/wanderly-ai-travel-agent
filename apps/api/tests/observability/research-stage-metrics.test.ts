import { describe, expect, it } from "vitest";
import { metrics } from "../../src/observability/metrics.js";

describe("research-stage metrics — Phase 3", () => {
  it("exposes research_stage_total with bounded labels", () => {
    metrics.inc("research_stage_total", { stage: "researching", outcome: "success" });
    expect(true).toBe(true);
  });

  it("rejects an unbounded stage value", () => {
    expect(() =>
      // @ts-expect-error — Phase 3 wired `stage` as a bounded enum.
      metrics.inc("research_stage_total", { stage: "FREE_FORM_STAGE", outcome: "success" }),
    ).toThrow(/unbound/);
  });

  it("rejects an unbounded outcome value", () => {
    expect(() =>
      // @ts-expect-error — Phase 3 wired `outcome` as a bounded enum.
      metrics.inc("research_stage_total", { stage: "researching", outcome: "WAT" }),
    ).toThrow(/unbound/);
  });

  it("exposes solo_plan_adoption_total with bounded outcomes", () => {
    metrics.inc("solo_plan_adoption_total", { outcome: "adopted" });
    metrics.inc("solo_plan_adoption_total", { outcome: "not_solo" });
    expect(true).toBe(true);
  });

  it("rejects an unknown outcome value for solo_plan_adoption_total", () => {
    expect(() =>
      // @ts-expect-error — bounded enum only.
      metrics.inc("solo_plan_adoption_total", { outcome: "totally_unknown" }),
    ).toThrow(/unbound/);
  });
});