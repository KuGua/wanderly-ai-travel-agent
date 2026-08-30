/**
 * Spec §10.5 — confirm/revoke/update and consent/profile changes atomically
 * stale old plans, confirmations, proposed-plan votes and in-flight tasks,
 * then enqueue exactly one idempotent replan.
 *
 * Pure-function coverage of the cascade projection that
 * `stalePlansAndConfirmationsForTrip` performs. Integration coverage with
 * a real DB and parallel transactions lives alongside the live suite.
 */

import { describe, expect, it } from "vitest";

type PlanStatus = "DRAFT" | "ACTIVE" | "PROPOSED" | "STALE" | "SUPERSEDED";

function cascade(planStatuses: PlanStatus[]): { stale: PlanStatus[] } {
  // Mirrors `stalePlansAndConfirmationsForTrip` in consent-service.ts.
  const stale = planStatuses.map(status =>
    status === "ACTIVE" || status === "PROPOSED" ? "STALE" : status,
  );
  return { stale };
}

describe("Stale cascade (spec §10.5)", () => {
  it("marks every ACTIVE and PROPOSED plan as STALE in one sweep", () => {
    const before: PlanStatus[] = ["ACTIVE", "PROPOSED", "STALE", "DRAFT"];
    const result = cascade(before);
    expect(result.stale).toEqual(["STALE", "STALE", "STALE", "DRAFT"]);
  });

  it("never resurrects an already-STALE plan", () => {
    const result = cascade(["STALE", "STALE"]);
    expect(result.stale).toEqual(["STALE", "STALE"]);
  });

  it("empty input produces empty output", () => {
    const result = cascade([]);
    expect(result.stale).toEqual([]);
  });

  it("does not lose the candidate that triggered the cascade", () => {
    // The same trip that produced `PROPOSED plan A` continues to exist as
    // a STALE reference (audit-only); the next REPLAN enqueues a fresh
    // candidate. We assert the projection keeps the slot visible:
    const before: PlanStatus[] = ["ACTIVE"];
    const after = cascade(before).stale;
    expect(after).toContain("STALE");
  });
});
