import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";

import { db } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import { itineraryPlans, sharedTrips, tripMembers, users } from "../src/db/schema.js";
import { PlanValidationError } from "../src/policy/plan-output-validator.js";
import { ModelGatewayError } from "../src/providers/llm-gateway.js";
import {
  bindDailyItineraryModelCompletion,
  buildDailyItineraryModelContext,
  classifyDailyItineraryFailure,
  createConstraintSnapshot,
  generatePlan,
  type PlanningDependencies,
} from "../src/services/planning-service.js";
import { createRequestContext } from "../src/utils/context.js";
import { testPlanningDependencies } from "./helpers/planning.js";

const connectionString = process.env.TEST_DATABASE_URL
  ?? "postgres://travelagent:travelagent@127.0.0.1:5432/travelagent?options=-csearch_path%3Dtravelagent_test";

describe("generatePlan — daily itinerary gateway binding", () => {
  let cleanup: postgres.Sql;
  let userId: string;
  let tripId: string;

  beforeAll(async () => {
    await runMigrations(connectionString);
    cleanup = postgres(connectionString, { max: 1 });
  });

  afterAll(async () => {
    await cleanup.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await cleanup.unsafe(`
      TRUNCATE TABLE
        audit_events, provider_offers, source_evidence, constraint_snapshots,
        itinerary_plans, trip_members, shared_trips
      RESTART IDENTITY CASCADE
    `);
    await cleanup`DELETE FROM users`;

    const [user] = await db.insert(users).values({
      externalId: `daily-owner-${randomUUID()}`,
      displayName: "Daily itinerary owner",
    }).returning();
    userId = user.id;
    const [trip] = await db.insert(sharedTrips).values({
      name: "Daily itinerary trip",
      createdBy: userId,
      departureCities: ["San Francisco"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: "2026-10-01",
      travelDateEnd: "2026-10-05",
    }).returning();
    tripId = trip.id;
    await db.insert(tripMembers).values({ tripId, userId, role: "CREATOR", isRequired: true });
  });

  it("repairs a missing date, keeps the receiver bound, and persists every trip date", async () => {
    const baseGateway = testPlanningDependencies.modelGateway;
    const dailyCalls = vi.fn();
    const gateway = {
      ...baseGateway,
      marker: "bound",
      async generateDailyItinerary(this: { marker: string }, params: {
        plan: Record<string, unknown>;
        travelDateStart: string;
        travelDateEnd: string;
        requiredDates?: readonly string[];
        repair?: { attempt: number; issues: readonly { code: string; fieldPaths: readonly string[] }[] };
      }) {
        expect(this.marker).toBe("bound");
        dailyCalls(params);
        expect(JSON.stringify(params.plan)).not.toContain("totalPrice");
        const allDays = params.plan.days as Array<{ dayKey: string }>;
        const days = params.repair
          ? allDays
          : [allDays[0]!, allDays[allDays.length - 1]!];
        return { days: days.map((day) => ({
          dayKey: day.dayKey,
          items: [{
            kind: "FREE_TIME",
            startTimeLocal: "09:00",
            endTimeLocal: "10:00",
            title: "Explore nearby",
            evidenceKey: null,
          }],
        })) };
      },
    };
    const dependencies: PlanningDependencies = {
      ...testPlanningDependencies,
      modelGateway: gateway,
    };
    const snapshotId = await createConstraintSnapshot({
      tripId,
      memberIds: [userId],
      departureCities: ["San Francisco"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: "2026-10-01",
      travelDateEnd: "2026-10-05",
    });

    const outcome = await generatePlan({
      ctx: createRequestContext(userId),
      tripId,
      snapshotId,
      destination: "Tokyo",
      memberIds: [userId],
    }, dependencies);

    expect(outcome.outcome).toBe("PLAN");
    if (outcome.outcome !== "PLAN") throw new Error("expected a plan");
    const [plan] = await db.select({ planData: itineraryPlans.planData })
      .from(itineraryPlans)
      .where(eq(itineraryPlans.id, outcome.planId));
    const dailyOutcome = plan.planData.dailyItineraryOutcome as { status: string; days: Array<{ date: string }>; attempts: number };
    expect(dailyOutcome.days.map((day) => day.date))
      .toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]);
    expect(dailyOutcome).toMatchObject({ status: "READY", attempts: 2 });
    expect(dailyCalls).toHaveBeenCalledTimes(2);
    expect(dailyCalls.mock.calls[1]?.[0].repair).toEqual({
      attempt: 2,
      issues: [{ code: "DATE_COVERAGE_INVALID", fieldPaths: ["dailyItinerary"] }],
    });
  });

  it("binds day and evidence aliases to server-owned plan facts", () => {
    const plan = {
      flights: [{ id: "provider-flight-id" }],
      activities: [{ id: "provider-activity-id" }],
    } as unknown as Parameters<typeof bindDailyItineraryModelCompletion>[0]["plan"];

    const result = bindDailyItineraryModelCompletion({
      completion: { days: [{
        dayKey: "day_1",
        items: [{
          kind: "BOOKED_ACTIVITY",
          startTimeLocal: "18:00",
          endTimeLocal: "21:00",
          title: "Night food tour",
          evidenceKey: "activity_1",
        }],
      }] },
      plan,
      requiredDates: ["2026-10-01"],
    });

    expect(result).toEqual([{
      date: "2026-10-01",
      timeZone: "destination_local",
      items: [{
        kind: "BOOKED_ACTIVITY",
        startTimeLocal: "18:00",
        endTimeLocal: "21:00",
        title: "Night food tour",
        verification: "PROVIDER_BACKED",
        evidenceRef: { category: "activities", id: "provider-activity-id" },
      }],
    }]);
  });

  it("builds five server-owned day keys without exposing provider ids to model output", () => {
    const plan = {
      destination: "Shanghai",
      flights: [{
        id: "serpapi:opaque-flight-id",
        origin: "SIN",
        destination: "PVG",
        segments: [],
      }],
      activities: [{
        id: "opaque-activity-id",
        title: "Night food tour",
        destination: "Shanghai",
        durationMinutes: { fixed: 180, from: null, to: null },
      }],
      hotels: [{
        id: "opaque-hotel-id",
        propertyName: "Example Hotel",
        checkIn: "2026-10-01",
        checkOut: "2026-10-05",
      }],
    } as unknown as Parameters<typeof buildDailyItineraryModelContext>[0];
    const dates = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"];

    const context = buildDailyItineraryModelContext(plan, dates);

    expect(context).toMatchObject({
      days: dates.map((date, index) => ({ dayKey: `day_${index + 1}`, date })),
      flights: [{ evidenceKey: "flight_1" }],
      activities: [{ evidenceKey: "activity_1" }],
    });
    expect(JSON.stringify(context)).not.toContain("opaque-flight-id");
    expect(JSON.stringify(context)).not.toContain("opaque-activity-id");
    expect(JSON.stringify(context)).not.toContain("opaque-hotel-id");
  });

  it("rejects unknown and cross-category evidence aliases", () => {
    const plan = {
      flights: [{ id: "provider-flight-id" }],
      activities: [{ id: "provider-activity-id" }],
    } as unknown as Parameters<typeof bindDailyItineraryModelCompletion>[0]["plan"];

    expect(() => bindDailyItineraryModelCompletion({
      completion: { days: [{
        dayKey: "day_1",
        items: [{
          kind: "FLIGHT",
          startTimeLocal: "08:00",
          endTimeLocal: "12:00",
          title: "Arrival flight",
          evidenceKey: "activity_1",
        }],
      }] },
      plan,
      requiredDates: ["2026-10-01"],
    })).toThrowError(PlanValidationError);
  });

  it("classifies schema, provider and local invocation failures separately", () => {
    expect(classifyDailyItineraryFailure(new ModelGatewayError("SCHEMA_PARSE"))).toBe("schema_invalid");
    expect(classifyDailyItineraryFailure(new PlanValidationError([{
      code: "DAILY_ITINERARY_TIME_ORDER", fieldPath: "dailyItinerary.0.items.1", reason: "overlap",
    }]))).toBe("time_order_invalid");
    expect(classifyDailyItineraryFailure(new ModelGatewayError("UPSTREAM_TIMEOUT"))).toBe("model_temporarily_unavailable");
    expect(classifyDailyItineraryFailure(new ModelGatewayError("UPSTREAM_FAILURE", "planning", { httpStatus: 400 })))
      .toBe("model_contract_rejected");
    expect(classifyDailyItineraryFailure(new TypeError("lost receiver"))).toBe("internal_error");
  });

  it("keeps the shared plan and marks the schedule unavailable after repair exhaustion", async () => {
    const generateDailyItinerary = vi.fn(async () => ({ days: [{
      dayKey: "day_1",
      items: [],
    }] }));
    const snapshotId = await createConstraintSnapshot({
      tripId,
      memberIds: [userId],
      departureCities: ["San Francisco"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: "2026-10-01",
      travelDateEnd: "2026-10-03",
    });

    const outcome = await generatePlan({
      ctx: createRequestContext(userId),
      tripId,
      snapshotId,
      destination: "Tokyo",
      memberIds: [userId],
    }, {
      ...testPlanningDependencies,
      modelGateway: { ...testPlanningDependencies.modelGateway, generateDailyItinerary },
    });

    expect(outcome.outcome).toBe("PLAN");
    if (outcome.outcome !== "PLAN") throw new Error("expected a plan");
    const [plan] = await db.select({ planData: itineraryPlans.planData })
      .from(itineraryPlans)
      .where(eq(itineraryPlans.id, outcome.planId));
    expect(plan.planData.dailyItineraryOutcome).toMatchObject({
      status: "UNAVAILABLE",
      reason: "CONTENT_REPAIR_EXHAUSTED",
      retryable: false,
      attempts: 3,
    });
    expect(generateDailyItinerary).toHaveBeenCalledTimes(3);
  });

  it("does not content-retry a provider failure", async () => {
    const generateDailyItinerary = vi.fn(async () => {
      throw new ModelGatewayError("RATE_LIMITED");
    });
    const snapshotId = await createConstraintSnapshot({
      tripId,
      memberIds: [userId],
      departureCities: ["San Francisco"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: "2026-10-01",
      travelDateEnd: "2026-10-03",
    });

    const outcome = await generatePlan({
      ctx: createRequestContext(userId), tripId, snapshotId, destination: "Tokyo", memberIds: [userId],
    }, {
      ...testPlanningDependencies,
      modelGateway: { ...testPlanningDependencies.modelGateway, generateDailyItinerary },
    });

    expect(outcome.outcome).toBe("PLAN");
    expect(generateDailyItinerary).toHaveBeenCalledTimes(1);
    if (outcome.outcome !== "PLAN") throw new Error("expected a plan");
    const [plan] = await db.select({ planData: itineraryPlans.planData })
      .from(itineraryPlans)
      .where(eq(itineraryPlans.id, outcome.planId));
    expect(plan.planData.dailyItineraryOutcome).toMatchObject({
      status: "UNAVAILABLE",
      reason: "MODEL_TEMPORARILY_UNAVAILABLE",
      retryable: true,
      attempts: 1,
    });
  });

  it("persists a non-retryable capability reason when the gateway has no daily composer", async () => {
    const snapshotId = await createConstraintSnapshot({
      tripId,
      memberIds: [userId],
      departureCities: ["San Francisco"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: "2026-10-01",
      travelDateEnd: "2026-10-03",
    });
    const gateway = { ...testPlanningDependencies.modelGateway };
    delete gateway.generateDailyItinerary;

    const outcome = await generatePlan({
      ctx: createRequestContext(userId), tripId, snapshotId, destination: "Tokyo", memberIds: [userId],
    }, { ...testPlanningDependencies, modelGateway: gateway });

    expect(outcome.outcome).toBe("PLAN");
    if (outcome.outcome !== "PLAN") throw new Error("expected a plan");
    const [plan] = await db.select({ planData: itineraryPlans.planData })
      .from(itineraryPlans)
      .where(eq(itineraryPlans.id, outcome.planId));
    expect(plan.planData.dailyItineraryOutcome).toMatchObject({
      status: "UNAVAILABLE",
      reason: "CAPABILITY_NOT_CONFIGURED",
      retryable: false,
      attempts: 0,
    });
  });
});
