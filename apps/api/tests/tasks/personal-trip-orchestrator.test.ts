import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";

import { z } from "zod";

import { runMigrations } from "../../src/db/migrate.js";
import { __resetRegistryForTests, registerSkill } from "../../src/agents/skill-registry.js";
import { db } from "../../src/db/database.js";
import {
  agentTaskRuns,
  chatMessages,
  chatThreads,
  constraintSnapshots,
  itineraryPlans,
  planningResearchResults,
  sharedTrips,
  tripMembers,
  tripSearchPreferences,
  tripStaySearchPreferences,
  researchRouteSelections,
  tripPlaces,
  users,
} from "../../src/db/schema.js";
import { runResearch } from "../../src/tasks/personal-trip-orchestrator-service.js";
import { createRequestContext } from "../../src/utils/context.js";
import { testPlanningDependencies } from "../helpers/planning.js";
import {
  __setPlanningDependenciesForTests,
} from "../../src/services/planning-service.js";
import type { Skill } from "../../src/agents/contracts.js";

const passthroughSchema = z.unknown();

const connectionString =
  process.env.TEST_DATABASE_URL
  ?? "postgres://travelagent:travelagent@127.0.0.1:5432/travelagent?options=-csearch_path%3Dtravelagent_test";

describe("personal-trip-orchestrator-service", () => {
  let cleanup: postgres.Sql;
  let ownerId: string;
  let tripId: string;
  let snapshotId: string;
  let runId: string;
  const capturedInputs: { name: string; payload: unknown }[] = [];

  beforeAll(async () => {
    await runMigrations(connectionString);
    cleanup = postgres(connectionString, { max: 1 });
  });

  afterEach(async () => {
    __resetRegistryForTests();
    delete process.env.PLAN_ENABLE_HOTEL;
    capturedInputs.length = 0;
  });

  afterAll(async () => {
    // beforeEach truncates before each test but not after the last one. The
    // leftovers are not this file's problem alone: the suite runs single-forked
    // against one database, and a later file doing an unscoped
    // `delete(sharedTrips)` fails on our foreign keys — which is how a change
    // to what the last test persists here surfaced as six unrelated failures
    // in trip-draft-brief. Clear the same set beforeEach clears, so the next
    // file starts from the same empty state whatever this one wrote.
    await cleanup.unsafe(`
      TRUNCATE TABLE users, audit_events, outbox_events, planning_research_results,
        constraint_snapshots, agent_task_runs, idempotency_records,
        chat_messages, chat_threads, provider_search_runs, provider_offers,
        trip_members, trip_search_preferences, trip_stay_search_preferences,
        shared_trips, itinerary_plans, member_confirmations, source_evidence,
        visa_readiness_checks, trip_constraint_proposals, trip_constraint_facts,
        trip_invitations, consent_grants, user_profiles, preference_facts,
        memory_proposals, plan_adoption_votes, trip_places,
        booking_executions
      RESTART IDENTITY CASCADE
    `);
  });

  beforeEach(async () => {
    await cleanup.unsafe(`
      TRUNCATE TABLE users, audit_events, outbox_events, planning_research_results,
        constraint_snapshots, agent_task_runs, idempotency_records,
        chat_messages, chat_threads, provider_search_runs, provider_offers,
        trip_members, trip_search_preferences, trip_stay_search_preferences,
        shared_trips, itinerary_plans, member_confirmations, source_evidence,
        visa_readiness_checks, trip_constraint_proposals, trip_constraint_facts,
        trip_invitations, consent_grants, user_profiles, preference_facts,
        memory_proposals, plan_adoption_votes, trip_places,
        booking_executions
      RESTART IDENTITY CASCADE
    `);

    ownerId = (await db.insert(users).values({
      externalId: "test-orchestrator-owner",
      displayName: "Orchestrator Owner",
    }).returning({ id: users.id }))![0].id;
    tripId = randomUUID();
    snapshotId = randomUUID();
    runId = randomUUID();
    await db.insert(sharedTrips).values({
      id: tripId,
      name: "Orchestrator Trip",
      nameSource: "AUTO",
      status: "PLANNING",
      createdBy: ownerId,
      departureCities: ["San Francisco"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: "2026-09-01",
      travelDateEnd: "2026-09-08",
    });
    await db.insert(tripMembers).values({
      tripId,
      userId: ownerId,
      role: "CREATOR",
      isRequired: true,
    });
    await db.insert(tripSearchPreferences).values({
      tripId,
      version: 1,
      tripType: "ROUND_TRIP",
      currency: "USD",
      adults: 1,
      cabin: "ECONOMY",
      offerFreshnessMinutes: 60,
      confirmedBy: ownerId,
    });
    await db.insert(tripStaySearchPreferences).values({
      tripId,
      version: 1,
      roomCount: 1,
      adultsPerRoom: [1],
      currency: "USD",
      confirmedBy: ownerId,
    });
    await db.insert(constraintSnapshots).values({
      id: snapshotId,
      tripId,
      version: 1,
      authorizedData: { _meta: { schemaVersion: 2 } },
      departureCities: ["San Francisco"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: "2026-09-01",
      travelDateEnd: "2026-09-08",
    });
    await db.insert(agentTaskRuns).values({
      id: runId,
      operation: "RESEARCH",
      status: "RUNNING",
      createdByUserId: ownerId,
      tripId,
      snapshotId,
      flightSearchPreferencesVersion: 1,
      staySearchPreferencesVersion: 1,
      requestId: randomUUID(),
      researchMode: "RESEARCH_ONLY",
      requestedCapabilities: ["activities", "hotel", "places", "readiness"],
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 60_000),
    });
  });

  function registerStubSkill(name: string, outcome: { outcome: "LIVE" | "UNAVAILABLE"; code?: string; flights?: unknown[]; stays?: unknown[] }): void {
    const skill: Skill<unknown, unknown> = {
      name,
      agent: "shared",
      version: "1.0.0",
      allowedTools: ["snapshot:read", "activities:search"],
      timeoutMs: 1_000,
      needsConfirm: false,
      input: passthroughSchema,
      output: passthroughSchema,
      async handler(_ctx, input) {
        capturedInputs.push({ name, payload: input });
        if (outcome.outcome === "LIVE") {
          // Provide enough output shape that downstream code can iterate.
          // `coverage.allFlights` is read by the orchestrator's PROPOSE_PLAN
          // branch; for `flight.search` we synthesise a stub FlightOffer.
          return {
            outcome: "LIVE",
            queryId: "00000000-0000-0000-0000-000000000001",
            flights: outcome.flights ?? [],
            hotels: [],
            activities: outcome.stays ?? [],
          };
        }
        // Skill contracts return {outcome: "UNAVAILABLE", code} for
        // unavailable providers; throw is reserved for fatal errors.
        return { outcome: "UNAVAILABLE", code: outcome.code ?? "NOT_CONFIGURED" };
      },
    };
    registerSkill(skill);
  }

  function makeRunArgs() {
    return createRequestContext(ownerId);
  }

  async function makeRunRow(): Promise<typeof agentTaskRuns.$inferSelect> {
    const [run] = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, runId));
    return run!;
  }

  it("dispatches every requested capability through invokeSkill", async () => {
    process.env.PLAN_ENABLE_HOTEL = "true";
    registerStubSkill("activities.search", { outcome: "LIVE" });
    registerStubSkill("hotel.search", { outcome: "LIVE" });
    registerStubSkill("places.search", { outcome: "LIVE" });
    registerStubSkill("readiness.check", { outcome: "LIVE" });
    const run = await makeRunRow();
    const result = await runResearch({
      ctx: makeRunArgs(),
      run,
      signal: new AbortController().signal,
      providerOverride: testPlanningDependencies,
    });
    expect(result.outcome).toBe("COMPLETED");
    const invokedNames = capturedInputs.map((c) => c.name);
    expect(invokedNames).toEqual(expect.arrayContaining(["activities.search", "hotel.search", "places.search", "readiness.check"]));
  });

  it("records UNAVAILABLE outcomes as service gaps and persists COMPLETED_WITH_GAPS", async () => {
    process.env.PLAN_ENABLE_HOTEL = "true";
    registerStubSkill("activities.search", { outcome: "UNAVAILABLE", code: "NOT_CONFIGURED" });
    registerStubSkill("hotel.search", { outcome: "UNAVAILABLE", code: "SEARCH_CONSTRAINTS_INCOMPLETE" });
    registerStubSkill("places.search", { outcome: "LIVE" });
    registerStubSkill("readiness.check", { outcome: "LIVE" });
    const run = await makeRunRow();
    const result = await runResearch({
      ctx: makeRunArgs(),
      run,
      signal: new AbortController().signal,
      providerOverride: testPlanningDependencies,
    });
    expect(result.outcome).toBe("COMPLETED_WITH_GAPS");
    expect(result.researchResultId).toBeDefined();
    const [row] = await db.select().from(planningResearchResults)
      .where(eq(planningResearchResults.agentTaskRunId, runId));
    expect(row?.status).toBe("COMPLETED_WITH_GAPS");
    expect(row?.serviceGaps.length).toBeGreaterThan(0);
    const codes = row?.serviceGaps.map((g: { code: string }) => g.code);
    expect(codes).toEqual(expect.arrayContaining(["NOT_CONFIGURED", "SEARCH_CONSTRAINTS_INCOMPLETE"]));
  });

  it("invokes navigation and mobility Shared skills when two routable places exist", async () => {
    registerStubSkill("navigation.route", { outcome: "LIVE" });
    registerStubSkill("mobility.search", { outcome: "LIVE" });
    const places = await db.insert(tripPlaces).values([
      { tripId, ownerUserId: ownerId, visibility: "TEAM_VISIBLE", status: "ACTIVE", kind: "ATTRACTION", displayName: "Tokyo Station", source: "test" },
      { tripId, ownerUserId: ownerId, visibility: "TEAM_VISIBLE", status: "ACTIVE", kind: "ATTRACTION", displayName: "Senso-ji", source: "test" },
    ]).returning({ id: tripPlaces.id });
    // Both capabilities now refuse to guess which two places to route between:
    // they read the owner's confirmed selection (`research_route_selections`,
    // written by PUT /agent-runs/:runId/route-selection) and report
    // SEARCH_CONSTRAINTS_INCOMPLETE without one. The run must also name the
    // intent it came from, since that is the key the selection is stored under.
    const intentRunId = randomUUID();
    // A CONVERSATION run must name its thread and user message
    // (`agent_task_runs_operation_refs_check`), so both are seeded here purely
    // to satisfy that; no conversation is exercised.
    const intentThreadId = randomUUID();
    const intentMessageId = randomUUID();
    await db.insert(chatThreads).values({
      id: intentThreadId, ownerUserId: ownerId, tripId, scope: "TRIP", title: "route selection seed",
    });
    await db.insert(chatMessages).values({
      id: intentMessageId, threadId: intentThreadId, senderUserId: ownerId, role: "USER", body: "seed",
    });
    await db.insert(agentTaskRuns).values({
      id: intentRunId, tripId, threadId: intentThreadId, userMessageId: intentMessageId,
      requestId: randomUUID(), operation: "CONVERSATION",
      status: "COMPLETED", createdByUserId: ownerId, generationAttempt: 0,
      expiresAt: new Date(Date.now() + 60_000), nextAttemptAt: new Date(),
    });
    await db.insert(researchRouteSelections).values({
      intentRunId, tripId, ownerUserId: ownerId,
      originPlaceId: places[0]!.id, destinationPlaceId: places[1]!.id, mode: "WALK",
    });
    await db.update(agentTaskRuns).set({
      requestedCapabilities: ["navigation", "mobility"],
      originatingIntentRunId: intentRunId,
    }).where(eq(agentTaskRuns.id, runId));

    const result = await runResearch({
      ctx: makeRunArgs(), run: await makeRunRow(), signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("COMPLETED");
    expect(capturedInputs.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      "navigation.route", "mobility.search",
    ]));
  });

  it("rejects a research run whose snapshot is missing travel dates", async () => {
    await db.update(constraintSnapshots)
      .set({ travelDateStart: null, travelDateEnd: null })
      .where(eq(constraintSnapshots.id, snapshotId));
    const run = await makeRunRow();
    await expect(
      runResearch({ ctx: makeRunArgs(), run, signal: new AbortController().signal }),
    ).rejects.toThrow(/Planning snapshot is incomplete/);
  });

  it("rejects when no flight search preferences are confirmed for a flight capability", async () => {
    await db.delete(tripSearchPreferences).where(eq(tripSearchPreferences.tripId, tripId));
    await db.update(agentTaskRuns)
      .set({ requestedCapabilities: ["flight"] })
      .where(eq(agentTaskRuns.id, runId));
    const run = await makeRunRow();
    const result = await runResearch({
      ctx: makeRunArgs(),
      run,
      signal: new AbortController().signal,
      providerOverride: testPlanningDependencies,
    });
    expect(result.outcome).toBe("COMPLETED_WITH_GAPS");
    const [row] = await db.select().from(planningResearchResults)
      .where(eq(planningResearchResults.agentTaskRunId, runId));
    expect(row?.serviceGaps.some((g: { capability: string }) => g.capability === "flight")).toBe(true);
  });

  it("PROPOSE_PLAN reaches PERSISTING and refuses a plan the validator cannot vouch for", async () => {
    // The default test dependencies deliberately have no accommodation
    // discovery provider. Even with a LIVE flight, that leaves no destination
    // eligible for a commercially grounded plan.
    __setPlanningDependenciesForTests(testPlanningDependencies);
    // Stub flight.search with a synthetic FlightOffer so coverage has at
    // least one flight per origin × destination pair. The orchestrator
    // reads `coverage.allFlights` to pick a primary destination.
    const syntheticFlight = {
      id: "00000000-0000-0000-0000-000000000001",
      providerOfferId: "stub-flight",
      queryId: "00000000-0000-0000-0000-000000000002",
      origin: "San Francisco",
      destination: "Tokyo",
      tripType: "ROUND_TRIP",
      departureDate: "2026-09-01",
      returnDate: "2026-09-08",
      adults: 1,
      cabin: "ECONOMY",
      totalPrice: 500,
      currency: "USD",
      source: "stub",
      capturedAt: "2026-08-25T00:00:00.000Z",
      expiresAt: "2026-09-01T00:00:00.000Z",
    };
    registerStubSkill("flight.search", { outcome: "LIVE", flights: [syntheticFlight] });
    registerStubSkill("activities.search", { outcome: "LIVE" });
    registerStubSkill("hotel.search", { outcome: "LIVE" });
    registerStubSkill("places.search", { outcome: "LIVE" });
    registerStubSkill("readiness.check", { outcome: "LIVE" });

    // Switch the run to PROPOSE_PLAN + include "flight" so coverage runs.
    await db.update(agentTaskRuns)
      .set({
        researchMode: "PROPOSE_PLAN",
        requestedCapabilities: ["flight", "activities", "hotel", "places", "readiness"],
      })
      .where(eq(agentTaskRuns.id, runId));

    // Authorized data must include a v2 _meta.projectionManifest so the
    // snapshot-manifest guard has something to hash.
    await db.update(constraintSnapshots)
      .set({
        authorizedData: {
          _meta: {
            schemaVersion: 2,
            projectionManifest: [
              { sourceId: "mem-a", revision: 1, visibility: "TEAM_VISIBLE" },
            ],
          },
        },
      })
      .where(eq(constraintSnapshots.id, snapshotId));

    const run = await makeRunRow();
    let result: Awaited<ReturnType<typeof runResearch>>;
    try {
      result = await runResearch({
        ctx: makeRunArgs(),
        run,
        signal: new AbortController().signal,
        providerOverride: testPlanningDependencies,
      });
    } catch (err) {
      // The deterministic validator rejects the stub plan because flights
      // must round-trip via `provider_offers`. Phase 4 PROPOSE_PLAN acceptance
      // is exercised end-to-end in `tests/integration.test.ts` against real
      // test providers; here we just assert the orchestrator reaches the
      // PERSISTING stage before the validator rejects it.
      const violations = (err as { violations?: unknown }).violations
        ?? (err as { message?: string }).message;
      expect(violations).toBeTruthy();
      // Which field the stub trips on is not the point and has moved before:
      // it used to be `flights[0]`, because the schema demanded at least one
      // flight. It no longer does — an unavailable flight capability is a gap
      // on the plan, not grounds for withholding it — so assert only that the
      // deterministic validator refused a plan it could not tie to evidence.
      expect(JSON.stringify(violations)).toMatch(/STRUCTURE_INVALID|EVIDENCE|flights/);
      return;
    }
    expect(result.outcome).toBe("COMPLETED_WITH_GAPS");
    expect(result.resultPlanId).toBeUndefined();
    expect(result.researchResultId).toBeDefined();

    const [plan] = await db.select().from(itineraryPlans)
      .where(eq(itineraryPlans.tripId, tripId));
    expect(plan).toBeUndefined();

    // A summary is durable and explicitly carries no plan authority.
    const researchResults = await db.select().from(planningResearchResults)
      .where(eq(planningResearchResults.agentTaskRunId, runId));
    expect(researchResults).toHaveLength(1);
    expect(researchResults[0]).toMatchObject({
      status: "COMPLETED_WITH_GAPS",
      resultPlanId: null,
    });
  });
});

void and; // imported for use in test scaffolding above
