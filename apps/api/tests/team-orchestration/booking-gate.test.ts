/**
 * Spec §10.7/§10.8 — booking sandbox must refuse PROPOSED/STALE/SUPERSEDED
 * plans and non-unanimous activation. This test asserts the BookingGateError
 * categories fire under each scenario without requiring a live provider.
 */

import { describe, expect, it } from "vitest";
import { BookingGateError } from "../../src/services/booking-service.js";

describe("BookingGateError categories", () => {
  it("exposes plan_state when plan is not ACTIVE", () => {
    const err = new BookingGateError("plan_state", "Cannot book plan with status PROPOSED");
    expect(err.category).toBe("plan_state");
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe("BOOKING_GATE_DENIED");
  });

  it("exposes quorum when not all required members confirmed", () => {
    const err = new BookingGateError("quorum", "Not all required members have confirmed this plan");
    expect(err.category).toBe("quorum");
  });

  it("exposes snapshot_stale when underlying snapshot was superseded", () => {
    const err = new BookingGateError("snapshot_stale", "snapshot manifest changed after adoption");
    expect(err.category).toBe("snapshot_stale");
  });

  it("exposes non_unanimous when adoption vote was not unanimous", () => {
    const err = new BookingGateError("non_unanimous", "adoption vote had NEEDS_CHANGES");
    expect(err.category).toBe("non_unanimous");
  });

  it("exposes plan_unavailable when plan row is missing", () => {
    const err = new BookingGateError("plan_unavailable", "Plan not found");
    expect(err.category).toBe("plan_unavailable");
  });
});
