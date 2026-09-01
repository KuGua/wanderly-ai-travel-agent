/**
 * Personal Research Readiness Service — Phase 0/1/2.
 *
 * Verifies the read-only readiness gate against real DB fixtures. The
 * service is the single source of truth for "can the owner confirm this
 * draft right now?" — every code path branches on a different owner-
 * observable state. Missing a gap here surfaces as a runtime provider
 * call that should never have fired.
 *
 * Phase 2 — Two-tier model: `blockers[]` is the hard set the owner MUST
 * resolve before research can start; `warnings[]` is advisory and the
 * owner can proceed past it. `missing[]` is retained as the union of
 * both for backward compatibility. See
 * docs/personal-research-intent-routing-implementation.md §5.2.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "../../src/db/database.js";
import {
  sharedTrips,
  tripMembers,
  tripPlaces,
  tripSearchPreferences,
  tripStaySearchPreferences,
  users,
} from "../../src/db/schema.js";
import {
  categorize,
  evaluateReadiness,
  type ResearchMissingCode,
} from "../../src/services/personal-research-readiness-service.js";

describe("personal-research-readiness-service", () => {
  let ownerId: string;
  let tripId: string;
  // IDs of rows we created, so afterEach can clean them up without
  // colliding with parallel suites.
  let createdPlaceIds: string[] = [];

  beforeEach(async () => {
    const [u] = await db.insert(users).values({
      externalId: `readiness-test-${randomUUID()}`,
      displayName: "readiness-test",
    }).returning();
    ownerId = u.id;

    const [trip] = await db.insert(sharedTrips).values({
      name: `readiness-test-${randomUUID()}`,
      createdBy: ownerId,
      status: "PLANNING",
      departureCities: ["San Francisco"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: "2026-09-01",
      travelDateEnd: "2026-09-07",
    }).returning();
    tripId = trip.id;

    await db.insert(tripMembers).values({
      tripId,
      userId: ownerId,
      role: "CREATOR",
      isRequired: true,
    });
    createdPlaceIds = [];
  });

  afterEach(async () => {
    if (createdPlaceIds.length > 0) {
      await db.delete(tripPlaces).where(eq(tripPlaces.tripId, tripId));
    }
    await db.delete(tripStaySearchPreferences).where(eq(tripStaySearchPreferences.tripId, tripId));
    await db.delete(tripSearchPreferences).where(eq(tripSearchPreferences.tripId, tripId));
    await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
    await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
    await db.delete(users).where(eq(users.id, ownerId));
  });

  // ─── categorize() ──────────────────────────────────────────────────────────
  describe("categorize()", () => {
    it.each<ResearchMissingCode>([
      "TRIP_NOT_ACTIVE",
      "FLIGHT_PREFERENCES_MISSING",
      "STAY_PREFERENCES_MISSING",
    ])("classifies %s as a warning", (code) => {
      expect(categorize(code)).toBe("warning");
    });

    it.each<ResearchMissingCode>([
      "DESTINATION_NOT_CONFIGURED",
      "DATES_MISSING",
      "HOTEL_PROVIDER_NOT_APPROVED",
      "QUOTE_NATIONALITY_AUTHORIZATION_MISSING",
      "ROUTE_ENDPOINTS_UNCONFIRMED",
      "MODE_NOT_CHOSEN",
    ])("classifies %s as a blocker", (code) => {
      expect(categorize(code)).toBe("blocker");
    });
  });

  // ─── Happy path ────────────────────────────────────────────────────────────
  it("returns READY for a fully-configured hotel-capability request", async () => {
    const original = process.env.PLAN_ENABLE_HOTEL;
    process.env.PLAN_ENABLE_HOTEL = "true";
    try {
      await db.insert(tripStaySearchPreferences).values({
        tripId,
        version: 1,
        roomCount: 1,
        adultsPerRoom: [2],
        currency: "USD",
        confirmedBy: ownerId,
      });
      const result = await evaluateReadiness({
        tripId,
        ownerUserId: ownerId,
        requestedCapabilities: ["hotel"],
      });
      // PLANNING status — no advisory, no hard gaps.
      expect(result).toEqual({
        readiness: "READY",
        blockers: [],
        warnings: [],
        missing: [],
      });
    } finally {
      if (original === undefined) delete process.env.PLAN_ENABLE_HOTEL;
      else process.env.PLAN_ENABLE_HOTEL = original;
    }
  });

  // ─── Trip-status gates ─────────────────────────────────────────────────────
  it("returns TRIP_NOT_ACTIVE as a hard blocker when trip does not exist", async () => {
    const result = await evaluateReadiness({
      tripId: randomUUID(),
      ownerUserId: ownerId,
      requestedCapabilities: ["hotel"],
    });
    // Trip missing entirely — `TRIP_NOT_ACTIVE` is repurposed as a hard
    // blocker here because you cannot research what does not exist.
    expect(result).toEqual({
      readiness: "NEEDS_SETUP",
      blockers: ["TRIP_NOT_ACTIVE"],
      warnings: [],
      missing: ["TRIP_NOT_ACTIVE"],
    });
  });

  it("returns READY_WITH_WARNINGS with TRIP_NOT_ACTIVE advisory for DRAFT trip", async () => {
    // Phase 2: DRAFT trips are research-eligible. The advisory invites
    // the owner to finalize the trip before running research, but the
    // research command can still go through.
    await db.update(sharedTrips).set({ status: "DRAFT" }).where(eq(sharedTrips.id, tripId));
    const result = await evaluateReadiness({
      tripId,
      ownerUserId: ownerId,
      requestedCapabilities: ["hotel"],
    });
    // PLANNING-style defaults plus the DRAFT status. Hotel capability
    // requested with PLAN_ENABLE_HOTEL unset surfaces a hard blocker —
    // but the TRIP_NOT_ACTIVE advisory is in `warnings`, not `blockers`.
    expect(result).toEqual({
      readiness: "NEEDS_SETUP",
      blockers: ["HOTEL_PROVIDER_NOT_APPROVED"],
      warnings: ["TRIP_NOT_ACTIVE"],
      missing: ["HOTEL_PROVIDER_NOT_APPROVED", "TRIP_NOT_ACTIVE"],
    });
  });

  it("returns READY_WITH_WARNINGS for DRAFT trip with hotel enabled and prefs set", async () => {
    const original = process.env.PLAN_ENABLE_HOTEL;
    process.env.PLAN_ENABLE_HOTEL = "true";
    try {
      await db.update(sharedTrips).set({ status: "DRAFT" }).where(eq(sharedTrips.id, tripId));
      await db.insert(tripStaySearchPreferences).values({
        tripId,
        version: 1,
        roomCount: 1,
        adultsPerRoom: [2],
        currency: "USD",
        confirmedBy: ownerId,
      });
      const result = await evaluateReadiness({
        tripId,
        ownerUserId: ownerId,
        requestedCapabilities: ["hotel"],
      });
      expect(result).toEqual({
        readiness: "READY_WITH_WARNINGS",
        blockers: [],
        warnings: ["TRIP_NOT_ACTIVE"],
        missing: ["TRIP_NOT_ACTIVE"],
      });
    } finally {
      if (original === undefined) delete process.env.PLAN_ENABLE_HOTEL;
      else process.env.PLAN_ENABLE_HOTEL = original;
    }
  });

  it("returns READY_WITH_WARNINGS for CANCELED trip with everything else configured", async () => {
    // Phase 2: CANCELED trips are also research-eligible (per product
    // intent — user wants to be able to research even canceled trips).
    const original = process.env.PLAN_ENABLE_HOTEL;
    process.env.PLAN_ENABLE_HOTEL = "true";
    try {
      await db.update(sharedTrips).set({ status: "CANCELLED" }).where(eq(sharedTrips.id, tripId));
      await db.insert(tripStaySearchPreferences).values({
        tripId,
        version: 1,
        roomCount: 1,
        adultsPerRoom: [2],
        currency: "USD",
        confirmedBy: ownerId,
      });
      const result = await evaluateReadiness({
        tripId,
        ownerUserId: ownerId,
        requestedCapabilities: ["hotel"],
      });
      expect(result).toEqual({
        readiness: "READY_WITH_WARNINGS",
        blockers: [],
        warnings: ["TRIP_NOT_ACTIVE"],
        missing: ["TRIP_NOT_ACTIVE"],
      });
    } finally {
      if (original === undefined) delete process.env.PLAN_ENABLE_HOTEL;
      else process.env.PLAN_ENABLE_HOTEL = original;
    }
  });

  it("returns TRIP_NOT_ACTIVE as a hard blocker when owner is no longer a required member", async () => {
    await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
    const result = await evaluateReadiness({
      tripId,
      ownerUserId: ownerId,
      requestedCapabilities: ["hotel"],
    });
    // Membership failure masked as TRIP_NOT_ACTIVE for wire stability —
    // the underlying 403 still propagates to non-readiness callers.
    expect(result).toEqual({
      readiness: "NEEDS_SETUP",
      blockers: ["TRIP_NOT_ACTIVE"],
      warnings: [],
      missing: ["TRIP_NOT_ACTIVE"],
    });
  });

  // ─── Trip-config gates ─────────────────────────────────────────────────────
  it("returns DESTINATION_NOT_CONFIGURED when destinationCandidates is empty", async () => {
    await db.update(sharedTrips).set({ destinationCandidates: [] }).where(eq(sharedTrips.id, tripId));
    const result = await evaluateReadiness({
      tripId,
      ownerUserId: ownerId,
      requestedCapabilities: ["flight"],
    });
    // Use ["flight"] capabilities to isolate the destination check from
    // the hotel-provider gate (PLAN_ENABLE_HOTEL is unset by default).
    expect(result).toEqual({
      readiness: "NEEDS_SETUP",
      blockers: ["DESTINATION_NOT_CONFIGURED"],
      warnings: [],
      missing: ["DESTINATION_NOT_CONFIGURED"],
    });
  });

  it("returns DATES_MISSING when travel dates are absent", async () => {
    await db.update(sharedTrips).set({
      travelDateStart: null,
      travelDateEnd: null,
    }).where(eq(sharedTrips.id, tripId));
    const result = await evaluateReadiness({
      tripId,
      ownerUserId: ownerId,
      requestedCapabilities: ["flight"],
    });
    expect(result).toEqual({
      readiness: "NEEDS_SETUP",
      blockers: ["DATES_MISSING"],
      warnings: [],
      missing: ["DATES_MISSING"],
    });
  });

  // ─── Capability-specific gates ─────────────────────────────────────────────
  it("returns FLIGHT_PREFERENCES_MISSING as a soft warning for flight without preferences", async () => {
    // Phase 2: flight preferences missing is a warning, not a blocker.
    const result = await evaluateReadiness({
      tripId,
      ownerUserId: ownerId,
      requestedCapabilities: ["flight"],
    });
    expect(result).toEqual({
      readiness: "READY_WITH_WARNINGS",
      blockers: [],
      warnings: ["FLIGHT_PREFERENCES_MISSING"],
      missing: ["FLIGHT_PREFERENCES_MISSING"],
    });
  });

  it("returns READY for flight capability when preferences exist", async () => {
    await db.insert(tripSearchPreferences).values({
      tripId,
      version: 1,
      tripType: "ROUND_TRIP",
      currency: "USD",
      adults: 2,
      cabin: "ECONOMY",
      offerFreshnessMinutes: 60,
      confirmedBy: ownerId,
    });
    const result = await evaluateReadiness({
      tripId,
      ownerUserId: ownerId,
      requestedCapabilities: ["flight"],
    });
    expect(result).toEqual({
      readiness: "READY",
      blockers: [],
      warnings: [],
      missing: [],
    });
  });

  it("returns STAY_PREFERENCES_MISSING as a soft warning for hotel without stay prefs", async () => {
    // Force hotel feature flag on for this assertion; otherwise the result
    // would surface HOTEL_PROVIDER_NOT_APPROVED first.
    const original = process.env.PLAN_ENABLE_HOTEL;
    process.env.PLAN_ENABLE_HOTEL = "true";
    try {
      const result = await evaluateReadiness({
        tripId,
        ownerUserId: ownerId,
        requestedCapabilities: ["hotel"],
      });
      expect(result).toEqual({
        readiness: "READY_WITH_WARNINGS",
        blockers: [],
        warnings: ["STAY_PREFERENCES_MISSING"],
        missing: ["STAY_PREFERENCES_MISSING"],
      });
    } finally {
      if (original === undefined) delete process.env.PLAN_ENABLE_HOTEL;
      else process.env.PLAN_ENABLE_HOTEL = original;
    }
  });

  it("returns HOTEL_PROVIDER_NOT_APPROVED when PLAN_ENABLE_HOTEL is false", async () => {
    const original = process.env.PLAN_ENABLE_HOTEL;
    process.env.PLAN_ENABLE_HOTEL = "false";
    try {
      const result = await evaluateReadiness({
        tripId,
        ownerUserId: ownerId,
        requestedCapabilities: ["hotel"],
      });
      expect(result).toEqual({
        readiness: "NEEDS_SETUP",
        blockers: ["HOTEL_PROVIDER_NOT_APPROVED"],
        warnings: [],
        missing: ["HOTEL_PROVIDER_NOT_APPROVED"],
      });
    } finally {
      if (original === undefined) delete process.env.PLAN_ENABLE_HOTEL;
      else process.env.PLAN_ENABLE_HOTEL = original;
    }
  });

  // ─── Place-selection gates ─────────────────────────────────────────────────
  it("returns NEEDS_PLACE_SELECTION for navigation when no ACTIVE non-private places exist", async () => {
    const result = await evaluateReadiness({
      tripId,
      ownerUserId: ownerId,
      requestedCapabilities: ["navigation"],
    });
    expect(result).toEqual({
      readiness: "NEEDS_PLACE_SELECTION",
      blockers: ["ROUTE_ENDPOINTS_UNCONFIRMED"],
      warnings: [],
      missing: ["ROUTE_ENDPOINTS_UNCONFIRMED"],
    });
  });

  it("returns NEEDS_PLACE_SELECTION when only one ACTIVE place exists", async () => {
    const [p] = await db.insert(tripPlaces).values({
      tripId,
      ownerUserId: ownerId,
      visibility: "TEAM_VISIBLE",
      status: "ACTIVE",
      kind: "ATTRACTION",
      displayName: "Place A",
      source: "seed",
    }).returning();
    createdPlaceIds.push(p.id);
    const result = await evaluateReadiness({
      tripId,
      ownerUserId: ownerId,
      requestedCapabilities: ["navigation"],
    });
    expect(result).toEqual({
      readiness: "NEEDS_PLACE_SELECTION",
      blockers: ["ROUTE_ENDPOINTS_UNCONFIRMED"],
      warnings: [],
      missing: ["ROUTE_ENDPOINTS_UNCONFIRMED"],
    });
  });

  it("returns NEEDS_PLACE_SELECTION when one place is OWNER_PRIVATE", async () => {
    // Two ACTIVE places exist, but one is OWNER_PRIVATE — loadRoutablePlaces
    // excludes OWNER_PRIVATE, so only one routable place remains.
    const [p1] = await db.insert(tripPlaces).values({
      tripId,
      ownerUserId: ownerId,
      visibility: "OWNER_PRIVATE",
      status: "ACTIVE",
      kind: "ATTRACTION",
      displayName: "Private Place",
      source: "seed",
    }).returning();
    const [p2] = await db.insert(tripPlaces).values({
      tripId,
      ownerUserId: ownerId,
      visibility: "TEAM_VISIBLE",
      status: "ACTIVE",
      kind: "ATTRACTION",
      displayName: "Visible Place",
      source: "seed",
    }).returning();
    createdPlaceIds.push(p1.id, p2.id);
    const result = await evaluateReadiness({
      tripId,
      ownerUserId: ownerId,
      requestedCapabilities: ["navigation"],
    });
    expect(result).toEqual({
      readiness: "NEEDS_PLACE_SELECTION",
      blockers: ["ROUTE_ENDPOINTS_UNCONFIRMED"],
      warnings: [],
      missing: ["ROUTE_ENDPOINTS_UNCONFIRMED"],
    });
  });

  it("returns READY for navigation when two ACTIVE non-private places exist", async () => {
    const [p1] = await db.insert(tripPlaces).values({
      tripId,
      ownerUserId: ownerId,
      visibility: "TEAM_VISIBLE",
      status: "ACTIVE",
      kind: "ATTRACTION",
      displayName: "Origin",
      source: "seed-a",
    }).returning();
    const [p2] = await db.insert(tripPlaces).values({
      tripId,
      ownerUserId: ownerId,
      visibility: "TEAM_VISIBLE",
      status: "ACTIVE",
      kind: "ATTRACTION",
      displayName: "Destination",
      source: "seed-b",
    }).returning();
    createdPlaceIds.push(p1.id, p2.id);
    const result = await evaluateReadiness({
      tripId,
      ownerUserId: ownerId,
      requestedCapabilities: ["navigation"],
    });
    expect(result).toEqual({
      readiness: "READY",
      blockers: [],
      warnings: [],
      missing: [],
    });
  });

  // ─── Invariants ────────────────────────────────────────────────────────────
  it("NEEDS_PLACE_SELECTION never carries non-route missing codes", async () => {
    const result = await evaluateReadiness({
      tripId,
      ownerUserId: ownerId,
      requestedCapabilities: ["navigation"],
    });
    if (result.readiness === "NEEDS_PLACE_SELECTION") {
      expect(result.blockers).toEqual(["ROUTE_ENDPOINTS_UNCONFIRMED"]);
      expect(result.missing).toEqual(["ROUTE_ENDPOINTS_UNCONFIRMED"]);
    } else {
      throw new Error("expected NEEDS_PLACE_SELECTION, got " + result.readiness);
    }
  });

  it("READY and READY_WITH_WARNINGS both carry an empty blockers array", async () => {
    const original = process.env.PLAN_ENABLE_HOTEL;
    process.env.PLAN_ENABLE_HOTEL = "true";
    try {
      await db.insert(tripStaySearchPreferences).values({
        tripId,
        version: 1,
        roomCount: 1,
        adultsPerRoom: [2],
        currency: "USD",
        confirmedBy: ownerId,
      });
      const result = await evaluateReadiness({
        tripId,
        ownerUserId: ownerId,
        requestedCapabilities: ["hotel"],
      });
      expect(["READY", "READY_WITH_WARNINGS"]).toContain(result.readiness);
      expect(result.blockers).toEqual([]);
    } finally {
      if (original === undefined) delete process.env.PLAN_ENABLE_HOTEL;
      else process.env.PLAN_ENABLE_HOTEL = original;
    }
  });

  it("handles PROPOSE_PLAN with the full capability surface — one missing collapses to NEEDS_SETUP", async () => {
    // PROPOSE_PLAN requests all capabilities. With flight pref missing
    // and hotel feature on but stay pref missing, both must surface as
    // warnings. Navigation/mobility would also surface, but the place
    // check fires first (no ACTIVE places) and returns NEEDS_PLACE_SELECTION.
    const original = process.env.PLAN_ENABLE_HOTEL;
    process.env.PLAN_ENABLE_HOTEL = "true";
    try {
      const result = await evaluateReadiness({
        tripId,
        ownerUserId: ownerId,
        requestedCapabilities: [
          "flight", "accommodation", "hotel", "activities",
          "places", "navigation", "mobility", "readiness",
        ],
      });
      expect(result.readiness).toBe("NEEDS_PLACE_SELECTION");
      expect(result.missing).toContain("ROUTE_ENDPOINTS_UNCONFIRMED");
    } finally {
      if (original === undefined) delete process.env.PLAN_ENABLE_HOTEL;
      else process.env.PLAN_ENABLE_HOTEL = original;
    }
  });
});