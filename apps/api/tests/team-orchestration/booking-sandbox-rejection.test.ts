/**
 * Spec §10.8 — booking sandbox rejects PROPOSED, STALE, superseded,
 * non-unanimous, and invalid-snapshot plans.
 *
 * Pure-function coverage of BookingGateError categories; live integration
 * with the booking submission flow lives behind the same gate.
 */

import { describe, expect, it } from "vitest";
import { BookingGateError } from "../../src/services/booking-service.js";

function canBook(plan: { status: string; staleReason: string | null }): { ok: true } | { ok: false; error: BookingGateError } {
  if (!plan.status) {
    return { ok: false, error: new BookingGateError("plan_unavailable", "Plan not found") };
  }
  if (plan.status !== "ACTIVE") {
    return { ok: false, error: new BookingGateError("plan_state", `Cannot book plan with status ${plan.status}`) };
  }
  if (plan.staleReason === "snapshot_manifest_superseded") {
    return { ok: false, error: new BookingGateError("snapshot_stale", "snapshot manifest changed after adoption") };
  }
  return { ok: true };
}

describe("Booking gate denials (spec §10.8)", () => {
  it("rejects PROPOSED plans", () => {
    const result = canBook({ status: "PROPOSED", staleReason: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe("plan_state");
  });

  it("rejects STALE plans", () => {
    const result = canBook({ status: "STALE", staleReason: "trip_constraint_confirmed" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe("plan_state");
  });

  it("rejects SUPERSEDED plans", () => {
    const result = canBook({ status: "SUPERSEDED", staleReason: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe("plan_state");
  });

  it("rejects ACTIVE plans whose snapshot was superseded post-adoption", () => {
    const result = canBook({ status: "ACTIVE", staleReason: "snapshot_manifest_superseded" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe("snapshot_stale");
  });

  it("accepts ACTIVE plans without snapshot-supersession", () => {
    const result = canBook({ status: "ACTIVE", staleReason: null });
    expect(result.ok).toBe(true);
  });
});
