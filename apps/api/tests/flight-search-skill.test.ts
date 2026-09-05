import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { __resetRegistryForTests, invokeSkill, registerSkill } from "../src/agents/skill-registry.js";
import { DefaultPolicyGate } from "../src/agents/policy-gate.js";
import { createFlightSearchSkill } from "../src/skills/shared/flight-search-skill.js";
import { agentTaskRuns } from "../src/db/schema.js";
import { db } from "../src/db/database.js";
import { auditEvents, constraintSnapshots, providerOffers, providerSearchRuns, sharedTrips, tripMembers, tripSearchPreferences, users } from "../src/db/schema.js";
import { saveConfirmedSearchPreferences } from "../src/services/flight-search-preferences-service.js";
import { createRequestContext } from "../src/utils/context.js";
import type { FlightProvider } from "../src/providers/types.js";

const snapshotData = {
  authorizedData: {}, departureCities: ["SFO"], destinationCandidates: ["NRT"],
  travelDateStart: "2026-10-01", travelDateEnd: "2026-10-10",
};
const input = {
  snapshotId: "", originId: "SFO", destinationId: "NRT", tripType: "ROUND_TRIP" as const,
  departureDate: "2026-10-01", returnDate: "2026-10-10", adults: 2, cabin: "ECONOMY" as const, currency: "USD",
};

function liveProvider(): FlightProvider {
  return { async searchFlights() {
    return {
      outcome: "LIVE" as const, source: "Test provider", capturedAt: "2026-08-28T00:00:00.000Z",
      data: [{
        id: "test:offer-1", providerOfferId: "offer-1", providerName: "amadeus",
        queryId: randomUUID(), origin: "SFO", destination: "NRT",
        segments: [{ carrierCode: "TA", flightNumber: "1", origin: "SFO", destination: "NRT", departureAt: "2026-10-01T08:00:00Z", arrivalAt: "2026-10-01T20:00:00Z", duration: "PT12H" }],
        totalDuration: "PT12H", totalPrice: 500, currency: "USD", cabin: "ECONOMY" as const, adults: 2,
        baggageSummary: null, changeSummary: null, source: "Test provider", capturedAt: "2026-08-28T00:00:00.000Z", expiresAt: "2026-08-28T01:00:00.000Z",
        expiryProvenance: "PROVIDER_VERIFIED" as const,
      }],
    };
  } };
}

