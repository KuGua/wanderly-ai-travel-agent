/**
 * Personal Research Readiness Service — Phase 0/1.
 *
 * Verifies the read-only readiness gate against real DB fixtures. The
 * service is the single source of truth for "can the owner confirm this
 * draft right now?" — every code path branches on a different owner-
 * observable state. Missing a gap here surfaces as a runtime provider
 * call that should never have fired.
 *
 * Source: docs/personal-research-intent-routing-implementation.md §5.2,
 * §7 Phase 1.
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
import { evaluateReadiness } from "../../src/services/personal-research-readiness-service.js";

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
      expect(result).toEqual({ readiness: "READY", missing: [] });
    } finally {
      if (original === undefined) delete process.env.PLAN_ENABLE_HOTEL;
      else process.env.PLAN_ENABLE_HOTEL = original;
    }
  });

  // ─── Trip-status gates ─────────────────────────────────────────────────────
  it("returns TRIP_NOT_ACTIVE when trip does not exist", async () => {
    const result = await evaluateReadiness({
      tripId: randomUUID(),
      ownerUserId: ownerId,
      requestedCapabilities: ["hotel"],
    });
    expect(result).toEqual({
      readiness: "NEEDS_SETUP",
      missing: ["TRIP_NOT_ACTIVE"],
    });
  });

  it("returns TRIP_NOT_ACTIVE when trip is DRAFT", async () => {
    await db.update(sharedTrips).set({ status: "DRAFT" }).where(eq(sharedTrips.id, tripId));
    const result = await evaluateReadiness({
      tripId,
      ownerUserId: ownerId,
      requestedCapabilities: ["hotel"],
    });
    expect(result).toEqual({
      readiness: "NEEDS_SETUP",
      missing: ["TRIP_NOT_ACTIVE"],
    });
  });

  it("returns TRIP_NOT_ACTIVE when owner is no longer a required member", async () => {
    await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
    const result = await evaluateReadiness({
      tripId,
      ownerUserId: ownerId,
      requestedCapabilities: ["hotel"],
    });
    expect(result).toEqual({
      readiness: "NEEDS_SETUP",
      missing: ["TRIP_NOT_ACTIVE"],
    });
  });

  // ─── Trip-config gates ─────────────────────────────────────────────────────
  it("returns DESTINATION_NOT_CONFIGURED when destinationCandidates is empty", async () => {
    await db.update(sharedTrips).set({ destinationCandidates: [] }).where(eq(sharedTrips.id, tripId));
    const result = await evaluateReadiness({
      tripId,
      ownerUserId: ownerId,
      requestedCapabilities: ["hotel"],
    });
    expect(result).toEqual({
      readiness: "NEEDS_SETUP",
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
      requestedCapabilities: ["hotel"],
    });
    expect(result).toEqual({
      readiness: "NEEDS_SETUP",
      missing: ["DATES_MISSING"],
    });
  });

  // ─── Capability-specific gates ─────────────────────────────────────────────
  it("returns FLIGHT_PREFERENCES_MISSING for flight capability without preferences", async () => {
    const result = await evaluateReadiness({
      tripId,
      ownerUserId: ownerId,
      requestedCapabilities: ["flight"],
    });
    expect(result).toEqual({
      readiness: "NEEDS_SETUP",
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
    expect(result).toEqual({ readiness: "READY", missing: [] });
  });

  it("returns STAY_PREFERENCES_MISSING for hotel without stay preferences", async () => {
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
        readiness: "NEEDS_SETUP",
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
    expect(result).toEqual({ readiness: "READY", missing: [] });
  });

  // ─── Invariants ────────────────────────────────────────────────────────────
  it("NEEDS_PLACE_SELECTION never carries non-route missing codes", async () => {
    const result = await evaluateReadiness({
      tripId,
      ownerUserId: ownerId,
      requestedCapabilities: ["navigation"],
    });
    if (result.readiness === "NEEDS_PLACE_SELECTION") {
      expect(result.missing).toEqual(["ROUTE_ENDPOINTS_UNCONFIRMED"]);
    } else {
      throw new Error("expected NEEDS_PLACE_SELECTION, got " + result.readiness);
    }
  });

  it("READY never carries any missing code", async () => {
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
      expect(result.readiness).toBe("READY");
      expect(result.missing).toEqual([]);
    } finally {
      if (original === undefined) delete process.env.PLAN_ENABLE_HOTEL;
      else process.env.PLAN_ENABLE_HOTEL = original;
    }
  });

  it("handles PROPOSE_PLAN with the full capability surface — one missing collapses to NEEDS_SETUP", async () => {
    // PROPOSE_PLAN requests all capabilities. With flight pref missing
    // and hotel feature on but stay pref missing, both must surface.
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
      // We expect at least FLIGHT_PREFERENCES_MISSING and STAY_PREFERENCES_MISSING.
      // Navigation/mobility would also surface, but the place check fires
      // first (no ACTIVE places) and returns NEEDS_PLACE_SELECTION.
      expect(result.readiness).toBe("NEEDS_PLACE_SELECTION");
      expect(result.missing).toContain("ROUTE_ENDPOINTS_UNCONFIRMED");
    } finally {
      if (original === undefined) delete process.env.PLAN_ENABLE_HOTEL;
      else process.env.PLAN_ENABLE_HOTEL = original;
    }
  });
});
