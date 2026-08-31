import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";

import { runMigrations } from "../../src/db/migrate.js";
import { __resetRegistryForTests, registerSkill } from "../../src/agents/skill-registry.js";
import { db } from "../../src/db/database.js";
import {
  agentTaskRuns,
  constraintSnapshots,
  planningResearchResults,
  sharedTrips,
  tripMembers,
  tripSearchPreferences,
  tripStaySearchPreferences,
  users,
} from "../../src/db/schema.js";
import { runResearch } from "../../src/tasks/personal-trip-orchestrator-service.js";
import { createRequestContext } from "../../src/utils/context.js";
import type { Skill } from "../../src/agents/contracts.js";
import { z } from "zod";

const passthroughSchema = z.unknown();

const connectionString =
  process.env.TEST_DATABASE_URL
  ?? "postgres://travelagent:travelagent@127.0.0.1:5432/travelagent?options=-csearch_path%3Dtravelagent_test";

describe("Phase 5 — Hotel capability", () => {
  let cleanup: postgres.Sql;
  let ownerId: string;
  let tripId: string;
  let snapshotId: string;
  let runId: string;

  beforeAll(async () => {
    await runMigrations(connectionString);
    cleanup = postgres(connectionString, { max: 1 });
  });

  afterEach(async () => {
    __resetRegistryForTests();
  });

  afterAll(async () => {
    // beforeEach truncates before each test but not after the last one; a
    // RESEARCH row left behind here breaks migrate.test.ts's from-scratch
    // migration replay (0012's pre-RESEARCH constraint) if it runs later in
    // the same single-forked vitest process.
    await cleanup.unsafe(`DELETE FROM agent_task_runs`);
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
      externalId: "phase5-hotel-owner",
      displayName: "Hotel Owner",
    }).returning({ id: users.id }))![0].id;
    tripId = randomUUID();
    snapshotId = randomUUID();
    runId = randomUUID();
    await db.insert(sharedTrips).values({
      id: tripId,
      name: "Hotel Trip",
      nameSource: "AUTO",
      status: "PLANNING",
      createdBy: ownerId,
      departureCities: ["SF"],
      destinationCandidates: ["Tokyo"],
      titleLocale: "zh",
    });
    await db.insert(tripMembers).values({
      tripId, userId: ownerId, role: "CREATOR", isRequired: true,
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
      departureCities: ["SF"],
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
      requestedCapabilities: ["hotel"],
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 60_000),
    });
  });

  function registerStubSkill(name: string, outcome: { outcome: "LIVE" | "UNAVAILABLE"; code?: string }): void {
    const skill: Skill<unknown, unknown> = {
      name,
      agent: "shared",
      version: "1.0.0",
      allowedTools: ["snapshot:read", "hotel:search"],
      timeoutMs: 1_000,
      needsConfirm: false,
      input: passthroughSchema,
      output: passthroughSchema,
      async handler() {
        if (outcome.outcome === "LIVE") {
          return { outcome: "LIVE", queryId: randomUUID(), hotels: [] };
        }
        return { outcome: "UNAVAILABLE", code: outcome.code ?? "NOT_CONFIGURED" };
      },
    };
    registerSkill(skill);
  }

  it("skips hotel capability with PROVIDER_NOT_APPROVED when PLAN_ENABLE_HOTEL is not 'true'", async () => {
    delete process.env.PLAN_ENABLE_HOTEL;
    const run = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, runId)).then(([r]) => r!);
    const result = await runResearch({
      ctx: createRequestContext(ownerId),
      run,
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("COMPLETED_WITH_GAPS");
    const [row] = await db.select().from(planningResearchResults)
      .where(eq(planningResearchResults.agentTaskRunId, runId));
    const gaps = row?.serviceGaps as Array<{ capability: string; code: string }>;
    expect(gaps.some((g) => g.capability === "hotel" && g.code === "PROVIDER_NOT_APPROVED")).toBe(true);
  });

  it("invokes hotel.search with locale=zh when the trip titleLocale is zh", async () => {
    process.env.PLAN_ENABLE_HOTEL = "true";
    const hotelInvocations: { locale: string | undefined }[] = [];
    const skill: Skill<unknown, unknown> = {
      name: "hotel.search",
      agent: "shared",
      version: "1.0.0",
      allowedTools: ["snapshot:read", "hotel:search"],
      timeoutMs: 1_000,
      needsConfirm: false,
      input: passthroughSchema,
      output: passthroughSchema,
      async handler(ctx) {
        hotelInvocations.push({ locale: (ctx as { hotelSearch?: { locale?: string } }).hotelSearch?.locale });
        return { outcome: "LIVE", queryId: randomUUID(), hotels: [] };
      },
    };
    registerSkill(skill);

    const run = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, runId)).then(([r]) => r!);
    await runResearch({
      ctx: createRequestContext(ownerId),
      run,
      signal: new AbortController().signal,
    });

    expect(hotelInvocations).toHaveLength(1);
    expect(hotelInvocations[0].locale).toBe("zh");
    delete process.env.PLAN_ENABLE_HOTEL;
  });

  it("invokes hotel.search with locale=en for non-zh trips", async () => {
    process.env.PLAN_ENABLE_HOTEL = "true";
    await db.update(sharedTrips)
      .set({ titleLocale: "en" })
      .where(eq(sharedTrips.id, tripId));

    const hotelInvocations: { locale: string | undefined }[] = [];
    const skill: Skill<unknown, unknown> = {
      name: "hotel.search",
      agent: "shared",
      version: "1.0.0",
      allowedTools: ["snapshot:read", "hotel:search"],
      timeoutMs: 1_000,
      needsConfirm: false,
      input: passthroughSchema,
      output: passthroughSchema,
      async handler(ctx) {
        hotelInvocations.push({ locale: (ctx as { hotelSearch?: { locale?: string } }).hotelSearch?.locale });
        return { outcome: "LIVE", queryId: randomUUID(), hotels: [] };
      },
    };
    registerSkill(skill);

    const run = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, runId)).then(([r]) => r!);
    await runResearch({
      ctx: createRequestContext(ownerId),
      run,
      signal: new AbortController().signal,
    });

    expect(hotelInvocations).toHaveLength(1);
    expect(hotelInvocations[0].locale).toBe("en");
    delete process.env.PLAN_ENABLE_HOTEL;
  });

  it("records a UNAVAILABLE hotel gap when the provider returns NOT_CONFIGURED", async () => {
    process.env.PLAN_ENABLE_HOTEL = "true";
    registerStubSkill("hotel.search", { outcome: "UNAVAILABLE", code: "NOT_CONFIGURED" });

    const run = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, runId)).then(([r]) => r!);
    const result = await runResearch({
      ctx: createRequestContext(ownerId),
      run,
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("COMPLETED_WITH_GAPS");

    const [row] = await db.select().from(planningResearchResults)
      .where(eq(planningResearchResults.agentTaskRunId, runId));
    const gaps = row?.serviceGaps as Array<{ capability: string; code: string; destinationId?: string }>;
    expect(gaps.some((g) => g.capability === "hotel" && g.code === "NOT_CONFIGURED" && g.destinationId === "Tokyo")).toBe(true);
    delete process.env.PLAN_ENABLE_HOTEL;
  });
});