describe("flight.search Shared Skill", () => {
  let userId: string;
  let tripId: string;
  let snapshotId: string;
  let preferenceVersion: number;

  beforeEach(async () => {
    __resetRegistryForTests();
    const [user] = await db.insert(users).values({ externalId: `flight-skill-${randomUUID()}`, displayName: "Flight skill test" }).returning();
    userId = user.id;
    const [trip] = await db.insert(sharedTrips).values({ name: "Flight skill trip", createdBy: userId, ...snapshotData }).returning();
    tripId = trip.id;
    await db.insert(tripMembers).values({ tripId, userId, role: "CREATOR", isRequired: true });
    const [snapshot] = await db.insert(constraintSnapshots).values({ tripId, version: 1, ...snapshotData }).returning();
    snapshotId = snapshot.id;
    const preference = await saveConfirmedSearchPreferences({
      ctx: createRequestContext(userId, randomUUID(), randomUUID()), tripId, confirmedBy: userId,
      input: { tripType: "ROUND_TRIP", currency: "USD", adults: 2, cabin: "ECONOMY", offerFreshnessMinutes: 30 },
    });
    preferenceVersion = preference.version;
    registerSkill(createFlightSearchSkill(liveProvider()));
  });

  afterEach(async () => {
    await db.delete(auditEvents).where(or(eq(auditEvents.tripId, tripId), eq(auditEvents.actorUserId, userId)));
    await db.delete(providerOffers).where(eq(providerOffers.snapshotId, snapshotId));
    await db.delete(providerSearchRuns).where(eq(providerSearchRuns.snapshotId, snapshotId));
    await db.delete(tripSearchPreferences).where(eq(tripSearchPreferences.tripId, tripId));
    await db.delete(constraintSnapshots).where(eq(constraintSnapshots.id, snapshotId));
    await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
    await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
    await db.delete(users).where(eq(users.id, userId));
  });

  function context(agent: "shared" | "personal" | "review" = "shared", overrides: Record<string, unknown> = {}) {
    return {
      ctx: createRequestContext(userId, randomUUID(), randomUUID()),
      snapshot: snapshotData,
      flightSearch: {
        tripId, snapshotId, searchPreferencesVersion: preferenceVersion,
        searchPreferences: { tripType: "ROUND_TRIP" as const, adults: 2, cabin: "ECONOMY" as const, currency: "USD" },
        ...overrides,
      },
      policyGate: new DefaultPolicyGate(agent),
    };
  }

  function request(overrides: Record<string, unknown> = {}) {
    return { ...input, snapshotId, ...overrides };
  }

  it("executes a valid Shared invocation and returns only normalized LIVE data", async () => {
    const output = await invokeSkill("flight.search", context(), request());
    expect(output).toMatchObject({ outcome: "LIVE", offers: [expect.objectContaining({ providerOfferId: "offer-1", currency: "USD" })] });
    expect(JSON.stringify(output)).not.toContain("secret");
    expect(await db.select().from(providerSearchRuns).where(eq(providerSearchRuns.snapshotId, snapshotId))).toHaveLength(1);
  });

  /**
   * Every sibling search service reserves its `provider_search_runs` row
   * before calling a supplier, so a repeat inside one run is refused for free.
   * Flight inserted after the answer came back: a repeat paid for a second
   * search and then died on the unique index as a raw Postgres error, which
   * classified as UNCLASSIFIED and reached the model as UPSTREAM_FAILURE — a
   * cell that had just come back LIVE now looked broken, so it retried.
   */
  it("refuses an exact repeat before touching the supplier", async () => {
    // The guard is scoped to a planning run — without one there is no "once
    // per run" to enforce, and the partial unique index does not apply.
    const agentTaskRunId = randomUUID();
    await db.insert(agentTaskRuns).values({
      id: agentTaskRunId, operation: "PLAN", status: "RUNNING", createdByUserId: userId, tripId,
      snapshotId, flightSearchPreferencesVersion: preferenceVersion,
      requestId: randomUUID(), expiresAt: new Date(Date.now() + 60_000),
    });
    const first = await invokeSkill("flight.search", context("shared", { agentTaskRunId }), request());
    expect(first).toMatchObject({ outcome: "LIVE" });

    await expect(invokeSkill("flight.search", context("shared", { agentTaskRunId }), request()))
      .rejects.toMatchObject({ code: "POLICY_DENIED" });

    // One reservation, one search: the repeat neither wrote a row nor called out.
    expect(await db.select().from(providerSearchRuns)
      .where(eq(providerSearchRuns.snapshotId, snapshotId))).toHaveLength(1);

    await db.delete(providerOffers).where(eq(providerOffers.snapshotId, snapshotId));
    await db.delete(providerSearchRuns).where(eq(providerSearchRuns.snapshotId, snapshotId));
    await db.delete(agentTaskRuns).where(eq(agentTaskRuns.id, agentTaskRunId));
  });

  it.each(["personal", "review"] as const)("denies %s Agent contexts", async (agent) => {
    await expect(invokeSkill("flight.search", context(agent), request())).rejects.toMatchObject({ code: "TOOL_NOT_ALLOWED" });
  });

  it("denies a context whose policy gate does not grant flight:search", async () => {
    const denied = context();
    denied.policyGate = { requireScope: () => { throw new Error("flight:search is not granted"); } };
    await expect(invokeSkill("flight.search", denied, request())).rejects.toMatchObject({ code: "TOOL_NOT_ALLOWED" });
  });

  it("denies missing server execution context and unknown tools", async () => {
    const missing = context();
    delete (missing as { flightSearch?: unknown }).flightSearch;
    await expect(invokeSkill("flight.search", missing, request())).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(invokeSkill("flight.unknown", context(), request())).rejects.toMatchObject({ code: "UNKNOWN_SKILL" });
  });

  it.each([
    ["originId", "NOT_AIRPORT"], ["destinationId", "SIN"], ["departureDate", "2026-10-02"],
    ["adults", 1], ["cabin", "BUSINESS"], ["currency", "EUR"],
  ])("denies a server-constraint mismatch for %s", async (key, value) => {
    await expect(invokeSkill("flight.search", context(), request({ [key]: value }))).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  it("rejects malformed arguments and unauthorized snapshots", async () => {
    await expect(invokeSkill("flight.search", context(), { snapshotId, originId: "SFO" })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(invokeSkill("flight.search", context(), request({ snapshotId: randomUUID() }))).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  it("rejects stale and altered confirmed preference execution contexts", async () => {
    await expect(invokeSkill("flight.search", context("shared", { searchPreferencesVersion: preferenceVersion + 1 }), request())).rejects.toMatchObject({ code: "SEARCH_PREFERENCES_STALE" });
    await expect(invokeSkill("flight.search", context("shared", {
      searchPreferences: { tripType: "ROUND_TRIP", adults: 2, cabin: "BUSINESS", currency: "USD" },
    }), request())).rejects.toMatchObject({ code: "SEARCH_PREFERENCES_STALE" });
  });

  it("maps provider unavailability without exposing internal provider data", async () => {
    __resetRegistryForTests();
    registerSkill(createFlightSearchSkill({ async searchFlights() {
      return { outcome: "UNAVAILABLE", reason: "UPSTREAM_FAILURE" as const };
    } }));
    const output = await invokeSkill("flight.search", context(), request());
    expect(output).toEqual({ outcome: "UNAVAILABLE", code: "UPSTREAM_FAILURE" });
    expect(JSON.stringify(output)).not.toContain("provider");
  });
});
